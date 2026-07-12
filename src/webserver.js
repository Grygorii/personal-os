import http from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

// A tiny static server for the Telegram Mini App (Phase A): serves the home hub and the
// two tool pages. The bot stays a long-poll worker; this just adds a web face so the
// apps open from Telegram's menu button. State is still client-side in this phase.

const ROUTES = {
  '/': { file: '../webapp/home.html' },
  '/app': { file: '../webapp/home.html' },
  '/home': { file: '../webapp/home.html' },
  '/deck': { file: '../english/study.html', homeBar: true },
  '/body': { file: '../body/map.html', homeBar: true },
  '/reading': { file: '../reading/journal.html', homeBar: true },
};

// The deck and body pages are HTML fragments (authored for the Artifact host, which adds
// <head>). When we serve them ourselves we wrap them in a real document so mobile viewport,
// charset, and (for sub-pages) a "‹ Home" link all work.
function wrap(fragment, homeBar) {
  if (/<!doctype/i.test(fragment)) return fragment; // already a full document (home.html)
  const bar = homeBar
    ? '<div style="font-family:system-ui,-apple-system,sans-serif;padding:10px 16px;' +
      'border-bottom:1px solid rgba(128,128,128,.22);position:sticky;top:0;background:Canvas;z-index:50">' +
      '<a href="/" style="color:#0E7C86;text-decoration:none;font-weight:600;font-size:15px">&lsaquo; Home</a></div>'
    : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>*{box-sizing:border-box}html,body{margin:0}</style></head><body>' +
    bar + fragment +
    '<script>try{var t=window.Telegram&&window.Telegram.WebApp;if(t){t.ready();t.expand();}}catch(e){}</script>' +
    '</body></html>'
  );
}

export function startServer(port = process.env.PORT || 8080) {
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    try {
      const abs = fileURLToPath(new URL(route.file, import.meta.url));
      const fragment = await readFile(abs, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(wrap(fragment, route.homeBar));
    } catch (err) {
      console.error('[web] failed to serve', path, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  server.on('error', (err) => console.error('[web] server error:', err.message));
  server.listen(port, () => console.log(`[web] Mini App serving on :${port}`));
  return server;
}
