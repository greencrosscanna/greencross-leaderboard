#!/usr/bin/env python3
"""GX dev server — serves this repo's working tree with caching disabled.

  SOURCE OF TRUTH: greencross-gx-theme/serve.py. Synced into every spoke by gx-sync.sh.
  Edit it HERE, then ./gx-sync.sh in the spokes.

  Usage:   python3 serve.py            # 127.0.0.1 only (default — nobody else can reach it)
           python3 serve.py --lan      # bind 0.0.0.0, e.g. to open the page on a kiosk/phone

The file on disk IS the app (no build step), so an edit + reload is the whole loop. Cache-Control
is no-store so a hard reload is never required.

The page talks to the LIVE backend. gx-dev.js paints a banner saying so and blocks writes until
you arm them — see that file. Ports are fixed per app so muscle memory works across repos.
"""
import http.server, socketserver, sys, os

PORTS = {
    'performance': 8181,   # Leaderboard
    'sales':       3000,
    'inventory':   3001,
    'pricetags':   8753,   # Price Cards
    'spiff':       8754,
    'crew':        8755,
    'core-admin':  8791,   # Command Center (mocks only until the Pages migration)
}
APP  = 'performance'
PORT = PORTS.get(APP, 8181)
BIND = '0.0.0.0' if '--lan' in sys.argv else '127.0.0.1'

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # silence per-request logs

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer((BIND, PORT), NoCacheHandler) as httpd:
    where = 'ALL INTERFACES (LAN)' if BIND == '0.0.0.0' else 'localhost only'
    print('GX dev server — app=%s  http://localhost:%d  (%s)' % (APP, PORT, where))
    print('Serving the working tree. Backend is LIVE. Writes are blocked until armed.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
