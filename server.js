'use strict';

// Local development server for Village Matcher.
//
// Serves the static frontend and handles all API calls (Google Sheets,
// geocoding, travel times) using the same backend logic as the Netlify
// function. Credentials and settings come from a .env file in this directory.
//
// Usage:
//   node server.js
// Then open http://localhost:3000 in your browser.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Load .env (does not override variables already set in the environment)
// ---------------------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, ''); // strip surrounding quotes
    if (!(key in process.env)) process.env[key] = val;
  });
}

// ---------------------------------------------------------------------------
// Import the shared backend handler
// ---------------------------------------------------------------------------
const { handler } = require('./netlify/functions/api');

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.csv':  'text/csv',
};

// ---------------------------------------------------------------------------
// Static assets: compressed once, then held in memory
// ---------------------------------------------------------------------------
// The frontend ships as plain source with no build step, so compression
// happens here instead of in a bundler. Measured on the four browser scripts:
// 99,351 bytes as written, 32,003 gzipped, 16,465 with comments stripped then
// brotli. Cached against mtime, so editing a file is still picked up.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.csv']);
const assetCache = new Map();

// Whole lines only, never mid-line, so a `//` in a string or regex is safe
// without a tokenizer.
//
// Blank lines are kept on purpose: inside app.js's HTML templates a blank line
// is content, so dropping it would change the markup while still parsing, and
// no parse check would catch that. It saved 94 bytes after brotli.
function stripComments(source) {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    })
    .join('\n');
}

function leanJs(filePath, source) {
  const lean = stripComments(source);
  try {
    new (require('vm').Script)(lean, { filename: filePath });
    return lean;
  } catch (err) {
    console.warn(`[server] serving ${path.basename(filePath)} with comments: stripping them broke parsing (${err.message})`);
    return source;
  }
}

function buildAsset(filePath, ext) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  const cached = assetCache.get(key);
  if (cached) return cached;

  let raw = fs.readFileSync(filePath);
  if (ext === '.js') raw = Buffer.from(leanJs(filePath, raw.toString('utf8')), 'utf8');

  const asset = { raw };
  if (COMPRESSIBLE.has(ext)) {
    asset.gzip = zlib.gzipSync(raw, { level: 9 });
    asset.br = zlib.brotliCompressSync(raw);
  }
  assetCache.set(key, asset);
  return asset;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  // Route all API calls to the Netlify function handler
  if (req.url.startsWith('/.netlify/functions/api')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const event = {
        httpMethod: req.method,
        path:       req.url,
        headers:    req.headers,
        body,
      };
      try {
        const result  = await handler(event);
        const headers = { 'Content-Type': 'application/json', ...(result.headers || {}) };
        res.writeHead(result.statusCode, headers);
        res.end(result.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Serve static files
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(__dirname, urlPath));

  if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const asset = buildAsset(filePath, ext);
    const accepted = String(req.headers['accept-encoding'] || '');

    let body = asset.raw;
    let encoding = null;
    if (asset.br && /\bbr\b/.test(accepted))          { body = asset.br;   encoding = 'br'; }
    else if (asset.gzip && /\bgzip\b/.test(accepted)) { body = asset.gzip; encoding = 'gzip'; }

    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (encoding) {
      headers['Content-Encoding'] = encoding;
      headers['Vary'] = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// So the tests can import stripComments without binding a port.
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  Village Matcher is running!');
    console.log(`  Open this in your browser → http://localhost:${PORT}`);
    console.log('');
    console.log('  Press Ctrl+C to stop the server.');
    console.log('');
  });
}

module.exports = { stripComments };
