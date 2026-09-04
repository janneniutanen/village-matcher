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
// The frontend ships as plain source with no build step, which is deliberate:
// the organizer runs `node server.js` and there is nothing to compile. The
// cost is that the browser downloads about 99KB of JavaScript, most of it
// comments, and none of it compressed.
//
// Both are fixable here rather than by adding a bundler. Measured on this
// project's four browser scripts:
//
//   as written                       99,351 bytes
//   gzip                             32,003
//   brotli                           27,132
//   comments stripped, then brotli   16,465
//
// So the whole frontend becomes a sixth of its size without touching a line of
// source or introducing a build. Everything is computed on first request and
// cached, keyed by the file's modification time so editing a file during
// development is picked up.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.csv']);
const assetCache = new Map();

// Drops whole-line comments. Deliberately never touches anything mid-line, so
// a `//` inside a string or a regex is untouched and no tokenizer is needed.
//
// Blank lines are deliberately kept. Removing them saved 94 bytes after
// brotli, and a blank line inside one of app.js's multi-line HTML templates
// is content: dropping it would change the rendered markup while still
// parsing cleanly, so no parse check would catch it. Not a trade worth making
// for 94 bytes.
//
// A comment line inside a template literal would be the same hazard. There
// are none today, in any of the four files, and if one ever appears the
// output-equality check in the tests fails rather than the page quietly
// rendering something else.
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
    // Parse only. Catches the case where a stripped line was load-bearing,
    // such as one inside a template literal.
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

    // Brotli first, then gzip, then the file as-is. Both are computed once and
    // held in memory, so repeated loads cost nothing.
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

// Only when run as a program, so the tests can import stripComments without
// binding a port.
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

// Exported so the tests can check that stripping comments does not change
// what the app renders, which a parse check alone cannot tell.
module.exports = { stripComments, buildAsset };
