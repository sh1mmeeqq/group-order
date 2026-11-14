'use strict';
// HTTP + WebSocket сервер. Запуск: npm start  (PORT, DB_FILE, TRUST_PROXY=1 за прокси)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./lib/db');
const { Service, AppError } = require('./lib/service');
const { Hub } = require('./lib/hub');
const { attach } = require('./lib/ws');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const HTTP_STATUS = { bad_request: 400, not_found: 404, rate_limited: 429 };

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'group-order.db'), trustProxy = process.env.TRUST_PROXY === '1' } = {}) {
  const clock = { offset: 0, now() { return Date.now() + this.offset; } }; // offset нужен тестам таймера
  const db = openDb(dbFile);
  const svc = new Service(db, clock);
  const hub = new Hub(svc);
  const createLog = new Map(); // ip -> метки времени создания сессий

  const clientIp = (req) => {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(data);
  }

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new AppError('bad_request')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new AppError('bad_request')); }
      });
      req.on('error', reject);
    });
  }

  function serveFile(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'POST' && p === '/api/sessions') {
      const ip = clientIp(req);
      const now = Date.now();
      const recent = (createLog.get(ip) || []).filter((t) => now - t < 3600e3);
      if (recent.length >= 20) return json(res, 429, { error: 'rate_limited' });
      const body = await readJson(req);
      const result = svc.createSession(body);
      recent.push(now);
      createLog.set(ip, recent);
      return json(res, 201, result);
    }
    if (req.method === 'GET' && p === '/api/restaurants') return json(res, 200, svc.restaurants());
    const m = /^\/api\/restaurants\/(\d+)\/menu$/.exec(p);
    if (req.method === 'GET' && m) {
      const id = Number(m[1]);
      const rest = svc.restaurants().find((r) => r.id === id);
      if (!rest) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { restaurant: rest, menu: svc.menu(id) });
    }
    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/' || p === '/host' || /^\/host\/[A-Za-z0-9]{6}$/.test(p) || /^\/j\/[A-Za-z0-9]{6}$/.test(p)) {
        return serveFile(res, path.join(PUBLIC, 'app.html'));
      }
      const file = path.normalize(path.join(PUBLIC, p));
      if (file.startsWith(PUBLIC + path.sep) && path.basename(file) !== 'app.html') return serveFile(res, file);
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof AppError) return json(res, HTTP_STATUS[e.code] || 400, { error: e.code, ...e.extra });
      console.error('[http] internal error:', e);
      json(res, 500, { error: 'internal' });
    });
  });

  const wss = attach(server, {
    path: '/ws',
    onConnection: (conn) => hub.onConnection(conn),
    // Защита от cross-site WebSocket hijacking: браузерный Origin должен совпадать с Host.
    verifyOrigin: (req) => {
      const origin = req.headers.origin;
      if (!origin) return true; // не браузерные клиенты
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    },
  });

  const ticker = setInterval(() => {
    try { hub.tick(); } catch (e) { console.error('[tick]', e); }
  }, 1000);
  ticker.unref();

  return {
    server, hub, svc, db, clock,
    close() {
      clearInterval(ticker);
      wss.closeAll();
      server.close();
      db.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.server.listen(port, () => {
    console.log(`Real-Time Group Order: http://localhost:${port}/host`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.close(); process.exit(0); });
}

module.exports = { createApp };
