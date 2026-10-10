// server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// kick.com, any subdomain of it, and any CloudFront host
function isAllowedHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "kick.com" || h.endsWith(".kick.com") || h.endsWith(".cloudfront.net");
}

function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" && isAllowedHost(parsed.hostname);
  } catch {
    return false;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };
}

function sendText(res, status, message) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Rewrite every URI in an HLS playlist so it points back to this server
function rewritePlaylist(text, upstreamUrl, origin) {
  const proxify = (raw) => {
    const abs = new URL(raw, upstreamUrl).toString();
    return origin + "/proxy?url=" + encodeURIComponent(abs);
  };

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`);
      }

      return proxify(trimmed);
    })
    .join("\n");
}

// Fallback: walk any JSON value and collect allowed https URLs that look like playlists
function collectPlaylistUrls(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;

  if (typeof value === "string") {
    if (value.startsWith("https://") && /\.m3u8(\?|$)/i.test(value) && isAllowedUrl(value)) {
      out.push(value);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPlaylistUrls(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) collectPlaylistUrls(value[key], out, depth + 1);
  }

  return out;
}

function kickHeaders() {
  return {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://kick.com",
    "Referer": "https://kick.com/",
    "X-App-Platform": "web",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
}

// The same body the kick.com player sends to /playback
const PLAYBACK_BODY = {
  video_player: {
    player: {
      player_name: "web_mobile",
      player_version: "web_mobile_c1beec96",
      player_software: "IVS Player",
      player_software_version: "1.56.1",
    },
    mux_sdk: { sdk_available: true },
    pal_sdk: { sdk_available: true, nonce: "haha" },
    datazoom_sdk: { sdk_available: true, datazoom_sdk_version: "2.33.0", om_sdk_version: "1.6.6" },
    google_ads_sdk: { sdk_available: false },
  },
  video_session: {
    page_type: "video",
    player_remote_played: false,
    enable_sampling: false,
    autoplay_behaviour: "click",
    play_muted: true,
    viewer_connection_type: "",
  },
  user_session: {
    session_id: "true",
    player_device_id: "true",
  },
};

// /vod?url=<kick VOD page URL or video ID>  ->  { id, recording_url }
async function handleVod(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const raw = requestUrl.searchParams.get("url") || "";
  let id = requestUrl.searchParams.get("id") || "";

  if (!id) {
    const match = raw.match(/\/videos\/([0-9a-f-]{36})/i);
    if (match) id = match[1];
    else if (UUID_RE.test(raw.trim())) id = raw.trim();
  }

  if (!UUID_RE.test(id)) {
    return sendJson(res, 400, { error: "Could not find a valid video ID in the input" });
  }

  let upstream;
  try {
    upstream = await fetch(`https://web.kick.com/api/v1/stream/${id}/playback`, {
      method: "POST",
      headers: kickHeaders(),
      body: JSON.stringify(PLAYBACK_BODY),
      redirect: "follow",
    });
  } catch (err) {
    return sendJson(res, 502, { error: "Could not reach Kick: " + err.message });
  }

  if (!upstream.ok) {
    return sendJson(res, upstream.status, { error: "Kick returned status " + upstream.status });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return sendJson(res, 502, { error: "Kick returned a non-JSON response" });
  }

  const pb = (data && data.playback_url) || {};
  let playable = null;

  if (pb.vod && isAllowedUrl(pb.vod)) {
    playable = pb.vod;
  } else if (pb.live && isAllowedUrl(pb.live)) {
    playable = pb.live;
  } else {
    playable = collectPlaylistUrls(data)[0] || null;
  }

  if (!playable) {
    return sendJson(res, 404, {
      error: "No playable playlist found in Kick response",
      response_keys: Object.keys(data || {}),
      playback_keys: Object.keys(pb),
    });
  }

  return sendJson(res, 200, { id, recording_url: playable });
}

// /proxy?url=<playlist or segment URL>
async function handleProxy(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method not allowed");
  }

  const target = requestUrl.searchParams.get("url");
  if (!target) return sendText(res, 400, "Missing url parameter");

  if (!isAllowedUrl(target)) {
    return sendText(res, 403, "Host not allowed");
  }
  const upstreamUrl = new URL(target);

  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const origin = `${proto}://${req.headers.host}`;

  const upstreamHeaders = new Headers({
    "User-Agent": BROWSER_UA,
    "Accept": "*/*",
    "Origin": "https://kick.com",
    "Referer": "https://kick.com/",
  });
  if (req.headers.range) upstreamHeaders.set("Range", req.headers.range);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return sendText(res, 502, "Could not reach upstream: " + err.message);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return sendText(res, upstream.status, "Upstream error " + upstream.status);
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  const isPlaylist = upstreamUrl.pathname.endsWith(".m3u8") || contentType.includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = rewritePlaylist(text, upstreamUrl, origin);
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
    });
    return res.end(req.method === "HEAD" ? undefined : rewritten);
  }

  const headers = { ...corsHeaders() };
  headers["Content-Type"] = contentType || "video/mp2t";
  headers["Cache-Control"] = "public, max-age=3600";
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  res.writeHead(upstream.status, headers);

  if (req.method === "HEAD" || !upstream.body) {
    return res.end();
  }

  const body = Readable.fromWeb(upstream.body);
  body.on("error", () => res.destroy());
  res.on("close", () => body.destroy());
  body.pipe(res);
}

async function serveIndex(req, res) {
  try {
    const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : html);
  } catch {
    sendText(res, 500, "index.html not found in public/");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://localhost");

    if (requestUrl.pathname === "/vod") return await handleVod(req, res, requestUrl);
    if (requestUrl.pathname === "/proxy") return await handleProxy(req, res, requestUrl);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      return await serveIndex(req, res);
    }

    sendText(res, 404, "Not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, "Internal server error");
    else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`HLS player listening on port ${PORT}`);
});