// server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

// Only these hosts can be proxied, so this server cannot be used as an open proxy
const ALLOWED_HOSTS = ["stream.kick.com"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };
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
        // Tags with URI="..." attributes (keys, init maps, alternate renditions)
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`);
      }

      // Plain lines are playlist or segment URLs
      return proxify(trimmed);
    })
    .join("\n");
}

function sendText(res, status, message) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
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

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return sendText(res, 400, "Invalid url");
  }

  if (upstreamUrl.protocol !== "https:" || !ALLOWED_HOSTS.includes(upstreamUrl.hostname)) {
    return sendText(res, 403, "Host not allowed");
  }

  // Build the origin used to rewrite playlist URLs (works behind a TLS-terminating proxy)
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const origin = `${proto}://${req.headers.host}`;

  const upstreamHeaders = new Headers({
    "User-Agent": "Mozilla/5.0",
    "Accept": "*/*",
  });
  const range = req.headers.range;
  if (range) upstreamHeaders.set("Range", range);

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

  // Playlists are small text: rewrite them fully
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

  // Media segments: stream the body through without buffering it in memory
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
  // If the viewer closes the connection, stop reading from upstream
  res.on("close", () => body.destroy());
  body.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://localhost");

    if (requestUrl.pathname === "/proxy") {
      return await handleProxy(req, res, requestUrl);
    }

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