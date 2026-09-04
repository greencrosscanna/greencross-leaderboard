#!/usr/bin/env node
/* GX dev server — the Node twin of serve.py, for when Python cannot read the repo.
 *
 *   Usage:  node serve.js          # 127.0.0.1 only (default — nobody else can reach it)
 *           node serve.js --lan    # bind 0.0.0.0, e.g. to open the page on a kiosk/phone
 *
 * WHY THIS EXISTS, given serve.py already did the job.
 * Every GX repo lives under ~/Library/CloudStorage/Dropbox, which macOS protects with TCC. The
 * dev-server launcher spawns its process as a child of Claude's `disclaimer` helper, and in that
 * context every APPLE-SIGNED binary is denied the whole protected tree — /bin/ls, /bin/cat and
 * /usr/bin/python3 all get EPERM on the repo, on ~/Documents and on ~/Desktop. Granting Full Disk
 * Access to Claude, to Claude Code and to the disclaimer helper itself changed none of it: a
 * platform binary is attributed to its responsible process, and that attribution is what is
 * failing.
 *
 * Homebrew's node is not a platform binary, carries its own identity, and reads the repo fine from
 * the identical launcher context. Measured 2026-09-02: /bin/ls BLOCKED, python3 BLOCKED, node OK
 * (29 entries, index.html read in full).
 *
 * So this is not a preference for Node. It is the only interpreter on this machine that the
 * managed launcher can actually use, and serve.py stays exactly as it is for every context where
 * Python still works — a terminal, a CI step, anywhere started from a shell.
 *
 * BEHAVIOUR IS SERVE.PY'S, deliberately: same per-app ports, same 127.0.0.1 default, same
 * no-store headers so an edit + reload is the whole loop, same silence per request. If you change
 * one, change the other.
 *
 * THIS COPY LIVES IN gx-theme, WHICH IS NOT AN APP. There is no .gx_app here, so running it in this
 * repo exits 2 with "cannot read .gx_app" — that is the correct answer, not a fault. gx-sync.sh
 * copies it into each spoke, where .gx_app exists and names the port. Written by spiff (dc59865)
 * and adopted here unchanged apart from the log line below, because gx-theme owns the shared dev
 * files and a second copy per spoke is how they drift.
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

/* Ports are fixed per app so muscle memory carries across repos. Mirrors serve.py's PORTS. */
const PORTS = {
  'performance': 8181,   // Leaderboard
  'sales':       3000,
  'inventory':   3001,
  'pricecards':  8753,   // Price Cards — .gx_app and the GX Core grants both say pricecards
  'pricetags':   8753,   // stale alias for the same app; keep until nothing references it
  'spiff':       8754,
  'crew':        8755,
  'core-admin':  8791,
};

const ROOT = __dirname;

/* The app key comes from .gx_app, not a constant, so this file is identical in every spoke and
   can move to gx-theme unchanged. serve.py hardcodes it because gx-sync.sh rewrites performance on
   the way in; reading the file needs no sync step at all. */
let APP;
try {
  APP = fs.readFileSync(path.join(ROOT, '.gx_app'), 'utf8').trim();
} catch (e) {
  console.error('serve.js: cannot read .gx_app in ' + ROOT + ' — ' + e.code);
  process.exit(2);
}

/* Never fall through to a DEFAULT port. The old Python default was 8181 — Leaderboard's port, not
   a free one — so an app key missing from the table silently collided with a real server instead
   of failing. Price Cards hit exactly that. */
if (!(APP in PORTS)) {
  console.error("serve.js: no port for app '" + APP + "'. Add it to PORTS above.");
  process.exit(2);
}
const PORT = PORTS[APP];
const BIND = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

http.createServer(function (req, res) {
  /* Path only — the query string is the cache-buster (?v=1.341) and never part of the filename.
     Parsed by hand rather than through `new URL`, which would need a base host invented purely to
     satisfy it. */
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400); res.end('bad request'); return;               // undecodable %-escape
  }
  if (rel.endsWith('/')) rel += 'index.html';

  /* Contain the path INSIDE the repo. path.join alone does not: a request for
     /../../.ssh/id_rsa resolves out of the tree, and this server is reachable from the LAN with
     --lan. Resolve first, then require the result to still start at ROOT. */
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? 'not found' : String(err.code));
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      /* The file on disk IS the app — no build step — so a stale cache is the whole loop broken.
         Same three headers serve.py sends. */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}).listen(PORT, BIND, function () {
  const where = BIND === '0.0.0.0' ? 'LAN — reachable from other devices' : 'localhost only';
  /* The scheme is back, because the exemption landed. spiff wrote this line without it on
     2026-09-02 and said so in place: gx-preflight hard-fails on `https?://(localhost|127\.0\.0\.1)`
     in any tracked .js and exempted serve.py by name, a list written before this file existed, so
     printing the full URL would have forced --no-verify on every push — switching off the other
     four checks with it. They took the smaller loss and left an instruction. This is that
     instruction being carried out; serve.js now sits beside serve.py in the exclusion, and the
     line matches its Python twin again. */
  console.log('GX dev server — app=%s  http://localhost:%d  (%s)', APP, PORT, where);
  console.log('serving %s', ROOT);
});
