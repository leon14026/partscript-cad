"""Open the built site in a headless browser and exercise every example.

Usage:  npm run build && python3 scripts/smoke.py [--software] [--chrome /path/to/chrome]

--software hides WebGL so the CPU-drawn preview is used.
Needs Python Playwright (pip install playwright) and a Chrome or Chromium binary.
Writes screenshots to .test-output/ and exits 1 on a failed build or a console error.
It also opens the page as a phone (390 x 844 with touch) and checks the narrow layout.
"""
import argparse
import contextlib
import functools
import http.server
import math
import pathlib
import shutil
import struct
import sys
import threading
import zipfile

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

    @contextlib.contextmanager
    def answering(text=None):
        # Answer the dialogs the page opens while the block runs, then stop. (A once-handler stays registered when no dialog
        # appears, and answers a later one for the wrong check.) Yields the messages seen.
        seen = []

        def handler(dialog):
            seen.append(dialog.message)
            dialog.accept(text) if text is not None else dialog.accept()

        page.on('dialog', handler)
        try:
            yield seen
        finally:
            page.remove_listener('dialog', handler)

    def canvas_picture():
        page.wait_for_timeout(300)   # a frame is drawn on the next animation frame
        return page.locator('.canvas-host canvas').screenshot()

    def check_hiding(name):
        # Parts menu: a hidden part leaves the picture, stays hidden through a rebuild, and Show all brings it back.
        whole = canvas_picture()
        page.click('summary[aria-label="Show or hide parts"]')
        boxes = page.locator('.parts-popover input[type=checkbox]')
        if boxes.count() < 2 or not all(box.is_checked() for box in boxes.all()):
            problems.append(f'{name}: the Parts menu should list every part, all shown')
            return
        boxes.nth(1).uncheck()
        page.keyboard.press('Escape')
        if page.locator('.parts-hidden').count() != 1 or '1 hidden' not in page.locator('.parts-hidden').inner_text():
            problems.append(f'{name}: the Parts menu did not say that one part is hidden')
        if canvas_picture() == whole:
            problems.append(f'{name}: hiding a part did not change the picture')
        page.click('.cm-content')
        page.keyboard.press('Control+Enter')
        page.wait_for_timeout(200)
        page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
        if page.locator('.parts-hidden').count() != 1:
            problems.append(f'{name}: a rebuild should keep the part hidden')
        page.click('summary[aria-label="Show or hide parts"]')
        page.click('.parts-popover header button')
        page.keyboard.press('Escape')
        if page.locator('.parts-hidden').count() != 0 or canvas_picture() != whole:
            problems.append(f'{name}: Show all did not bring back the original picture')

    def card_values():
        # The Measure card as {label: value text}. A label that two items share keeps the last one.
        values = {}
        for row in page.locator('.measure-card .reading').all():
            values[row.locator('dt').inner_text()] = row.locator('dd span').inner_text()
        return values

    def measure_button():
        return page.locator('.preview-tools button', has_text='Measure')

    def check_measure_plate(name):
        # Top view, so the plate's pixels follow from the camera's fit: the model's centre is the canvas centre.
        page.click('button[title="Top view"]')
        measure_button().click()
        page.wait_for_timeout(300)
        box = page.locator('.canvas-host canvas').bounding_box()
        width, height = box['width'], box['height']
        radius = math.hypot(80, 40, 6) / 2
        k = height / (2 * radius * 1.19 / min(width / height, 1))
        def at(x, y):
            return box['x'] + width / 2 + (x - 40) * k, box['y'] + height / 2 - (y - 20) * k
        plain = canvas_picture()
        # The rim of the hole at (8, 8) is a circle of diameter 5. (Not at (10.5, 8): the circle starts there, and that is a corner.)
        page.mouse.move(*at(8, 10.5))
        page.wait_for_timeout(400)
        hovered = canvas_picture()
        page.mouse.click(*at(8, 10.5))
        page.wait_for_timeout(1200)
        values = card_values()
        if values.get('Diameter') != '5':
            problems.append(f'{name}: a hole rim should read diameter 5, the card says {values}')
        if canvas_picture() == hovered or hovered == plain:
            problems.append(f'{name}: hovering and picking should change the picture')
        # A second rim, 64 mm along x: the centres are 64 apart.
        page.mouse.click(*at(72, 10.5))
        page.wait_for_timeout(1200)
        values = card_values()
        if values.get('Centre-to-centre distance') != '64':
            problems.append(f'{name}: two hole rims should read 64 centre to centre, the card says {values}')
        page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}measure-edges.png"))
        # Esc clears the picks, a click on the top face reads its area, and a second Esc leaves the tool.
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        if page.locator('.measure-card .reading').count():
            problems.append(f'{name}: Esc should clear the picks')
        page.mouse.click(*at(40, 20))
        page.wait_for_timeout(1200)
        values = card_values()
        if values.get('Area') != '3121.46':
            problems.append(f'{name}: the top face should read 3121.46 mm², the card says {values}')
        page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}measure-face.png"))
        page.keyboard.press('Escape')
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        if measure_button().get_attribute('aria-pressed') != 'false' or page.locator('.measure-card').count():
            problems.append(f'{name}: a second Esc should leave the Measure tool')
        page.click('button[title="Isometric view"]')

    def check_measure_assembly(name):
        # A pick in the middle of the picture, then the joints may not be played while it is shown.
        measure_button().click()
        page.wait_for_timeout(300)
        box = page.locator('.canvas-host canvas').bounding_box()
        # The middle of the picture can be empty space between parts, so try a grid of points until one picks a part.
        for fy in (0.5, 0.6, 0.4, 0.7, 0.3):
            for fx in (0.5, 0.4, 0.6, 0.3, 0.7):
                page.mouse.click(box['x'] + box['width'] * fx, box['y'] + box['height'] * fy)
                page.wait_for_timeout(250)
                if page.locator('.measure-card .measure-item').count():
                    break
            else:
                continue
            break
        page.wait_for_timeout(900)
        if not page.locator('.measure-card .measure-item').count():
            problems.append(f'{name}: a click at the middle of the picture should pick something: {page.inner_text(".measure-card")!r}')
        elif page.locator('.joint-play:not([disabled])').count():
            problems.append(f'{name}: joints should not play while a measurement is shown')
        page.keyboard.press('Escape')
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        # Esc must also leave the tool while a joint slider has the keyboard focus (it used to be ignored there).
        if page.locator('input[type=range]').count():
            measure_button().click()
            page.wait_for_timeout(300)
            page.locator('input[type=range]').first.focus()
            page.keyboard.press('Escape')
            page.wait_for_timeout(300)
            if measure_button().get_attribute('aria-pressed') != 'false':
                problems.append(f'{name}: Esc should leave the Measure tool while a joint slider has focus')

    def block_stl(a=10, b=20, c=30):
        # A closed box as a binary STL, written here so that nothing but the script is needed.
        faces = [
            [(0, 0, 0), (0, 0, c), (0, b, c), (0, b, 0)], [(a, 0, 0), (a, b, 0), (a, b, c), (a, 0, c)],
            [(0, 0, 0), (a, 0, 0), (a, 0, c), (0, 0, c)], [(0, b, 0), (0, b, c), (a, b, c), (a, b, 0)],
            [(0, 0, 0), (0, b, 0), (a, b, 0), (a, 0, 0)], [(0, 0, c), (a, 0, c), (a, b, c), (0, b, c)],
        ]
        data = b'smoke block'.ljust(80, b'\0') + struct.pack('<I', 12)
        for q in faces:
            for tri in ((q[0], q[1], q[2]), (q[0], q[2], q[3])):
                data += struct.pack('<3f', 0, 0, 0) + b''.join(struct.pack('<3f', *v) for v in tri) + b'\0\0'
        return data

    def wait_built():
        page.wait_for_timeout(200)
        page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
        return page.inner_text('.output-message').replace('\n', ' ')

    def check_import(example_index):
        # Export the swivel arm as STEP, open that file and an STL back into the project as imported files, use them as parts,
        # reload the page, and save the project as a zip.
        name = 'import'
        page.click('summary[aria-label="Examples"]')
        with answering():
            page.locator('.examples-popover button').nth(example_index).click()
        wait_built()
        with page.expect_download() as download:
            page.click('.button-step')
        step_path = shots / 'arm_export.step'
        download.value.save_as(str(step_path))
        stl_path = shots / 'block.stl'
        stl_path.write_bytes(block_stl())
        page.set_input_files('input[type=file]', [str(step_path), str(stl_path)])
        page.wait_for_selector('.asset-panel', timeout=10000)
        tabs = page.locator('.file-tab-name').all_inner_texts()
        if 'arm_export.step' not in tabs or 'block.stl' not in tabs:
            problems.append(f'{name}: the imported files should be tabs: {tabs}')
        page.click('.asset-actions button:has-text("Show on its own")')
        notice = wait_built()
        if page.locator('.output-message.error').count() or 'Built one solid' not in notice:
            problems.append(f'{name}: showing the STEP on its own: {notice}')
        facts = page.inner_text('.asset-facts').replace('\n', ' ')
        if 'Bodies 4' not in facts and 'BODIES 4' not in facts.upper():
            problems.append(f'{name}: the panel should say the STEP holds 4 bodies: {facts}')
        page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}import-step.png"))
        # Measure a part of the imported STEP.
        measure_button().click()
        page.wait_for_timeout(300)
        box = page.locator('.canvas-host canvas').bounding_box()
        for fy in (0.5, 0.6, 0.4, 0.7, 0.3):
            for fx in (0.5, 0.4, 0.6, 0.3, 0.7):
                page.mouse.click(box['x'] + box['width'] * fx, box['y'] + box['height'] * fy)
                page.wait_for_timeout(250)
                if page.locator('.measure-card .measure-item').count():
                    break
            else:
                continue
            break
        page.wait_for_timeout(900)
        if not page.locator('.measure-card .measure-item').count():
            problems.append(f'{name}: a click on the imported STEP should pick something')
        page.keyboard.press('Escape')
        page.keyboard.press('Escape')

        # Both files as parts of the assembly, joined by a hinge. The second run reuses both solids.
        page.locator('.file-tab-name', has_text='swivel_arm.scad').click()
        page.click('.cm-content')
        page.keyboard.press('Control+A')
        page.keyboard.type('part("motor", "arm_export.step"); part("block", "block.stl"); joint("j", type = "hinge", parent = "motor", child = "block", at = [0, 0, 0], axis = [0, 0, 1], limits = [0, 90]);', delay=3)
        page.keyboard.press('Control+Enter')
        notice = wait_built()
        if 'Built 2 parts and 1 joint' not in notice or 'block.stl uses an imported STL mesh' not in notice or page.locator('.output-message.error').count():
            problems.append(f'{name}: imported parts in an assembly: {notice}')
        page.keyboard.press('Control+Enter')
        notice = wait_built()
        if '0 solids rebuilt' not in notice:
            problems.append(f'{name}: the second run should reuse both imported solids: {notice}')
        page.wait_for_timeout(300)
        page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}import-assembly.png"))
        print(f'import: {notice}')

        # Autosave keeps the imported files across a reload.
        page.wait_for_selector('.autosave-status:has-text("Draft saved")', timeout=10000)
        page.reload()
        notice = wait_built()
        tabs = page.locator('.file-tab-name').all_inner_texts()
        if 'arm_export.step' not in tabs or 'block.stl' not in tabs or 'Built 2 parts' not in notice:
            problems.append(f'{name}: after a reload the imported files should still be in the project and build: {tabs} {notice}')

        # Save project: a zip that holds the files byte for byte.
        with page.expect_download() as download:
            page.click('button[aria-label="Save project"]')
        zip_path = shots / 'project.zip'
        download.value.save_as(str(zip_path))
        with zipfile.ZipFile(zip_path) as archive:
            inside = archive.namelist()
            same = archive.read('block.stl') == stl_path.read_bytes() and archive.read('arm_export.step') == step_path.read_bytes()
        if 'partscript.json' not in inside or not same:
            problems.append(f'{name}: the project zip should hold the imported files unchanged: {inside}')

    def check_round_notes():
        # A cylinder with $fn is a polygon in STEP. 16 sides or more is an error that names the line, fewer is a log line.
        name = 'round notes'
        def build(source):
            page.click('.cm-content')
            page.keyboard.press('Control+A')
            page.keyboard.type(source, delay=3)
            page.keyboard.press('Control+Enter')
            return wait_built()
        notice = build('$fn = 48; difference() { cube([30, 30, 5]); translate([10, 10, -1]) cylinder(h = 7, d = 4); }')
        if not page.locator('.output-message.error').count() or '48-sided polygon in STEP' not in notice or 'set on line 1' not in notice or 'Delete $fn' not in notice:
            problems.append(f'{name}: a 48-sided hole should be an error that names line 1 and says to delete $fn: {notice!r}')
        if 'Built one solid' not in notice:
            problems.append(f'{name}: the part should still build: {notice!r}')
        notice = build('cylinder(h = 5, d = 12, $fn = 6);')
        logged = page.locator('.echo-message').all_inner_texts()
        if page.locator('.output-message.error').count() or not any('6-sided polygon in STEP' in line for line in logged):
            problems.append(f'{name}: a hexagon should be logged, not an error: {notice!r} {logged}')
        notice = build('cylinder(h = 5, d = 12);')
        if page.locator('.output-message.error').count() or page.locator('.echo-message').count():
            problems.append(f'{name}: a true cylinder should say nothing about $fn: {notice!r}')
        print(f'{name}: ok')

    def check_manual():
        # The header and the Help dialog both link to the manual page, which has its twelve sections and a way back.
        name = 'manual'
        link = page.locator('a[aria-label="Manual"]')
        if link.count() != 1 or link.get_attribute('href') != 'manual.html' or link.get_attribute('target') != '_blank':
            problems.append(f'{name}: the header should have one Manual link to manual.html that opens a new tab')
            return
        page.click('.help-button')
        page.wait_for_selector('dialog.help-dialog[open]')
        if page.locator('dialog.help-dialog a[href="manual.html"]').count() != 1:
            problems.append(f'{name}: the Help dialog should link to the manual')
        page.keyboard.press('Escape')
        manual = context.new_page()
        manual.on('console', lambda m: problems.append(f'console (manual): {m.text[:300]}') if m.type == 'error' else None)
        manual.on('pageerror', lambda e: problems.append(f'page error (manual): {str(e)[:300]}'))
        manual.goto(url.replace('index.html', 'manual.html'))
        headings = manual.locator('main h2').all_inner_texts()
        if len(headings) != 12 or not headings[0].startswith('1. Getting started') or not headings[-1].startswith('12. Cheat sheet'):
            problems.append(f'{name}: the manual page should have twelve numbered sections: {headings}')
        if manual.locator('nav.toc a').count() != 12 or manual.locator('a[href="./"]').count() != 1:
            problems.append(f'{name}: the manual page should have a contents list of twelve links and a link back to the editor')
        if manual.locator('pre').count() < 40:
            problems.append(f'{name}: the manual page should show its code examples, found {manual.locator("pre").count()}')
        manual.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}manual.png"))
        manual.close()
        print(f'{name}: ok')

    def check_bad_files():
        # Open says what is wrong with a file it cannot use. A web page is not a CAD file, and a web page renamed .step is not a STEP.
        name = 'bad files'
        tabs_before = page.locator('.file-tab-name').all_inner_texts()
        page_path = shots / 'notes.html'
        page_path.write_text('<!DOCTYPE html><html><body>Not CAD.</body></html>')
        page.set_input_files('input[type=file]', [str(page_path)])
        page.wait_for_selector('.output-message.error', timeout=10000)
        message = page.inner_text('.output-message.error').replace('\n', ' ')
        if 'notes.html is not a file this page opens' not in message or '.scad' not in message:
            problems.append(f'{name}: an .html file should be refused with a message that names it and what to open: {message!r}')
        if page.locator('.file-tab-name').all_inner_texts() != tabs_before:
            problems.append(f'{name}: a refused file should not become a tab')
        junk_path = shots / 'junk.step'
        junk_path.write_text('<!DOCTYPE html><html><body>Not a STEP file.</body></html>')
        page.set_input_files('input[type=file]', [str(junk_path)])
        page.wait_for_selector('.asset-panel', timeout=10000)
        if not page.locator('.asset-problem').count():
            page.get_by_role('button', name='Show on its own').click()
        page.wait_for_selector('.asset-problem', timeout=20000)
        panel = page.inner_text('.asset-panel')
        if 'is not a STEP file' not in panel:
            problems.append(f'{name}: the panel should say junk.step is not a STEP file: {panel!r}')
        if 'exact geometry' in panel or page.locator('.asset-actions').count():
            problems.append(f'{name}: a file that could not be read should not claim a format or offer Show and Copy: {panel!r}')
        print(f'{name}: ok')

    def check_new_project():
        # New starts a blank one-file project, and the + beside the tabs adds to it.
        name = 'new project'
        page.click('.cm-content')
        page.keyboard.type(' ', delay=3)   # an unsaved change, so New asks before it replaces the project
        with answering() as asked:
            page.click('button[aria-label="New project"]')
        notice = wait_built()
        if not asked:
            problems.append(f'{name}: New should ask before replacing a project with unsaved changes')
        tabs = page.locator('.file-tab-name').all_inner_texts()
        if tabs != ['part.scad'] or page.locator('.output-message.error').count() or 'Built one solid' not in notice:
            problems.append(f'{name}: expected one tab, part.scad, that builds: {tabs} {notice}')
        with answering('arm.scad'):
            page.click('button[aria-label="Add a file"]')
        page.wait_for_timeout(300)
        tabs = page.locator('.file-tab-name').all_inner_texts()
        if tabs != ['part.scad', 'arm.scad']:
            problems.append(f'{name}: the + should add a tab to the new project: {tabs}')
        print(f'new project: {notice}')

    def check_phone():
        # The page as a phone sees it: one pane at a time, nothing wider than the screen, targets a thumb can hit, and a joint
        # slider that a finger can drag. A second context, so the desktop page above is left as it is.
        name = 'phone'
        phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        if args.software:
            phone.add_init_script("const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); };")
        tap = phone.new_page()
        tap.on('console', lambda m: problems.append(f'console ({name}): {m.text[:300]}') if m.type == 'error' else None)
        tap.on('pageerror', lambda e: problems.append(f'page error ({name}): {str(e)[:300]}'))
        tap.goto(url)
        # In the Preview view the build message sits in the hidden source pane, so wait for it to exist, not to be visible.
        tap.wait_for_selector('.output-message.success, .output-message.error', state='attached', timeout=120000)
        tap.wait_for_timeout(500)
        suffix = 'software-' if args.software else ''

        def layout(state):
            # What is wider than the screen, and which buttons, inputs and links are smaller than 44 px. A closed <details>
            # keeps its content out of reach, so its boxes are not targets.
            found = tap.evaluate("""() => {
              const vw = document.documentElement.clientWidth, over = [], small = [];
              const label = (el) => (el.getAttribute('aria-label') || el.title || el.textContent || el.className || el.tagName).toString().trim().slice(0, 24);
              for (const el of document.querySelectorAll('body *')) {
                const r = el.getBoundingClientRect(), style = getComputedStyle(el);
                if (!r.width || style.visibility === 'hidden' || el.closest('.cm-editor, .visually-hidden')) continue;
                if (r.right > vw + 0.5 && style.position !== 'fixed') over.push(label(el));
                if (!el.matches('button, summary, a, input:not([type=file]), select')) continue;
                if (el.closest('details:not([open])') && !el.matches('summary')) continue;
                const target = el.matches('input[type=checkbox]') ? (el.closest('label') || el) : el;
                if (target.closest('p, li') && target.matches('a')) continue;   // a link inside a sentence is not a button
                const box = target.getBoundingClientRect();
                if (box.width < 43.5 || box.height < 43.5) small.push(`${label(target)} ${Math.round(box.width)}x${Math.round(box.height)}`);
              }
              return { wide: document.documentElement.scrollWidth > vw, over: [...new Set(over)].slice(0, 6), small: [...new Set(small)].slice(0, 8) };
            }""")
            if found['wide'] or found['over']:
                problems.append(f'{name} ({state}): the page is wider than a 390 px screen: {found["over"]}')
            if found['small']:
                problems.append(f'{name} ({state}): targets under 44 px: {found["small"]}')

        # Preview first, with the Code pane out of the way.
        if tap.locator('.workspace').get_attribute('data-view') != 'preview' or tap.locator('.source-pane').is_visible() or not tap.locator('.preview-pane').is_visible():
            problems.append(f'{name}: a phone should open on the preview with the code pane hidden')
        layout('preview')

        # The Joints sheet opens, and its slider moves a joint and the picture when a finger drags it.
        if tap.locator('.joints.open').count():
            problems.append(f'{name}: the Joints panel should start closed on a phone')
        tap.locator('.joints-toggle').tap()
        tap.wait_for_selector('.joints.open')
        layout('joints open')
        room = tap.evaluate("() => { const host = document.querySelector('.canvas-host').getBoundingClientRect(), sheet = document.querySelector('.joints').getBoundingClientRect(); return { below: host.bottom - sheet.top, height: host.height }; }")
        if room['below'] > 0.5 or room['height'] < 200:
            problems.append(f'{name}: the open Joints sheet should leave the model its own 200 px or more above it, not cover it: {room}')
        slider = tap.locator('.joints input[type=range]:not([disabled])').first
        before_value, before_picture = tap.locator('.joint-value input').first.input_value(), tap.locator('.canvas-host canvas').screenshot()
        box = slider.bounding_box()
        client = phone.new_cdp_session(tap)
        def finger(kind, x):
            client.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': box['y'] + box['height'] / 2, 'id': 0}]})
        low, high = float(slider.get_attribute('min')), float(slider.get_attribute('max'))
        thumb = box['x'] + 12 + (box['width'] - 24) * (float(slider.input_value()) - low) / (high - low)
        goal = box['x'] + box['width'] * (0.85 if thumb < box['x'] + box['width'] / 2 else 0.15)
        finger('touchStart', thumb)
        for step in range(1, 9):
            finger('touchMove', thumb + (goal - thumb) * step / 8)
            tap.wait_for_timeout(30)
        finger('touchEnd', goal)
        tap.wait_for_timeout(500)
        after_value, after_picture = tap.locator('.joint-value input').first.input_value(), tap.locator('.canvas-host canvas').screenshot()
        if before_value == after_value or before_picture == after_picture:
            problems.append(f'{name}: dragging the first joint slider with a finger should change its value and the picture: {before_value} -> {after_value}')
        # Play moves the same joint by itself, and a second tap stops it.
        resting = tap.locator('.joint-value input').first.input_value()
        tap.locator('.joint-play:not([disabled])').first.tap()
        tap.wait_for_timeout(900)
        playing = tap.locator('.joint-value input').first.input_value()
        tap.locator('.joint-play:not([disabled])').first.tap()
        if resting == playing:
            problems.append(f'{name}: tapping Play should move the first joint: {resting} -> {playing}')
        tap.screenshot(path=str(shots / f'smoke-{suffix}phone-joints.png'))
        tap.locator('.joints-toggle').tap()

        # The menu behind the three dots holds the file actions, and it closes after one is chosen.
        tap.locator('.more-button').tap()
        if not tap.locator('.file-actions.open').count() or tap.locator('.file-actions button').count() < 4:
            problems.append(f'{name}: the three-dots menu should open with the file actions')
        layout('more menu')
        tap.keyboard.press('Escape')
        if tap.locator('.file-actions.open').count():
            problems.append(f'{name}: Esc should close the three-dots menu')

        # Code and Preview switch panes.
        tap.locator('.view-switch button', has_text='Code').tap()
        tap.wait_for_timeout(300)
        if tap.locator('.workspace').get_attribute('data-view') != 'code' or tap.locator('.preview-pane').is_visible() or not tap.locator('.cm-content').is_visible():
            problems.append(f'{name}: the Code button should show the code and hide the preview')
        layout('code')
        tap.screenshot(path=str(shots / f'smoke-{suffix}phone-code.png'))
        tap.locator('summary[aria-label="Examples"]').tap()
        layout('examples open')
        tap.locator('.examples-popover button').nth(names.index('Mounting plate')).tap()
        tap.wait_for_timeout(200)
        tap.wait_for_selector('.output-message.success, .output-message.error', state='attached', timeout=120000)
        if tap.locator('.workspace').get_attribute('data-view') != 'preview':
            problems.append(f'{name}: choosing an example should switch to the preview')

        # Measure by tapping: a hole's rim reads its diameter, and a pinch does not add a pick.
        tap.locator('button[title="Top view"]').tap()
        tap.locator('.preview-tools button', has_text='Measure').tap()
        tap.wait_for_timeout(300)
        layout('measure on')
        canvas = tap.locator('.canvas-host canvas').bounding_box()
        k = canvas['height'] / (2 * (math.hypot(80, 40, 6) / 2) * 1.19 / min(canvas['width'] / canvas['height'], 1))
        tap.touchscreen.tap(canvas['x'] + canvas['width'] / 2 + (8 - 40) * k, canvas['y'] + canvas['height'] / 2 - (10.5 - 20) * k)
        tap.wait_for_timeout(1200)
        values = {row.locator('dt').inner_text(): row.locator('dd span').inner_text() for row in tap.locator('.measure-card .reading').all()}
        if values.get('Diameter') != '5':
            problems.append(f'{name}: a tap on the rim of a hole in the plate should read Diameter 5: {values}')
        picks = tap.locator('.measure-item').count()
        cx, cy = canvas['x'] + canvas['width'] / 2, canvas['y'] + canvas['height'] / 2 + 120
        client.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': cx - 30, 'y': cy, 'id': 0}, {'x': cx + 30, 'y': cy, 'id': 1}]})
        for step in range(1, 7):
            client.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': cx - 30 - step * 10, 'y': cy, 'id': 0}, {'x': cx + 30 + step * 10, 'y': cy, 'id': 1}]})
            tap.wait_for_timeout(30)
        client.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        tap.wait_for_timeout(500)
        if tap.locator('.measure-item').count() != picks:
            problems.append(f'{name}: a two-finger pinch should zoom, not pick: {picks} -> {tap.locator(".measure-item").count()}')
        tap.screenshot(path=str(shots / f'smoke-{suffix}phone-measure.png'))
        tap.locator('.preview-tools button', has_text='Measure').tap()

        # A download from GrabCAD: an upper-case .STEP with a name in another script. iOS greys out a file whose type is not in the
        # accept list, so a touch screen must have no list, and a mouse still has one. Then the page must take the file.
        if tap.evaluate("() => document.querySelector('input[type=file]').hasAttribute('accept')"):
            problems.append(f'{name}: the file picker must show every file on a touch screen, or iOS greys out a .STEP')
        if not page.evaluate("() => document.querySelector('input[type=file]').hasAttribute('accept')"):
            problems.append(f'{name}: the file picker should still filter by type with a mouse')
        with tap.expect_download() as download:
            tap.locator('button[aria-label="Export STEP"]').tap()
        tap.set_input_files('input[type=file]', files=[{'name': '\u0645\u0648\u0679\u0631 Kingroo-.STEP', 'mimeType': '', 'buffer': pathlib.Path(download.value.path()).read_bytes()}])
        tap.wait_for_selector('.asset-panel', state='attached', timeout=10000)
        imported = [tab for tab in tap.locator('.file-tab-name').all_text_contents() if 'Kingroo' in tab]
        if len(imported) != 1 or not imported[0].endswith('.step'):
            problems.append(f'{name}: an upper-case .STEP with a non-Latin name should open as a .step tab: {imported}')

        # The narrowest phones still fit.
        tap.set_viewport_size({'width': 360, 'height': 740})
        tap.wait_for_timeout(300)
        found = tap.evaluate("() => document.documentElement.scrollWidth > document.documentElement.clientWidth")
        if found:
            problems.append(f'{name}: the page is wider than a 360 px screen')
        phone.close()
        print(f'{name}: ok')

    page.click('summary[aria-label="Examples"]')
    names = [item.inner_text() for item in page.locator('.examples-popover button strong').all()]
    page.keyboard.press('Escape')
    for index, name in enumerate(names):
        page.click('summary[aria-label="Examples"]')
        with answering():
            page.locator('.examples-popover button').nth(index).click()
        page.wait_for_timeout(200)   # the build starts at once; a small part can finish within this time
        page.wait_for_selector('.output-message.success, .output-message.error', timeout=120000)
        notice = page.inner_text('.output-message').replace('\n', ' ')
        if page.locator('.output-message.error').count():
            problems.append(f'{name}: {notice}')
        followers = page.locator('.joint-loop', has_text='follows')
        if name == 'Gears and a cam':
            # The opening pose has the crank at 30 degrees: the wheel at -60 and the plunger 3 mm up.
            rows = followers.all_inner_texts()
            if len(rows) != 2 or 'follows crank' not in rows[0] or '60°' not in rows[0] or 'follows wheel' not in rows[1] or '3 mm' not in rows[1]:
                problems.append(f'{name}: expected the wheel to follow the crank at -60° and the plunger to follow the wheel at 3 mm, saw {rows}')
        if name == 'Crank-rocker linkage':
            check_hiding(name)
        if name == 'Mounting plate':
            check_measure_plate(name)
        joints = page.locator('.joint-play:not([disabled])')
        if joints.count():
            before = page.locator('.joint-value input').first.input_value()
            followers_before = followers.all_inner_texts()
            joints.first.click()
            page.wait_for_timeout(900)
            after = page.locator('.joint-value input').first.input_value()
            followers_after = followers.all_inner_texts()
            joints.first.click()
            if before == after:
                problems.append(f'{name}: the first joint did not move when played')
            if followers_before and followers_before == followers_after:
                problems.append(f'{name}: the joints that follow did not change when the first joint was played: {followers_after}')
        if name == 'Swivel arm assembly':
            check_measure_assembly(name)
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
    # A gear is a prism of its tooth outline, so it builds exact and the notice does not mention a faceted part.
    if 'Built one solid' not in notice or 'faceted' in notice or page.locator('.output-message.error').count():
        problems.append(f'BOSL2 gear: {notice}')
    if [status for status, _ in library_fetches] != [200]:
        problems.append(f'BOSL2 should be fetched once with status 200: {library_fetches}')
    page.wait_for_timeout(300)
    page.screenshot(path=str(shots / f"smoke-{'software-' if args.software else ''}bosl2.png"))
    print(f'BOSL2 gear: {notice} (fetches: {len(library_fetches)})')
    check_import(names.index('Swivel arm assembly'))
    check_new_project()
    check_round_notes()
    check_manual()
    check_bad_files()
    check_phone()
    browser.close()

server.shutdown()
for problem in problems:
    print('PROBLEM', problem)
sys.exit(1 if problems else 0)
