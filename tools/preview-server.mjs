#!/usr/bin/env node
/**
 * MedMesh preview server.
 *
 * Serves the exported Expo web build and transparently proxies the two things a
 * browser cannot reach on its own inside a sandboxed preview:
 *
 *   /api/*   → the Python API on :8000
 *   /ws/*    → the same API, WebSocket upgrade passed through as a raw socket pipe
 *
 * Everything else falls through to the SPA's index.html so client-side routes
 * (/console/12, /analytics/1) deep-link correctly on a hard refresh.
 *
 * Deliberately dependency-free: this must keep working when node_modules has
 * been pruned, because it is the only way to look at the app.
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const API_HOST = process.env.API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.API_PORT || 8000);
const ROOT = path.resolve(process.env.STATIC_ROOT || path.join(__dirname, '..', 'mobile', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* --------------------------------------------------------------- static */

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const candidate = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  const resolved = path.resolve(candidate);

  // Path traversal guard: never serve outside the export directory.
  if (!resolved.startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) return sendFile(resolved, res);
    if (!err && stat.isDirectory()) {
      const index = path.join(resolved, 'index.html');
      if (fs.existsSync(index)) return sendFile(index, res);
    }
    // SPA fallback — Expo Router resolves the route on the client.
    const fallback = path.join(ROOT, 'index.html');
    if (fs.existsSync(fallback)) return sendFile(fallback, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not built yet — run: npx expo export --platform web');
  });
}

function sendFile(file, res) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type };
  // Hashed bundle names can cache hard; HTML must not.
  headers['Cache-Control'] = ext === '.html' ? 'no-store' : 'public, max-age=3600';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ api */

function proxyHttp(req, res) {
  const target = http.request(
    {
      host: API_HOST,
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  target.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        detail: `MedMesh API unreachable on ${API_HOST}:${API_PORT} (${err.code || err.message}). Start the backend, then retry.`,
      }),
    );
  });

  req.pipe(target);
}

/* --------------------------------------------------------------- upgrade */

function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(API_PORT, API_HOST, () => {
    // Replay the original handshake verbatim, then splice the two sockets.
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);

    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
    upstream.on('close', cleanup);
    socket.on('close', cleanup);
  });

  upstream.on('error', () => {
    try {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {}
    socket.destroy();
  });
}

/* ---------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/') || req.url === '/api') return proxyHttp(req, res);
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, static_root: ROOT }));
  }
  return serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws/')) return proxyUpgrade(req, socket, head);
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  const built = fs.existsSync(path.join(ROOT, 'index.html'));
  console.log(`MedMesh preview  → http://${HOST}:${PORT}`);
  console.log(`  static root    : ${ROOT} ${built ? '' : '(NOT BUILT — run: npx expo export --platform web)'}`);
  console.log(`  proxying       : /api/* and /ws/* → http://${API_HOST}:${API_PORT}`);
});
