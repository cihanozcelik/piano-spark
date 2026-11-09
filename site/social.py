"""Make the picture shown when rach3.com is shared: the top of the page itself.

Builds nothing; it opens the already built site (python3 site/build.py) in
headless Chrome at 1200×630, once per language, and saves the screenshots as
assets/social-card.jpg and assets/tr/social-card.jpg. Run it after changing the
top of the page, then build the site again.

    python3 site/social.py        (needs Google Chrome and Pillow)
"""
import functools
import http.server
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
SIZE = (1200, 630)
# Each page opens in its own language: the page's script would otherwise send a
# visitor to the other one.
PAGES = {'': ('en-US', 'America/New_York'), 'tr/': ('tr', 'Europe/Istanbul')}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    site = ROOT/'build/site'
    if not (site/'index.html').is_file():
        raise SystemExit('Build the site first: python3 site/build.py')
    handler = functools.partial(Quiet, directory=site)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        for page, (language, zone) in PAGES.items():
            with tempfile.TemporaryDirectory() as scratch:
                shot = Path(scratch)/'shot.png'
                subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                                f'--user-data-dir={scratch}/profile', f'--lang={language}',
                                '--force-device-scale-factor=2', f'--window-size={SIZE[0]},{SIZE[1]}',
                                '--virtual-time-budget=5000', f'--screenshot={shot}',
                                f'http://127.0.0.1:{server.server_port}/{page}'],
                               check=True, capture_output=True, env={**os.environ, 'TZ': zone})
                target = ROOT/'site/assets'/page/'social-card.jpg'
                Image.open(shot).convert('RGB').resize(SIZE, Image.LANCZOS).save(
                    target, quality=88, optimize=True, progressive=True)
                print(target)
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
