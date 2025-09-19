#!/usr/bin/env node
/*
  Minimal local dev server to preview the TTT Family PWA.
  - Serves frontend/website at "/"
  - Serves frontend/family_mobile at "/family"
  - Exposes /family/config.js (optional runtime backend URL)
  - Serves /sw.js from frontend/website
  Usage:
    node scripts/serve-family.js [--port 8000] [--backend https://localhost:8443]
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let PORT = 8000;
let BACKEND_URL = '';
for (let i=0; i<args.length; i++){
  const a = args[i];
  if (a === '--port' || a === '-p') { PORT = parseInt(args[++i]||'8000',10) || 8000; }
  if (a === '--backend' || a === '-b') { BACKEND_URL = String(args[++i]||''); }
}

const ROOT_SITE = path.resolve(__dirname, '..', 'frontend', 'website');
const ROOT_FAMILY = path.resolve(__dirname, '..', 'frontend', 'family_mobile');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon'
};

function safeJoin(root, reqPath){
  const p = path.normalize(reqPath).replace(/^\/+/, '');
  const out = path.join(root, p);
  if (!out.startsWith(root)) return null; // prevent traversal
  return out;
}

function exists(file){ try { fs.accessSync(file, fs.constants.R_OK); return true; } catch { return false; } }

function send(res, status, body, headers){
  res.statusCode = status;
  if (headers) { for (const [k,v] of Object.entries(headers)) res.setHeader(k, v); }
  res.end(body);
}

function serveStatic(root, urlPath, res){
  let filePath = safeJoin(root, urlPath);
  if (!filePath) return send(res, 403, 'Forbidden');
  // directory -> index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!exists(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    return send(res, 200, data, { 'Content-Type': ct, 'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache, no-store, must-revalidate' : 'no-cache' });
  } catch (e) {
    return send(res, 500, 'Error reading file');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Family runtime config
  if (pathname === '/family/config.js') {
    const js = `window.RUNTIME_CONFIG=Object.assign({},window.RUNTIME_CONFIG||{},{BACKEND_URL:${JSON.stringify(BACKEND_URL)}});\n`;
    return send(res, 200, js, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  }

  // Root service worker
  if (pathname === '/sw.js') {
    const p = path.join(ROOT_SITE, 'sw.js');
    if (exists(p)) return serveStatic(ROOT_SITE, 'sw.js', res);
  }

  // Serve /family/* from family_mobile first
  if (pathname === '/family' || pathname.startsWith('/family/')) {
    const subPath = pathname.replace(/^\/family\/?/, '');
    if (serveStatic(ROOT_FAMILY, subPath, res) !== false) return;
    // Fallback to family index.html for deep paths
    const indexPath = path.join(ROOT_SITE, 'family', 'index.html');
    if (exists(indexPath)) return send(res, 200, fs.readFileSync(indexPath), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    return send(res, 404, 'Not found');
  }

  // Otherwise serve from website root
  if (serveStatic(ROOT_SITE, pathname, res) !== false) return;

  // SPA fallback for website → index.html
  const index = path.join(ROOT_SITE, 'index.html');
  if (exists(index)) return send(res, 200, fs.readFileSync(index), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  return send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`TTT local server running at http://localhost:${PORT}`);
  console.log(`- Website:   http://localhost:${PORT}/`);
  console.log(`- Family app: http://localhost:${PORT}/family/`);
  if (BACKEND_URL) {
    console.log(`Using backend: ${BACKEND_URL}`);
  } else {
    console.log('No backend URL configured. You can pass --backend https://localhost:8443 to connect to a local backend.');
  }
});
