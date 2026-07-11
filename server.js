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
    const data = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Village Matcher is running!');
  console.log(`  Open this in your browser → http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop the server.');
  console.log('');
});
