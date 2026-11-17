# Partscript CAD

Browser CAD: OpenSCAD code in, STEP out, with jointed assemblies. Static site, no backend.

- **The plan for upcoming work is `docs/PLAN.md`.** Read its status notes at the top, then section 0 (rules), section 2 (measured facts) and section 3 (kernel cookbook) before changing engine code. Phases 1 to 5 and the Parts menu are done and live. Phase 6 (import STEP and STL) and phase 7 (measure) are not started; the owner picks the order.
- Check your work before every commit: `npm run check && npm test && npm run build`. Then, if Playwright and Chrome are available, `python3 scripts/smoke.py` and `python3 scripts/smoke.py --software` (they read `dist/`, so build first).
- Pushing to `main` publishes the live site. Ask the owner first.
- The owner's own design files (the label fan folder) are not in this repository. Do not commit them. Keep probe scripts, test designs and STEP exports outside the repository too.
- Engine code is in `src/engine/`. Tests in `test/` run both WASM engines in Node: 93 tests, about a minute.
- An exact build is never trusted alone. A part that uses `linear_extrude`, a `$fn` cylinder or a scaled matrix is compared with OpenSCAD's own fine mesh (`#agrees` in `build.ts`) and falls back to faceted on a mismatch. `unsupported()` in `csg.ts` and the exact builder must always agree about what is covered. A new exact feature needs a test with a volume worked out by hand.
- OpenSCAD runs in a worker with about 1 MB of stack, and every nesting level of a CSG dump uses some of it. `renderMesh` flattens single-child `group()` blocks first (`flattenGroups`, fact F24). Do not feed it a raw BOSL2 dump.
- Error messages are for a mechanical engineer, not a programmer: say what to change, name the file and line.
