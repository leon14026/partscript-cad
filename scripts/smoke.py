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
    # Requests made by the geometry worker show up on the context, not the page.
    library_fetches = []
    context.on('response', lambda r: library_fetches.append((r.status, r.url)) if 'BOSL2.zip' in r.url else None)
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

    # Parts written in place, joined by a hinge, with no part files at all.
    page.click('.cm-content')
    page.keyboard.press('Control+A')
    page.keyboard.type('part("base") cube([30, 30, 4]); part("arm") cube([4, 4, 30]); joint("swing", type = "hinge", parent = "base", child = "arm", at = [15, 15, 4], axis = [0, 1, 0], limits = [0, 90]);', delay=5)
    page.keyboard.press('Control+Enter')
    page.wait_for_timeout(200)
    page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
    notice = page.inner_text('.output-message').replace('\n', ' ')
    if 'Built 2 parts and 1 joint' not in notice or not page.locator('.joint-play:not([disabled])').count():
        problems.append(f'inline parts: {notice}')
    page.wait_for_timeout(300)
    page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}inline.png"))
    print(f'inline parts: {notice}')

    # BOSL2 is fetched only when a project includes it. Nothing above should have asked for it.
    if library_fetches:
        problems.append(f'BOSL2 was fetched before any project included it: {library_fetches}')
    page.click('.cm-content')
    page.keyboard.press('Control+A')
    page.keyboard.type('include <BOSL2/std.scad> include <BOSL2/gears.scad> spur_gear(mod = 2, teeth = 20, thickness = 8);', delay=5)
    page.keyboard.press('Control+Enter')
    page.wait_for_timeout(200)
    page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
    notice = page.inner_text('.output-message').replace('\n', ' ')
    if 'Built one solid' not in notice or 'faceted' not in notice or page.locator('.output-message.error').count():
        problems.append(f'BOSL2 gear: {notice}')
    if [status for status, _ in library_fetches] != [200]:
        problems.append(f'BOSL2 should be fetched once with status 200: {library_fetches}')
    page.wait_for_timeout(300)
    page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}bosl2.png"))
    print(f'BOSL2 gear: {notice} (fetches: {len(library_fetches)})')
    browser.close()

server.shutdown()
for problem in problems:
    print('PROBLEM', problem)
sys.exit(1 if problems else 0)
