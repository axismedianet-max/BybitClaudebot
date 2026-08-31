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

  // Always bind 0.0.0.0. Binding loopback when no token was set made a
  // misconfigured deploy indistinguishable from a crashed one — the platform
  // could not reach it and returned an opaque 502. Withholding the data
  // without a token is the security boundary; refusing the connection is not.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (!TOKEN) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end(
        'Dashboard is running but DASHBOARD_TOKEN is not set.\n\n' +
        'This endpoint exposes balance, positions and PnL, so it will not serve\n' +
        'data without one. Set DASHBOARD_TOKEN in the environment, redeploy,\n' +
        'then open this page as  ?token=YOUR_TOKEN\n'
      );
    }

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

  server.listen(port, '0.0.0.0', () => {
    console.log(`📊 Dashboard listening on 0.0.0.0:${port}`);
    if (!TOKEN) {
      console.log('   ⚠️  DASHBOARD_TOKEN not set — serving a 503 notice, no data.');
    }
  });

  server.on('error', e => console.log('  ⚠️  Dashboard server error:', e.message));
  return server;
}

module.exports = { start };
