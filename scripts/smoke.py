"""Open the built site in a headless browser and exercise every example.

Usage:  npm run build && python3 scripts/smoke.py [--software] [--chrome /path/to/chrome]

--software hides WebGL so the CPU-drawn preview is used.
Needs Python Playwright (pip install playwright) and a Chrome or Chromium binary.
Writes screenshots to .test-output/ and exits 1 on a failed build or a console error.
"""
import argparse
import functools
import http.server
import pathlib
import shutil
import sys
import threading

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
shots = root / '.test-output'
shots.mkdir(exist_ok=True)

parser = argparse.ArgumentParser()
parser.add_argument('--software', action='store_true')
parser.add_argument('--chrome', default=shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser'))
args = parser.parse_args()
if not (root / 'dist' / 'index.html').exists():
    sys.exit('dist/ is missing. Run npm run build first.')

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


handler = functools.partial(Quiet, directory=str(root / 'dist'))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_address[1]}/index.html'

problems = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chrome, args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    context = browser.new_context(viewport={'width': 1366, 'height': 768})
    if args.software:
        context.add_init_script("const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); };")
    page = context.new_page()
    page.on('console', lambda m: problems.append(f'console: {m.text[:300]}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: problems.append(f'page error: {str(e)[:300]}'))
    page.goto(url)
    page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)

    page.click('summary[aria-label="Examples"]')
    names = [item.inner_text() for item in page.locator('.examples-popover button strong').all()]
    page.keyboard.press('Escape')
    for index, name in enumerate(names):
        page.click('summary[aria-label="Examples"]')
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('.examples-popover button').nth(index).click()
        page.wait_for_timeout(200)   # the build starts at once; a small part can finish within this time
        page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
        notice = page.inner_text('.output-message').replace('\n', ' ')
        if page.locator('.output-message.error').count():
            problems.append(f'{name}: {notice}')
        joints = page.locator('.joint-play:not([disabled])')
        if joints.count():
            before = page.locator('.joint-value input').first.input_value()
            joints.first.click()
            page.wait_for_timeout(900)
            after = page.locator('.joint-value input').first.input_value()
            joints.first.click()
            if before == after:
                problems.append(f'{name}: the first joint did not move when played')
        page.wait_for_timeout(300)
        page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}{index + 1}.png"))
        print(f'{name}: {notice}')

    # A part the exact builder cannot make is meshed by OpenSCAD and reported as faceted.
    page.click('.cm-content')
    page.keyboard.press('Control+A')
    page.keyboard.type('hull() { cube(10); translate([0, 0, 14]) sphere(5, $fn = 12); }', delay=5)
    page.keyboard.press('Control+Enter')
    page.wait_for_timeout(200)
    page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
    notice = page.inner_text('.output-message').replace('\n', ' ')
    if 'faceted' not in notice or page.locator('.output-message.error').count():
        problems.append(f'faceted hull: {notice}')
    page.wait_for_timeout(300)
    page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}faceted.png"))
    print(f'faceted hull: {notice}')
    browser.close()

server.shutdown()
for problem in problems:
    print('PROBLEM', problem)
sys.exit(1 if problems else 0)
