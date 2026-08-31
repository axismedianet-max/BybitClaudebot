const http = require('http');
const fs   = require('fs');
const path = require('path');

// Serves the dashboard and the current bot state.
//
// Access control: this endpoint exposes balance, open positions and PnL, so it
// must not be world-readable on a public Railway URL. If DASHBOARD_TOKEN is set
// the server binds publicly and requires ?token= to match. If it is not set the
// server binds to loopback only, so a misconfigured deploy is unreachable rather
// than silently public.
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const HTML  = path.join(__dirname, 'BybitClaudebotDashboard.html');

function authorised(req) {
  if (!TOKEN) return true;                       // loopback-only mode
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') === TOKEN;
}

function start(getState) {
  const port = parseInt(process.env.PORT || '8080');
  const host = TOKEN ? '0.0.0.0' : '127.0.0.1';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (!authorised(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorised — append ?token=YOUR_DASHBOARD_TOKEN to the URL');
    }

    // Health check for Railway
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    // Current state as JSON
    if (url.pathname === '/api/state') {
      let state;
      try {
        state = getState();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ ...state, serverTime: Date.now() }));
    }

    // The dashboard itself
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(HTML, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('Dashboard file not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, host, () => {
    console.log(`📊 Dashboard on http://${host}:${port}`);
    if (!TOKEN) {
      console.log('   ⚠️  DASHBOARD_TOKEN not set — bound to loopback only.');
      console.log('      Set it in Railway to reach the dashboard from a browser.');
    }
  });

  server.on('error', e => console.log('  ⚠️  Dashboard server error:', e.message));
  return server;
}

module.exports = { start };
