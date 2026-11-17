# Partscript CAD

Browser CAD: OpenSCAD code in, STEP out, with jointed assemblies. Static site, no backend.

- **The plan for upcoming work is `docs/PLAN.md`.** Read its section 0 (rules), section 2 (measured facts) and section 3 (kernel cookbook) before changing engine code.
- Check your work before every commit: `npm run check && npm test && npm run build`. Then `python3 scripts/smoke.py` if Playwright and Chrome are available.
- Pushing to `main` publishes the live site. Ask the owner first.
- The owner's own design files (the label fan folder) are not in this repository. Do not commit them.
- Engine code is in `src/engine/`. Tests in `test/` run both WASM engines in Node and take about 10 seconds.
- Error messages are for a mechanical engineer, not a programmer: say what to change, name the file and line.
