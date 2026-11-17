# Partscript CAD: build plan

Written 16 November 2026 for whoever continues this project, human or model. It covers seven phases:

1. Any OpenSCAD geometry builds (faceted fallback)
2. Many parts from one file (inline parts)
3. Driven joints: gear ratios and cam tables
4. The BOSL2 library
5. Exact extrusions (true cylinders and flats in STEP)
6. Import STEP and STL files, such as GrabCAD downloads
7. Measure tool

Phases 1 and 2 come first, in that order. After them, phases 3 to 7 are independent and can be done in any order. Each phase ends in a working, tested, releasable site.

### Status

- **Phase 1: done (17 November 2026).** Differences from the text below, so later phases read true: `BuiltModel.solids` is now `BuiltModel.entries` (each an exact solid or a faceted mesh, see `CachedSolid` in `build.ts`). `unsupported()` returns a descriptive reason, for example `hull`, `scale` or `cylinder with $fn`. `meshToSolid` in `solid.ts` uses `sew` and `makeSolid` per shell, not `sewAndSolidify` (F18). `summary.ts` holds the sentence about faceted parts. The tests are `test/mesh.test.ts` and `test/faceted.test.ts`.
- **Phase 2: done (17 November 2026).** `partTag(name)` in `assembly.ts` is the hash. `nodeTag(node)` in `csg.ts` reads a render node's tag. `PartSpec` gained `inline` and `colorGiven`, and `file` is optional. A part wrapped in `translate()` or another operation is an error. The tests are the last six in `test/assembly.test.ts`.
- Phases 3 to 7: not started.

Phase 5 is the hardest. If a smaller model gets stuck there, hand that phase to a stronger one. Everything else is routine once the design below is followed.

---

## 0. Rules for whoever implements this

1. **One phase at a time.** Finish its acceptance list before starting the next. Do not start work that the phase does not list.
2. **Before every commit** run all three, and fix what fails:
   ```sh
   npm run check    # TypeScript
   npm test         # both WASM engines, in Node
   npm run build    # production site in dist/
   ```
3. **Look at the result.** After `npm run build`, run `python3 scripts/smoke.py` if Python Playwright and Chrome are available. It opens every example in a headless browser, plays a joint, and fails on a console error. Read the screenshots it writes to `.test-output/`.
4. **Pushing to `main` publishes the live site** (https://leon14026.github.io/partscript-cad/) through `.github/workflows/pages.yml`. Ask the owner before pushing.
5. **The owner's design files are not in this repository and must not be committed.** The label fan folder files (`label_fan_folder.scad`, `label_fan_folder_v4.scad`) are his own work. Ask him to attach them when a phase's acceptance list calls for them, keep them out of git, and build test fixtures from the small snippets in this plan instead.
6. **Every new behaviour gets a test** in `test/`, with an expected number worked out by hand (a volume, a distance, an angle). The existing tests show the style.
7. **Error messages say what to do next**, in plain words, and name the file and line when known. Throw `CadError(message, line?, file?)`.
8. **Keep to the stack**: TypeScript, React, three.js, CodeMirror, `occt-wasm`, the bundled OpenSCAD WASM. Add a dependency only where this plan names one (`fflate` moves from dev to runtime in phases 4 and 6).
9. **Update `README.md` and the Help dialog in `src/App.tsx`** when a phase changes what the user can do. Remove limits the phase lifts.
10. **When a fact here turns out wrong, stop and tell the owner** instead of working around it silently. Section 2 marks what was measured and what is design intent.

---

## 1. Where the project stands

Partscript is a static site. The user writes OpenSCAD, the real OpenSCAD engine evaluates it, OpenCascade (OCCT) rebuilds the result as exact solids, and the user exports STEP. Assemblies have joints, closed loops and playback. Nothing is installed and nothing is uploaded.

### How a build flows

```
App.tsx  --files, entry-->  client.ts  --postMessage-->  geometry.worker.ts
                                                              |
                                                         build.ts (ModelBuilder)
                                                              |
                 scad.ts: OpenSCAD WASM evaluates entry file -> CSG text + ECHO records
                                                              |
                 assembly.ts: records from part()/joint() -> AssemblySpec
                                                              |
                 per part file: scad.ts again -> CSG text -> csg.ts parse -> solid.ts OCCT solid + mesh
                                                              |
App.tsx  <--ModelPreview (assembly, meshes)--  worker
   |
kinematics.ts settles loops -> Viewport.tsx -> viewer.ts (WebGL) or softwarePreview.ts (CPU)
```

### File map

| File | What it does |
|---|---|
| `src/engine/protocol.ts` | Message and data types shared by page and worker. `CadError`. Size limits. |
| `src/engine/scad.ts` | `checkProject` (source checks), `evaluateScad` (one OpenSCAD run: files in, CSG text + ECHO lines out). Appends the prelude to the entry file. |
| `src/engine/assembly.ts` | The prelude (`part()`, `joint()` as OpenSCAD modules that `echo` records), record reader and validation, `structureOf` (which joints carry parts, which close loops), matrices, `solvePose`. |
| `src/engine/kinematics.ts` | Loop solver (Levenberg-Marquardt), `moveJoint`, `advanceJoint`, `settlePose`, `openingPose`, `loopStates`. Runs on the page, not in the worker. |
| `src/engine/csg.ts` | Parser for OpenSCAD's CSG dump. Reads every node with its character range. `unsupported()` says which parts the exact builder cannot make. `taggedParts`, `childrenText`, `firstColor` serve inline parts. |
| `src/engine/mesh.ts` | Pure TypeScript triangle meshes: binary STL reader, volume, bounds, and `toPartMesh` (flat-shaded triangles plus feature edges). |
| `src/engine/solid.ts` | CSG tree to OCCT solid (`buildSolid`), preview mesh (`previewSolid`), faceted mesh to solid (`meshToSolid`), STEP writers (`writeStep`, `writeAssemblyStep`). |
| `src/engine/summary.ts` | The sentence and tooltip that name faceted parts. |
| `src/engine/build.ts` | `ModelBuilder`: orchestrates a build, caches solids by CSG text, exports STEP. A part is built exact or faceted. |
| `src/engine/geometry.worker.ts`, `client.ts` | Worker entry and its page-side client (one job at a time, 60 s timeout, cancel). |
| `src/components/viewer.ts`, `softwarePreview.ts` | three.js viewer, and a CPU renderer used when WebGL2 is missing. Both draw one mesh per part with a matrix. |
| `src/components/Viewport.tsx` | Preview pane, joint sliders, play button, loop status. |
| `src/App.tsx`, `project.ts`, `drafts.ts` | Shell: file tabs, run, export, open/save, autosave to IndexedDB. |
| `src/examples.ts`, `assemblyExample.ts`, `linkageExample.ts` | Example projects. |
| `test/*.test.ts` | Node tests that run both WASM engines. `geometry` (single parts), `faceted` (meshed parts), `mesh` (pure functions), `assembly` (joints, inline parts, STEP round trip), `loops` (solver). |

### The assembly language today

```scad
part(name, file, at = [0,0,0], rot = [0,0,0], color = undef);   // or part(name) { shapes }, no file
joint(name, type = "fixed" | "hinge" | "slider", parent, child,
      at, rot,              // joint frame in the parent's coordinates
      child_at, child_rot,  // the same frame in the child's coordinates (default: child origin)
      axis = [0,0,1], limits = [lo, hi], value);
```

Joints are read in order. A joint that links two groups of parts not yet connected carries one from the other. A joint between already-connected parts closes a loop. Numbers cross from OpenSCAD to TypeScript as `[whole, millionths]` pairs (`_ps_n`), because `echo` prints only six significant digits.

---

## 2. Facts measured on 16 November 2026

These were run in Node against the engines in this repository (OpenSCAD `2025.03.25.wasm24456`, `occt-wasm` 5.17.2). Build on them. Timings are from a cloud machine; expect a work laptop to be slower by a small factor.

| # | Fact | Evidence |
|---|---|---|
| F1 | OpenSCAD can mesh any tree it evaluated. `--backend=manifold --export-format=binstl -o /out.stl` works in this WASM build. | Eight parts of the fan folder v4 file: 21 to 68 ms each, 76 to 8,304 triangles. |
| F2 | `-D 'part="drum_body"'` overrides a variable from the command line. | Same run. |
| F3 | A CSG dump is itself valid OpenSCAD input, as `.csg` or `.scad`. A dumped subtree can be meshed on its own with no libraries loaded. | Drum body dump re-rendered in 48 ms, same volume (88,059.57 mm³). |
| F4 | Rewriting `$fn = 0, $fa = X, $fs = Y` to `$fn = 0, $fa = 1, $fs = 0.05` in a dump gives a fine mesh for checking. | Drum body: 7,164 triangles, 122 ms, volume 88,093.72 (0.04% above the coarse mesh). |
| F5 | BOSL2 loads and evaluates with `--hardwarnings` clean. 56 `.scad` files, 5.2 MB of source, BSD-2-Clause. | Fan folder v3.3.1: gears 0.66 to 0.84 s, other parts 0.26 to 0.6 s. About 0.25 s of each run is parsing BOSL2. |
| F6 | BOSL2 `spur_gear` dumps as `linear_extrude { polygon }`. `threaded_rod` dumps as `polyhedron`. | Same run. |
| F7 | The whole v3.3.1 machine meshes as one object in 3.4 s (41,098 triangles). | `-D 'part="assembly"' -D crank_manual=30`. |
| F8 | `text()` fails: `WARNING: Can't get font`. No fonts are bundled. | `linear_extrude(2) text("Ab")` exits 1. |
| F9 | `import("m.stl")` works when the file is written into the OpenSCAD file system. | Returned the same mesh. |
| F10 | Binary STL keeps float32 precision. OFF and SVG exports print six significant digits. Use binary STL. | `cube(1/3)` in OFF prints `0.333333`. |
| F11 | Mesh to solid works: `importStl` gives a compound of triangle faces, `sewAndSolidify(faces, 1e-4)` gives a valid solid, `unifySameDomain` merges coplanar triangles. | Gear, 5,536 triangles: 159 + 244 + 296 ms, 1,390 faces, valid, volume unchanged. STEP export 511 ms, 5.3 MiB. |
| F12 | Faceted STEP files are large: about 3.8 KiB per face after merging. | Drum body 387 faces, 1.4 MiB. |
| F13 | `render(convexity = N)` and `color([r, g, b, a])` survive in the dump with their arguments. Named colours arrive as numbers. | Used for inline parts in phase 2. |
| F14 | A `*` node is dropped from the dump. `%` and `#` are printed as prefixes. `!` makes the dump contain only that node. | Dump of a test file. |
| F15 | A prism built from a polygon, minus `makeCylinder`, is a valid solid with a true cylinder in the STEP. | Plate 40 × 30 × 5 with an 8 mm hole: volume 5,748.6726, exactly the hand value. STEP 19 KiB. |
| F16 | The "tangent polygon plus cylinders" recipe of phase 5 gives exact convex outlines. | Slot, rounded rectangle and a hull of two unequal circles: each valid, each volume equal to the hand value to four decimals, 6 to 10 faces after `unifySameDomain`. |
| F17 | `kernel.scale` returns an invalid shape with zero volume. `kernel.transform` with a uniformly scaled matrix works and keeps flat faces flat. `kernel.generalTransform` handles unequal scales but turns every face into a spline surface. | Unit box scaled by 2: `scale` invalid, `transform` volume 8 with plane faces, `generalTransform` volume 8 with spline faces. |

| F18 | `sewAndSolidify` returns **no solid** when the mesh holds more than one body (10 shells, 0 solids). `sew` followed by `makeSolid` on each shell works. The collapsed triangles OpenSCAD's mesh contains (656 of 31,216 for the v4 machine) are dropped by `importStl` and do no harm. | Whole v4 machine as one part: faceted, 30,558 triangles, build 1.0 s. STEP export 20 s (sew 7 s, merge 9 s), 30.5 MiB, 8,105 faces, re-imports as 10 valid solids with volume 709,384.0 against the mesh's 709,383.97. The largest body alone (23,028 triangles) takes 9 s, so conversion time grows faster than the triangle count. |

| F19 | `include <lib.scad>` followed by `part = "none";` in the entry file is silent under `--hardwarnings` and leaves an empty dump (`group();`). The recipe of phase 2 works as written. | `test/assembly.test.ts`, library fixture. |
| F20 | The owner's v4 file included from an assembly with five inline parts (drum body, drum cap, spacer, drive plate, chute): one evaluation plus one mesh run per part, all faceted (`linear_extrude`). First build 0.7 s, unchanged rebuild 88 ms with one OpenSCAD run, editing a drum parameter rebuilds one part. STEP assembly 11.6 MiB in 6.2 s, five solids. | Scratch script, not in the repository. |

### Dump syntax by example

The parser in phase 1 must accept all of these. Arguments vary in order between OpenSCAD versions, so read them by name.

```
cube(size = [1, 1, 1], center = false);
sphere($fn = 0, $fa = 12, $fs = 2, r = 1);
cylinder($fn = 0, $fa = 4, $fs = 0.5, h = 3, r1 = 50.8845, r2 = 50.8845, center = false);
circle($fn = 5, $fa = 4, $fs = 0.5, r = 45.0845);
square(size = [3.8, 1.6], center = false);
polygon(points = [[0, 0], [4, 0], [0, 3]], paths = [[0, 1, 2]], convexity = 1);
polygon(points = [...8 points...], paths = [[0, 1, 2, 3], [4, 5, 6, 7]], convexity = 1);   // second path is a hole
polyhedron(points = [[0, 0, 0], ...], faces = [[0, 2, 1], ...], convexity = 1);
multmatrix([[1, 0, 0, 42.0845], [0, 1, 0, -0.8], [0, 0, 1, 0], [0, 0, 0, 1]]) { ... }
linear_extrude(height = 112.5, $fn = 0, $fa = 4, $fs = 0.5) { ... }
linear_extrude(height = 5, center = true, twist = 30, slices = 4, scale = [0.5, 2], $fn = 0, $fa = 12, $fs = 2) { ... }
rotate_extrude(angle = 270, start = 0, convexity = 2, $fn = 12, $fa = 12, $fs = 2) { ... }
offset(r = 0.4, $fn = 0, $fa = 4, $fs = 0.5) { ... }
offset(delta = -0.4, chamfer = false, $fn = 0, $fa = 4, $fs = 0.5) { ... }
hull() { ... }
minkowski(convexity = 0) { ... }
projection(cut = true, convexity = 0) { ... }
resize(newsize = [4,0,0], auto = [1,1,1], convexity = 0) { ... }     // note: no spaces inside these lists
color([0.854902, 0.439216, 0.839216, 1]) { ... }
render(convexity = 977003) { ... }
group() { ... }   union() { ... }   difference() { ... }   intersection() { ... }
#cube(size = [1, 1, 1], center = false);     %cube(size = [2, 2, 2], center = false);
```

Numbers in a dump have six significant digits. That limit already applies to every part today and is documented in the README.

### What the fan folder files use

Node counts across eight parts of the v4 file: `multmatrix` 222, `group` 203, `square` 128, `circle` 54, `linear_extrude` 24, `offset` 23, `polygon` 23, `difference` 14, `cylinder` 12, `hull` 10, `intersection` 10, `union` 6, `cube` 5. The v3.3.1 file adds BOSL2 gears (F6), 45 `hull` nodes in the crank disk's arc slots, and `text()` in its exploded view only.

---

## 3. Kernel and engine cookbook

Things that cost time to find. Read before writing geometry code.

**OCCT handles.** Every kernel call returns a `ShapeHandle` that lives until released. `build.ts` shows the pattern: `mark = kernel.checkpoint()`, build, serialise the result with `toBREPBinary`, `kernel.releaseSince(mark)`, then `fromBREPBinary` to get one clean handle. Use it for every new builder, or memory grows with each build.

**Wires need shared vertices.** `makeWire` of edges made with `makeLineEdge` gives an invalid wire (8 vertices for 4 edges) and `makeFace` then throws `construction failed`. Build polygons like this, which was tested and works:

```ts
const v = points.map(([x, y]) => kernel.makeVertex(x, y, 0));
const wire = kernel.makeWire(v.map((a, i) => kernel.makeEdge(a, v[(i + 1) % v.length])));
const prism = kernel.extrude(kernel.makeFace(wire), 0, 0, height);
```

**Do not call `kernel.scale`.** It returns an invalid shape in this version (F17). To scale evenly, put the factor into the matrix and call `kernel.transform`. For unequal factors use `kernel.generalTransform`, and accept spline faces.

**A circle wire does not make a face.** `makeFace(makeWire([makeCircleEdge(...)]))` throws. For an extruded circle call `makeCylinder(r, h)`. Phase 5 is designed so that no arc or circle wire is ever needed.

**Mesh to solid** (F11, F18): `importStl(bytes)`, then `sew(getSubShapes(raw, 'face'), 1e-4)`, then `makeSolid` on each of `getSubShapes(sewn, 'shell')`, then `unifySameDomain(makeCompound(solids))`. Check `isValid` and compare `getVolume` with the mesh volume. Do **not** use `sewAndSolidify` for a mesh that may hold several bodies: it returns no solid at all (F18). `meshToSolid` in `solid.ts` does all of this.

**Assemblies in STEP.** `writeAssemblyStep` in `solid.ts` uses `kernel.located(solid, matrix)` (no copy), `makeCompound`, then `document.addShape(compound, { assembly: true })`. Parts built from the same solid share one definition in the file.

**Matrices** are 12 numbers, row-major 3x4: `[r00, r01, r02, tx, r10, r11, r12, ty, r20, r21, r22, tz]`. `kernel.transform`, `kernel.located` and everything in `assembly.ts` use this layout. three.js `Matrix4.set` takes the same row order with a fourth row `0, 0, 0, 1`.

**One OpenSCAD instance per run.** The CLI build is single use. `evaluateScad` creates a fresh instance each time. With no library that costs about 20 ms. With BOSL2 it costs about 0.3 to 0.8 s (F5).

**`--hardwarnings` stays on.** It turns typos (`misspelled_module()`) into errors with a line number. The price is that any warning fails the run, including a missing font (F8).

**Tests** run TypeScript directly: `node --experimental-strip-types --test test/*.test.ts`. Imports need the `.ts` extension. Type-only imports must use `import type`.

**Kernel calls that exist and are useful later:** `importStep`, `importXCAFFromSTEP` (names, colours, tree), `meshShape` (triangles grouped by face: `faceGroups` holds `[triStart, triCount, faceHash]` triples), `wireframe` (`edgeGroups` holds `[pointStart, pointCount, edgeHash]`), `surfaceType`, `getFaceCylinderData` (radius), `curveType`, `curveLength`, `vertexPosition`, `getSurfaceArea`, `getSurfaceCenterOfMass`, `distanceBetween(a, b)`, `getBoundingBox`, `generalTransform`, `revolve`.

---

## Phase 1. Any OpenSCAD geometry builds (done)

**Result for the user:** every part file that OpenSCAD can render now shows up and exports to STEP. Parts built from boxes, cylinders and spheres stay exact, as today. Any other part is *faceted*: a valid solid with flat faces. The build output says which parts are which, and why.

**Idea.** Keep the exact builder as it is. When a part's tree contains anything the exact builder does not know, ask OpenSCAD to mesh that part (F1, F3) and use the mesh. This gives full coverage at once. Phase 5 then moves more parts from faceted to exact.

### 1.1 `src/engine/csg.ts`: parse everything

- Make `operation` a plain `string`. Stop throwing on unknown names.
- Record where each node sits in the dump: add `start` and `end` character offsets to `CsgNode`, covering the whole node including its `{ ... }` block or `;`. Phase 2 slices subtrees with them.
- Values: allow strings (`"..."` with backslash escapes) and `undef` (as `null`). Remove the limits of 16 items per list and depth 4, since `polygon` and `polyhedron` carry thousands of points. Cap the dump instead: 16 MiB of text and 200,000 nodes.
- Modifiers: `#` is ignored, as now. `%` marks a background shape that OpenSCAD leaves out of the result: parse the node and drop it from the tree. Remove the current `%` error.
- Add `export function unsupported(nodes: CsgNode[]): string | undefined`. It returns the name of the first operation the exact builder cannot handle, or `undefined`. In this phase the exact set is what `solid.ts` handles today, plus `color` and `render` treated as plain groups:
  - `cube`, `sphere` and `cylinder`, only when `$fn` is 0 (a `$fn` above 0 asks for visible facets)
  - `multmatrix` with a rigid matrix (reuse the test in `rigidMatrix`; a scale makes it unsupported)
  - `group`, `union`, `difference`, `intersection`, `color`, `render`
- Keep `hasShapes`. Extend it to any leaf that draws (`circle`, `square`, `polygon`, `polyhedron`, `text`, `import`, `surface` as well as the three solids).

### 1.2 `src/engine/mesh.ts` (new): triangle meshes

Pure TypeScript, no engine imports, so it is easy to test.

```ts
export interface TriangleSoup { positions: Float32Array }           // 9 floats per triangle
export function parseBinaryStl(bytes: Uint8Array): TriangleSoup      // 80-byte header, uint32 count, 50 bytes per triangle
export function meshVolume(soup: TriangleSoup): number               // sum of signed tetrahedra
export function meshBounds(soup: TriangleSoup): { min: Vec3; max: Vec3 }
export function toPartMesh(soup: TriangleSoup, creaseDegrees = 28): Omit<PartMesh, 'volume' | 'quality' | 'reason'>
```

`toPartMesh` produces what the viewers need:

1. Weld vertices that are equal after rounding to 1e-5 mm (a `Map` keyed by the three rounded numbers).
2. For each welded edge, find its two triangles. An edge is a *feature edge* when the angle between their normals exceeds `creaseDegrees`, or when it has only one triangle. Feature edges become `edgeSegments`.
3. Emit `positions`, `normals`, `indices` with one vertex per triangle corner (flat shading). Faceted parts should look faceted.

### 1.3 `src/engine/scad.ts`

- Delete the facet-override check (`$fn`, `$fa`, `$fs` are allowed everywhere now).
- Keep the `import`/`surface` rejection until phase 6.
- Add:
  ```ts
  /** Mesh a CSG dump, or a slice of one, with OpenSCAD's own renderer. */
  export async function renderMesh(csg: string, createOpenScad: OpenScadFactory): Promise<Uint8Array>
  ```
  Write the text to `/part.csg`, run `['--backend=manifold', '--export-format=binstl', '-o', '/part.stl', '/part.csg']`, read `/part.stl` as bytes (`FS.readFile(path)` with no encoding). Extend the `OpenScadModule` type for the byte read.
- **Load the engine once.** `loadOpenScad` in `geometry.worker.ts` returns the Emscripten factory, and every run then fetches `openscad.wasm` again (visible as one request per run in a local server's log). Fetch the file once into an `ArrayBuffer` and pass `wasmBinary` to each new instance, as the tests already do. This matters more now that a faceted part costs two runs.
- When OpenSCAD reports `Current top level object is not a 3D object`, throw `CadError('This file draws only flat 2D shapes. Wrap them in linear_extrude(height) to give them thickness.')`. When it reports an empty object, throw the existing "no solid volume" message.

### 1.4 `src/engine/protocol.ts`

```ts
export interface PartMesh {
  ...existing fields
  /** exact: true curves from OpenCascade. faceted: flat faces from OpenSCAD's mesh. */
  quality: 'exact' | 'faceted';
  /** For a faceted part, the operation that made it so, for example "hull". */
  reason?: string;
}
```

### 1.5 `src/engine/build.ts` and `solid.ts`

In `ModelBuilder`, a cached entry becomes one of two kinds:

```ts
type CachedSolid =
  | { kind: 'exact'; shape: ShapeHandle; mesh: PartMesh }
  | { kind: 'faceted'; stl: Uint8Array; mesh: PartMesh; shape?: ShapeHandle };   // shape made on first export
```

- `#solid(csg, file)` becomes async. Parse the dump. If `unsupported(nodes)` is `undefined`, take today's exact path. Otherwise call `renderMesh(csg)`, build the mesh with `mesh.ts`, set `quality: 'faceted'` and `reason`.
- **Smooth is smooth at any `$fa` and `$fs`.** `solid.ts` currently rejects a sphere or cylinder unless `$fa` is 12 and `$fs` is 2, the OpenSCAD defaults. Remove that: a design that sets `$fa = 4; $fs = 0.5;` at the top, as the fan folder does, is still asking for round shapes. Only `$fn > 0` means facets.
- **The preview of a faceted part comes straight from the STL.** Do not convert it to OCCT during a build. Conversion costs up to a second per part (F11) and is only needed for STEP.
- `exportStep` first makes sure every faceted entry has a `shape` (cookbook: mesh to solid). Compare the solid's volume with `meshVolume`: if they differ by more than 0.1%, or the solid is not valid, throw `CadError('<file> could not be turned into a solid for STEP. It may have faces that touch only along an edge.')`. Cache the shape on the entry, and release it when the entry is evicted.
- **Allow several bodies in one part.** In `buildSolid`, replace the "N separate solids" error: when the result has more than one solid, return `kernel.makeCompound(kernel.getSubShapes(shape, 'solid'))` with the summed volume. Keep the "no solid volume" error. In `writeStep`, the check for `MANIFOLD_SOLID_BREP` still holds for compounds.
- `ModelPreview` already carries `meshes`, so `quality` and `reason` travel with them.

### 1.6 Page

- `builtText` in `App.tsx`: after the counts, add one sentence when any part is faceted, for example `2 parts are faceted (chute.scad uses hull, gear.scad uses polyhedron).` List at most three files, then `and N more`.
- `Viewport.tsx`: in the part-count chip's tooltip, list each part with `exact` or `faceted`.
- Help dialog and README: replace the "Shapes and operations" and "Model limits" text. State that all OpenSCAD geometry builds, that boxes, cylinders and spheres combined with booleans export with true curves, and that other operations export as flat-faced solids until phase 5.

### 1.7 Tests: `test/faceted.test.ts` (new) and updates

Each case builds a one-file project through `ModelBuilder` and checks the preview volume against a hand value, then exports STEP, re-imports it with `kernel.importStep`, and checks the volume again within 0.1%.

| Source | Expect |
|---|---|
| `linear_extrude(5) square([4, 3]);` | faceted, reason `linear_extrude`, volume 60 |
| `linear_extrude(4) difference() { circle(r = 10, $fn = 5); circle(d = 3, $fn = 24); }` | volume = 4 × (pentagon area 237.764 − 24-gon area 6.9881) |
| `hull() { cube(2); translate([4, 0, 0]) cube(2); }` | volume 24 |
| `rotate_extrude($fn = 64) translate([5, 0]) square([1, 2]);` | volume ≈ 2π × 5.5 × 2 within 0.3% |
| `polyhedron` tetrahedron from section 2 | volume 1/6 |
| `scale([1, 2, 3]) cube(1);` | faceted (until phase 5), volume 6 |
| `cylinder(h = 5, d = 12, $fn = 6);` | faceted, volume = 5 × hexagon area 93.531 |
| `cube(2); translate([5, 0, 0]) cube(2);` | exact, two bodies, volume 16, STEP re-imports with 2 solids |
| `cube(2); %translate([1, 0, 0]) cube(9);` | exact, volume 8 |
| `square(3);` | error mentioning `linear_extrude` |
| an assembly of one exact and one faceted part | STEP assembly re-imports with both, summed volume |

Update `test/geometry.test.ts`: the last test currently expects `hull`, `scale`, `$fn` and "2 separate solids" to be rejected. They now build. Keep the cases that still fail (empty results, syntax errors, unknown modules, an include of a missing file).

Unit-test `mesh.ts` on its own: a hand-written 12-triangle cube gives volume 1, 12 feature edges, correct bounds.

### Acceptance

- [ ] All tests pass, including the 16 that exist today.
- [ ] Every example still builds with every part `exact`.
- [ ] `label_fan_folder_v4.scad` opened as a single file builds its default view (the whole machine as one faceted part) and exports a STEP that re-imports. Ask the owner for the file.
- [ ] Build output names the faceted parts and the reason.
- [ ] `scripts/smoke.py` passes.

**Out of scope:** exact extrusions (phase 5), mixing exact and faceted geometry inside one part, `text()`, libraries.

---

## Phase 2. Many parts from one file (done)

**Result for the user:** an assembly file can define parts in place, so a design kept in one `.scad` file with many modules becomes a moving assembly without being split up:

```scad
include <label_fan_folder.scad>
part = "none";                       // last assignment wins: the included file now draws nothing

part("drum")    { ff_drum_body(); translate([0, 0, drum_len - flange_t]) ff_drum_cap(); }
part("coupler") ff_coupler();
part("motor", "nema17.scad");        // a part from its own file still works
```

It is also fast: one OpenSCAD run evaluates every inline part, instead of one run per part (F5).

### Design

The prelude's `part()` module tags its children so they can be found in the dump (F13):

```scad
function _ps_hash(s, i = 0, a = 7) = i >= len(s) ? a : _ps_hash(s, i + 1, (a * 31 + ord(s[i])) % 99991);
module part(name = undef, file = undef, at = [0, 0, 0], rot = [0, 0, 0], color = undef) {
    echo(["@partscript", "part", name, file, _ps_v(at), _ps_v(rot), _ps_v(color), $children]);
    if ($children > 0) render(convexity = 900000 + _ps_hash(is_string(name) ? name : "")) children();
}
```

A tag is a `render` node whose `convexity` is 900000 or more. This was tested: the dump shows `render(convexity = 977003) { ... }` around each part's geometry.

### Steps

1. `assembly.ts`
   - Update the prelude as above. The record gains a last field, the child count.
   - `PartSpec.file` becomes optional. Add `inline: boolean`. In `readAssembly`: a part needs a file or children, and not both. Messages: `part("x"): give it a file name or shapes in braces.` and `part("x"): it has both a file and shapes in braces. Use one.`
   - Port `_ps_hash` to TypeScript as `partTag(name)`.
2. `csg.ts`: add `export function taggedParts(nodes): { tag: number; node: CsgNode }[]`. It walks the tree in document order, collects `render` nodes with `convexity >= 900000`, and does not descend into one it has collected.
3. `build.ts`, in the assembly branch of `build`:
   - Call `taggedParts` on the entry's tree. The i-th inline part in the records matches the i-th tagged node. Check that the counts match and that each `tag - 900000` equals `partTag(name)`. On a mismatch throw `The parts in braces could not be matched to their shapes. Give each part() a different name.`
   - An inline part's CSG text is the slice of the entry dump covered by the tagged node's children (`start` of the first child to `end` of the last). Feed that text to the same `#solid(csg, file)` path. Nothing else changes: the cache is keyed by CSG text, so an unchanged part is reused after an edit elsewhere.
   - The rule "an assembly file must not draw shapes" now means: no shapes *outside* tagged nodes. Apply `hasShapes` to the tree with tagged nodes removed.
   - An inline part with no geometry: `part("x"): its shapes produce nothing.`
4. Colour: when a part has no `color` argument and its subtree contains a `color([r, g, b, a])` node, use the first one's RGB. Ignore alpha.
5. Places that assume `part.file` exists: `writeAssemblyStep` (use the part name for the definition name), `builtText`, the tooltip from phase 1.
6. README and Help: document inline parts and the `include` + `part = "none"` recipe.

A part's shapes are taken as written in the assembly file's coordinates. The part's origin is the file's origin unless a joint moves it. Say so in the README, since joints place the child's *origin* (or `child_at`).

### Tests (`test/assembly.test.ts`)

- Two inline parts and one file part, joined by a hinge: three meshes, correct names, joint works.
- Two inline parts with identical shapes share one mesh (`partMesh` repeats an index).
- A `for` loop that makes `part(str("wheel_", i))` twice: two parts, in order.
- Shapes outside braces: the existing "Move the shapes into a part file" error, reworded to mention braces.
- File and braces together: error.
- A colour picked up from `color("orchid")` inside the braces: `[0.854902, 0.439216, 0.839216]`.
- An included library file plus `part = "none"`: only the inline parts appear. Build a small fixture for this: a file with an `if (part == "a") ... else if (part == "b") ...` chain at the end, like the fan folder's.

### Acceptance

- [ ] Tests pass.
- [ ] With the owner's `label_fan_folder_v4.scad` in a project, an assembly file that includes it and declares five inline parts builds in one OpenSCAD run. Confirm by counting calls to the OpenSCAD factory in a test with a stand-in fixture.
- [ ] Editing one inline part rebuilds one mesh (`rebuilt === 1`).

**Out of scope:** `-D` overrides per part, nested assemblies.

---

## Phase 3. Driven joints: gear ratios and cam tables

**Result for the user:** one joint can follow another. A gear pair is a ratio. A cam, or any motion given by a formula, is a table that OpenSCAD computes when the model is built.

```scad
// The drum turns twice per crank turn, the other way
joint("drum", type = "hinge", parent = "frame", child = "drum",
      follow = "crank", ratio = -2);

// The roller rides the drum: its height comes from the design's own function
joint("roller", type = "slider", parent = "frame", child = "roller", axis = [0, 1, 0],
      follow = "drum", table = [for (a = [0 : 2 : 360]) [a, ff_roller_y(a)]]);
```

A following joint has no slider. It shows its value, read only.

### Design

- New `joint()` arguments: `follow` (name of another joint), `ratio` (default 1), `offset` (default 0), `table` (list of `[input, output]` pairs, at least two, inputs strictly increasing).
- With no table: `value = offset + ratio × driver`.
- With a table: `value = offset + ratio × lookup(driver)`, linear between rows. When the driver is a hinge with no end stops (`turnsFully`) and the table spans exactly 360, wrap the driver into the table's range first. Otherwise clamp to the first and last rows.
- A follower's `limits` and `value` are not used. If given, reject them: `joint("x"): a joint that follows another takes its value from it. Remove limits and value.` A follower slider therefore needs no `limits`, unlike a free slider.
- Followers may chain (`a` follows `b` follows `c`). A cycle is an error.
- A follower may not be a closing joint and may not lie on a loop (`structureOf(...).looped`). Error: `joint("x") follows another joint, so it cannot be part of a closed loop.` The *driver* may be in a loop. That is the fan folder: the crank drives the four-bar and the drum follows the crank.

### Steps

1. `assembly.ts`
   - Prelude: add the arguments. Encode the table with a nested helper, `function _ps_t(t) = is_list(t) ? [for (row = t) _ps_v(row)] : t;`.
   - `JointSpec`: add `follow?: { joint: string; ratio: number; offset: number; table?: [number, number][] }`.
   - `readAssembly`: validate as above. Cap a table at 5,000 rows.
   - Add `resolveFollowers(assembly, values: number[]): number[]`. It fills in follower values in dependency order. Compute the order once in `structureOf` (add `followOrder: number[]`).
   - `jointValues` calls `resolveFollowers` after clamping the free joints. Followers are never clamped.
   - `movingJoints` excludes followers. Add `followerJoints(assembly)`.
   - `clampJoint` for a follower returns the value unchanged.
2. `kinematics.ts`
   - `residuals` and `close` work on a `values` array. Call `resolveFollowers` on it before `placeParts` everywhere parts are placed. The simplest safe place is inside `placeParts` itself: resolve, then place.
   - `loopJoints` excludes followers. `moveJoint` and `advanceJoint` on a follower return the pose unchanged.
   - `toPose` writes follower values into the pose too, so the page and the STEP export see them.
3. `Viewport.tsx`: under the sliders, one row per follower: icon, name, `follows crank`, current value with unit. Reuse the `.joint-loop` row style.
4. Worker: nothing. `exportStep` calls `solvePose`, which resolves followers.
5. Example: extend `linkageExample.ts` or add `gearedExample.ts`: a crank, a wheel that follows it at ratio −2, and a slider that follows the wheel through a table from a small OpenSCAD function. Use only boxes and cylinders so it stays exact.

### Tests (`test/loops.test.ts`)

- Ratio: driver at 30 gives follower at −60. Driver at 170 gives −340: the part's matrix equals a rotation by −340.
- Table: `[[0, 0], [90, 10], [180, 0]]` with driver 45 gives 5. Below the first row clamps.
- A full-turn driver with a 0 to 360 table: driver at −90 looks up 270.
- A table built by an OpenSCAD function: `[for (a = [0 : 5 : 360]) [a, 10 * sin(a)]]`, checked at three angles within 1e-3.
- A chain of two followers.
- A cycle, a follower on a loop, and a follower with `limits`: each gives its error.
- Crank-rocker plus a follower on the crank: advancing the crank by 360 in 5 degree steps keeps the loop shut and the follower at −2 × crank.

### Acceptance

- [ ] Tests pass. New example plays smoothly in `scripts/smoke.py`.
- [ ] Followers appear in the exported STEP at their resolved positions (extend the STEP round-trip test).

**Out of scope:** gear *contact* (teeth are not simulated; the ratio is stated), cams defined by contact between surfaces.

---

## Phase 4. The BOSL2 library

**Result for the user:** `include <BOSL2/std.scad>` works. Gears, threads and the rest of BOSL2 build. Until phase 5 they are faceted. After it, extruded gears keep flat tooth flanks (they are polygons, F6) with exact top and bottom faces.

### Steps

1. **Bundle.** Add `scripts/fetch-libraries.mjs`. It downloads BOSL2 at a pinned commit from GitHub, keeps the top-level `*.scad` files and `LICENSE`, and writes `public/engines/libraries/BOSL2.zip` with `fflate`. Commit the zip (about 1 MB) so builds and CI need no network. Record the commit hash in the script and in `public/licenses/NOTICES.txt` with the BSD-2-Clause text. Move `fflate` to `dependencies`.
2. **Registry.** In `scad.ts` add `const libraries = { BOSL2: 'engines/libraries/BOSL2.zip' }`. In `checkSource`, an `include`/`use` target of the form `<Name>/<file>.scad` is allowed when `Name` is in the registry. Collect which libraries a project uses.
3. **Loading.** `evaluateScad` takes an extra argument: a map of library name to its files (`Record<string, Uint8Array | string>`). For each library in use, create the directory with `FS.mkdir` and write its files before running. Mount only the libraries in use, so other projects stay fast. Extend the `OpenScadModule.FS` type with `mkdir`.
4. **Worker.** In `geometry.worker.ts`, fetch and unzip a library the first time a build needs it, and keep it in memory. Resolve the URL the same way `loadOpenScad` resolves the engine. Report a `load` progress stage while fetching.
5. **Tests.** Read the zip from `public/` with `node:fs` and `fflate`. One test: `include <BOSL2/std.scad>` and `include <BOSL2/gears.scad>`, `spur_gear(mod = 2, teeth = 20, thickness = 8);` builds faceted, with volume between that of the root cylinder and the tip cylinder (root radius 17.5, tip radius 22, thickness 8). One test: a library that is not in the registry gives the "External libraries are unavailable" message naming it.
6. **Speed note in README:** each OpenSCAD run that uses BOSL2 takes about half a second longer, so prefer inline parts (phase 2), which need one run.
7. **Fonts for `text()`** (optional, separate commit). The upstream playground ships fonts for this same WASM build. If they can be fetched from `files.openscad.org` at a pinned URL and mounted so that `linear_extrude(1) text("A");` renders, bundle them the same way and add a test. If not, catch `Can't get font` in `evaluateScad` and throw `text() needs fonts, which are unavailable in this version. Remove the text or hide it behind a variable.`

### Acceptance

- [ ] Tests pass.
- [ ] The owner's `label_fan_folder.scad` (v3.3.1) opens and builds its `assembly` view as one faceted part. Measured in Node: about 3.5 s (F7).
- [ ] With phases 2 and 3 done: an assembly file that includes the v3.3.1 file reproduces its motion. See the appendix for a starting point.

---

## Phase 5. Exact extrusions

**Result for the user:** parts made by extruding 2D outlines export with true cylinders and flat faces, like parts made from solids do today. Holes are round in STEP. Files are far smaller (F12).

**Principle.** Never trust a new exact builder on its own. Every exact result is checked against OpenSCAD's own mesh of the same tree (F4). If they disagree, the part falls back to faceted and the build output says so. A bug then costs quality, never correctness.

### 5.0 The check

In `build.ts`, after an exact solid is built for a tree that used any phase-5 feature:

1. Take the part's CSG text. Replace every `$fn = 0, $fa = <n>, $fs = <n>` with `$fn = 0, $fa = 1, $fs = 0.05` (F4). Mesh it with `renderMesh`. If the fine mesh exceeds 400,000 triangles, mesh the original text and use the looser tolerance below.
2. Compare volumes: relative difference at most 0.3% (2% with the coarse mesh).
3. Compare bounding boxes: each of the six numbers within 0.05 mm (0.5 mm with the coarse mesh).
4. On failure, fall back to the faceted path with `reason: 'exact build did not match'`, and `console.warn` the two volumes.

Trees that use only today's solids skip the check, as they do now. The result is cached with the part, so it runs only when a part changes.

### 5.1 Easy wins in `solid.ts`

- `cylinder` with `$fn > 0` and `r1 == r2`: a regular prism with `$fn` sides. OpenSCAD puts the first vertex on +X. Build it with the polygon recipe in the cookbook.
- `multmatrix` with a uniform scale (the 3x3 part is a rotation or mirror times one factor `s > 0`): restore orthogonality as `rigidMatrix` does, multiply the 3x3 part by `s`, and call `kernel.transform` (F17). Remember that translations inside a scaled subtree are already scaled in the dump's matrix.
- `multmatrix` with unequal scales and no shear: `kernel.generalTransform`. The result is valid but its faces are splines, so use it only when the subtree is otherwise exact, and let the check in 5.0 confirm it. A matrix with shear stays unsupported.
- Update `unsupported()` in `csg.ts` in step with each addition. The two must always agree.

### 5.2 A 2D description that needs no wires

Evaluate the 2D subtree under `linear_extrude` into a small tree of our own:

```ts
type Disc = { x: number; y: number; r: number };             // r = 0 is a point
type Flat =
  | { kind: 'convex'; discs: Disc[] }                         // convex hull of discs
  | { kind: 'polygon'; outer: [number, number][]; holes: [number, number][][] }   // simple, may be concave
  | { kind: 'union' | 'difference' | 'intersection'; items: Flat[] };
```

`convex` covers a great deal with one idea: the convex hull of a set of discs.

| OpenSCAD | `convex` discs |
|---|---|
| `circle(r)` with `$fn = 0` | one disc |
| `square`, `circle($fn = n)`, a convex `polygon` | corners as discs of radius 0 |
| `offset(r = a)` of a convex item, `a > 0` | same discs, each radius + a |
| `hull()` of convex items | all their discs together |
| rounded rectangle: `offset(r = a) offset(delta = -a) square(...)` | four discs of radius a |
| slot: `hull() { circle(d = w); translate([l, 0]) circle(d = w); }` | two discs |

Rules for the evaluator (`src/engine/flat.ts`, new, pure TypeScript):

- `multmatrix` in 2D: apply to disc centres and polygon points. Accept rotation, translation and mirror (the Z row and column must be identity). A uniform scale multiplies radii. Anything else: unsupported.
- `offset(delta = d)` (sharp corners):
  - On a `convex` whose discs all have `r = 0` (a convex polygon): move each edge outward by `d` and intersect neighbours. `d` may be negative. If the polygon collapses, the result is empty.
  - On a single disc: radius + d.
  - Otherwise unsupported.
- `offset(r = a)` with `a < 0` on a convex polygon: the same as `delta = a`, since shrinking a convex polygon keeps its corners sharp. On a single disc: radius + a.
- `offset` with `chamfer = true`, or on a `polygon` or boolean: unsupported.
- `hull` of anything that is not convex: unsupported. (`hull` of a concave polygon could use its points; leave it.)
- `polygon` that is convex becomes `convex`. A concave one stays `polygon`. Clean the points first: drop repeated and collinear points, and make the winding counter-clockwise. Self-intersecting input: unsupported.
- `group`, `union`, `difference`, `intersection`: `Flat` booleans, with the same child rules as 3D (`difference` takes the first child as the base).
- `text`, `projection`, `import`, anything else: unsupported.

`unsupported()` must call this evaluator's dry run so a part is only sent down the exact path when its whole 2D tree is covered.

### 5.3 Extruding without 2D booleans

Extruding distributes over booleans when everything has the same height:

```
linear_extrude(h) difference() { A; B; }   ==   difference() { linear_extrude(h) A; linear_extrude(h) B; }
```

So turn each `Flat` leaf into a solid of height `h` and apply the 3D booleans `solid.ts` already has. This was tested (F15, F16).

- `linear_extrude` qualifies only with `twist` 0 or absent and `scale` 1 or absent. `center = true` shifts by `-h / 2`. Anything else: unsupported.
- **Convex leaf to solid:**
  1. One disc with `r > 0`: `makeCylinder(r, h)` moved to its centre.
  2. All radii 0: the prism of the convex hull of the points (monotone chain).
  3. Mixed: the prism of the *tangent polygon*, fused with one cylinder per disc that has `r > 0`, then `unifySameDomain`. The tangent polygon is the convex hull of every outer-tangent point between every pair of discs. For discs `i` and `j` with centre distance `d` and `d > |ri − rj|`, let `u` be the unit vector from `i` to `j`, `n` its left normal, and `c = (ri − rj) / d`, `s = sqrt(1 − c²)`. The two outer tangent directions are `t± = c·u ± s·n`, and the tangent points are `Ci + ri·t±` and `Cj + rj·t±`. Skip a pair where one disc contains the other. A disc inside the hull of the others adds nothing harmful.
- **Polygon leaf to solid:** prism of the outer path, minus a prism for each hole.
- Lift every leaf by a small overlap when it is a cutting tool? No: keep exact heights. The existing tests show OCCT handles coplanar caps in these booleans. The check in 5.0 catches a failure.

Guard: when a part would need more than 300 leaf solids, treat it as unsupported (the v3.3.1 crank disk has 45 slots built from 93 circles; faceted is the right answer for it).

### 5.4 Order of work, each with tests

Each step is a commit. Each test asserts `quality === 'exact'`, a hand-computed volume to 1e-4 relative, and where curves are expected, `CYLINDRICAL_SURFACE` in the STEP.

| Step | Fixture | Volume |
|---|---|---|
| a. square, polygon, booleans | `linear_extrude(5) difference() { square([40, 30]); translate([5, 5]) square([10, 10]); }` | 5 × 1,100 |
| b. circle | plate with a round hole: `difference() { square([40, 30]); translate([10, 10]) circle(4); }`, height 5 | 5 × (1,200 − 16π) |
| c. `circle($fn = 5)` | pentagon prism, r = 45.0845, height 10 | 10 × 2.37764 × r² |
| d. 2D transforms | the D-shaft: `intersection() { circle(d = 8); translate([-8, -8]) square([16, 11.2]); }`, height 20 | 20 × (circle area minus the segment beyond y = 3.2) |
| e. `offset(delta)` on convex | `offset(delta = -1.2) circle(r = 45.0845, $fn = 5)` | pentagon with apothem reduced by 1.2 |
| f. rounded rectangle | `offset(r = 3) offset(delta = -3) square([40, 30])`, height 5 | 5 × (1,200 − (4 − π) × 9) |
| g. slot | `hull() { circle(d = 10); translate([30, 0]) circle(d = 10); }`, height 5 | 5 × (300 + 25π) |
| h. unequal hull | `hull() { circle(d = 22); translate([40, 0]) circle(d = 14); }`, height 5 | from the tangent formula; also compare with the fine mesh |
| i. `offset(r)` of a hull | `offset(r = 2)` of fixture g | slot with d = 14 |
| j. concave polygon with a hole | the 8-point example in section 2, height 1 | 36 − 4 |
| k. `cylinder(h = 5, d = 12, $fn = 6)`; `scale(2) cube(1)`; `scale([1, 2, 3]) cube(1)` | | 5 × 93.531; 8; 6 |
| l. real parts | snippets modelled on the fan folder: drum body (pentagon, ribs, spokes, D-bore), spacer, roller, coupler link, detent wheel | each `exact`, and equal to its fine mesh within 0.3% |

Also test the fallback: stub the exact builder to return a wrong solid and assert the part comes back `faceted` with the "did not match" reason.

### Acceptance

- [ ] Tests pass. All earlier examples still `exact`.
- [ ] On the owner's v4 file, list which parts are exact and which are faceted, with reasons, and give him the list. Expected exact: drum body, drum cap, spacer, collar, roller, shafts, ties, entry bar, detent wheel and arm, servo hub, tray parts, pitch gauge. Expected faceted: plates with `lite_plates = true` (an `offset` over a boolean), chute and motor mount (3D `hull`), dancer (a `hull` with a concave neighbour).
- [ ] A STEP of the drum body is under 200 KiB (it is 1.4 MiB faceted).

**Out of scope:** `rotate_extrude`, twisted or tapered extrusions, 3D `hull`, `minkowski`, `offset` over booleans, and exact geometry mixed with faceted geometry inside one part. Each stays faceted. They are backlog items.

---

## Phase 6. Import STEP and STL files

**Result for the user:** a file downloaded from GrabCAD or a supplier (a motor, a bearing, a bracket) can be added to a project, shown, placed in an assembly with joints, and exported with everything else.

**Formats.** STEP (`.step`, `.stp`) imports as exact geometry. STL (`.stl`) imports as a mesh and exports faceted. Native CAD formats (`.sldprt`, `.ipt`, `.f3d`, `.x_t`, `.iges`) cannot be read: tell the user to download the STEP version, which most GrabCAD models include.

### Design

- A project file is now text or binary. In `project.ts`: `ProjectFile = { name: string; source: string } | { name: string; data: Uint8Array }`. Binary files are *assets*. Names end in `.step`, `.stp` or `.stl`, matched case-insensitively and stored lower-case.
- Limits: 40 MB per asset, 120 MB per project. Check on open and say which limit was hit.
- An asset is a part by file name: `part("motor", "nema17.step");`. An asset can also be the build target on its own, to look at it and measure it.
- STL only: `import("bracket.stl");` inside a `.scad` file works too (F9), since OpenSCAD reads it. Lift the `import` rejection in `checkSource` for names that are project `.stl` assets. `surface` and other imports stay rejected.

### Steps

1. **Storage.** `drafts.ts`: IndexedDB stores `Uint8Array` as is. `readProject` must accept both kinds of file.
2. **Project file.** Switch `Save project` to a zip, `<name>.partscript.zip`, written with `fflate`: every project file at the top level plus `partscript.json` holding `{ format, version: 2, entry, active }`. `Open` accepts this zip, the old `.partscript.json`, `.scad` files and assets. Keep reading version 1 forever.
3. **Tabs.** An asset tab shows a panel instead of the editor: name, size, format, and after a build its body count and bounding box. Rename and delete work. `Save file` downloads the original bytes.
4. **Protocol.** `ProjectFiles` becomes `Record<string, string | Uint8Array>`. Assets are sent to the worker on every build, which copies them. To avoid that, send assets once: add a `{ kind: 'assets', files }` command the page issues when an asset is added or replaced, and have the worker keep them by name with a content hash.
5. **Worker, `build.ts`.**
   - Asset STEP: `kernel.importStep(bytes)`. Accept a solid or a compound of solids. No solids: `<file> has no solid bodies. It may contain only surfaces or curves.` Tessellate with `previewSolid`. If `previewSolid` exceeds its triangle limit, retry once with three times the deflection before failing. `quality: 'exact'`.
   - Asset STL: parse with `mesh.ts` (accept ASCII STL as well: detect by the absence of a valid binary length). `quality: 'faceted'`, `reason: 'imported mesh'`. The lazy mesh-to-solid path from phase 1 serves the export.
   - Cache by content hash (SHA-256 through `crypto.subtle`), not by name.
   - Use the build-and-serialise pattern from the cookbook for the imported shape.
6. **Assembly.** `readAssembly` accepts a part file ending in an asset extension. Parts from one asset share one solid, as parts from one `.scad` do.
7. **Colours and names (optional, after the rest works).** `kernel.importXCAFFromSTEP` exposes the STEP's tree, names and colours. First version: one colour per imported part, taken from `part(color = ...)` or the palette.
8. **Units.** OCCT converts STEP units to millimetres. STL has no units: assume millimetres and say so in the asset panel.

### Tests (`test/import.test.ts`, new)

- Export the swivel arm to STEP in the test, add the bytes as `arm.step`, build it alone: `exact`, 4 bodies, volume equal to the original.
- An assembly with `part("a", "arm.step")` and a `.scad` part joined by a hinge: both placed, STEP round trip keeps both.
- A binary STL made in the test from `renderMesh`: `faceted`, right volume. The same as ASCII STL.
- `import("m.stl")` inside a `.scad` part.
- A text file renamed `.step`: a clear error, no crash.
- Project zip: save, reopen, files and bytes identical. Version 1 JSON still opens.

### Acceptance

- [ ] Tests pass.
- [ ] A real GrabCAD STEP of a NEMA 17 motor (the owner downloads it; do not commit it) opens, shows, and can be hinged to a bracket. Report its load time and triangle count.
- [ ] Autosave and reopening the page keep the asset.

**Out of scope:** IGES, native CAD formats, editing imported geometry, per-face colours.

---

## Phase 7. Measure

**Result for the user:** a Measure tool in the preview. Click a face, an edge or a corner to read its size. Click two things to read the distance and angle between them.

### What it reports

| Picked | Reads |
|---|---|
| A flat face | area |
| A cylindrical face (a hole, a shaft) | diameter, length along its axis |
| An edge | length; diameter when it is a circle or arc |
| A corner | its coordinates |
| Two corners, or a corner and anything | distance |
| Two flat faces | distance when parallel; angle otherwise |
| Two cylindrical faces | centre-to-centre distance of their axes when parallel; angle otherwise |
| Any two picks | shortest distance between them |

Positions are in the assembly's current pose. On a faceted part, faces are the flat regions of the mesh, and only areas, corner positions and distances are offered.

### Design

- **Picking is done on the CPU**, so it works the same in the WebGL view and the software view. Cast a ray from the camera through the pointer against each part's triangles in world space (three.js `Raycaster` with the part's matrix, or a plain Möller-Trumbore loop). The nearest hit gives the part and the triangle.
- **Triangle to face.** Exact parts: build the preview with `kernel.meshShape` instead of `tessellate`, and keep `faceGroups` (`[triStart, triCount, faceHash]` per face). `PartMesh` gains `faceOf: Uint32Array` (face index per triangle). Faceted parts: in `mesh.ts`, flood-fill triangles across edges that are not feature edges to label flat regions, and store the same array.
- **Edges and corners.** `wireframe` returns `edgeGroups` (`[pointStart, pointCount, edgeHash]`). Add `edgeOf: Uint32Array` (edge index per line segment). An edge is picked when the pointer is within 6 px of a segment and that beats the face hit. A corner is picked within 8 px of a segment endpoint that ends an edge.
- **Hover highlight.** Tint the hovered face's triangles or draw the hovered edge thicker. In the software view, draw only the edge or the face outline.
- **Exact numbers come from the kernel.** Add a worker command:
  ```ts
  { kind: 'measure'; id; revision; pose: Pose; picks: { part: number; type: 'face' | 'edge' | 'vertex'; index: number }[] }   // one or two picks
  ```
  The worker finds each sub-shape with `kernel.getSubShapes(solid, type)[index]`, places it with `kernel.located(sub, matrix)` using `solvePose`, and answers with `surfaceType`, `getSurfaceArea`, `getFaceCylinderData`, `curveType`, `curveLength`, `vertexPosition`, and for two picks `distanceBetween`. Check first that the order of `getSubShapes(solid, 'face')` matches the order of `faceGroups`: write a test that compares each face's area from the kernel with the area summed from its triangles. If the orders differ, map through the hashes with `subShapeHashes`.
- **Angles and axes.** For two flat faces use their normals (`surfaceNormal`), transformed by each part's matrix. For cylinders, take the axis from `surfaceData`. Parallel means within 0.01 degree.
- **Faceted parts** are measured on the page from the mesh: region area, corner coordinates, corner-to-corner distance. Shortest distance between two regions is not offered.
- Releasing handles: wrap each measure job in `checkpoint` / `releaseSince`.

### Page

- A `Measure` toggle button in the preview toolbar (lucide `Ruler`). While on: orbit still works by dragging, a click without a drag picks, `Esc` clears picks, a second `Esc` leaves the tool.
- A result card in the top-left of the preview: what was picked, each value on its own line with unit, and a copy button per value. Values to 0.001 mm and 0.01 degree.
- Draw a line between the two closest points for a distance.
- Joint playback pauses while a measurement is shown, because values belong to one pose.

### Tests (`test/measure.test.ts`, new)

Drive the worker-side function directly with picks by index.

- Mounting plate example: a hole face reads diameter 5 and length 6. Two hole faces read centre distance 64 (the X pairs) and 24 (the Y pairs). Top and bottom faces read distance 6, parallel. A long edge reads 80.
- Tapered spacer: the bore reads diameter 8. A conical face reports type `cone` and no diameter.
- Swivel arm with `lift` at 30: the angle between the base's top face and the arm's top face is 30.
- Face order check described above, on three parts.
- `mesh.ts` regions: a cube mesh gives 6 regions of area 1.

### Acceptance

- [ ] Tests pass.
- [ ] In the browser: measure a hole diameter and a hole-to-hole distance on the mounting plate, in the WebGL view and in the software view (`scripts/smoke.py --software`).
- [ ] Measuring an imported STEP part works (after phase 6).

**Out of scope:** dimensions that stay on screen, section views, mass and centre of gravity, drawings.

---

## Backlog, not planned in detail

| Item | Note |
|---|---|
| Share by link | Encode a small project in the URL fragment (deflate + base64url). Agreed with the owner early on and still wanted. Assets are too large for a link. |
| Parameter panel | Sliders for top-level variables with OpenSCAD customizer comments (`// [0:0.05:1]`), fed through `-D`. |
| Faster evaluation | A pool of two or three OpenSCAD workers for projects with many part files. |
| Exact `rotate_extrude` | Revolve the `Flat` leaves. Needs faces, so needs the wire recipe with shared vertices and arcs. |
| Exact geometry mixed with faceted in one part | Boolean an exact solid with a meshed one. OCCT booleans on thousands of facets are slow and can fail. |
| `offset` over booleans | Needs real 2D faces and a 2D offset the kernel wrapper does not expose. |
| Limits on closing joints | A closing joint's travel is not limited today. |
| Collision check | Highlight parts that overlap in the current pose. |
| IGES import | Not available in `occt-wasm` 5.17.2. |

---

## Appendix. Starting point for the fan folder assembly

This is a sketch for the acceptance checks of phases 2 to 4. **It has not been run.** It follows the positions in `ff_assembly()` of the v3.3.1 file. The names are that file's own. Expect to adjust signs and offsets once it is on screen: compare against the file's own `part = "assembly"` view at `crank_manual = 0`, 90, 180 and 270.

```scad
include <label_fan_folder.scad>
part = "none";            // the design file now draws nothing by itself
crank_manual = 0;         // the design's own pose: its formulas are evaluated at crank 0

// ----- parts, each drawn about its own pivot -----
part("frame") {
    translate([0, 0, z_drive_in]) ff_plate("drive");
    translate([0, 0, z_idle_out]) ff_plate("idle");
    for (p = ties) translate([p[0], p[1], z_idle_in]) ff_tube(tie_d, channel_w, tie_hole);
    translate([entry_pos[0], entry_pos[1], z_idle_in]) ff_tube(entry_d, channel_w, tie_hole);
}
part("drum") {                                   // pivot: the drum axis, the file's origin
    translate([0, 0, z_c - drum_len/2]) { ff_drum_body(); translate([0, 0, drum_len - flange_t]) ff_drum_cap(); }
    translate([0, 0, drum_shaft_z[0]]) ff_dshaft(drum_shaft_z[1] - drum_shaft_z[0]);
    translate([0, 0, z_gear[0]]) ff_gear_drum();
}
part("crank") {                                  // pivot: the crank axis, moved to the origin
    translate([0, 0, z_gear[0]]) ff_gear_crank();
    translate([0, 0, z_disk[0]]) ff_crank_disk();
    translate([0, 0, crank_shaft_z[0]]) ff_dshaft(crank_shaft_z[1] - crank_shaft_z[0]);
    translate([0, 0, guard_depth + handle_gap]) ff_handle();
}
part("coupler") ff_coupler();                    // pivot: its first hole
part("rocker") {                                 // pivot: the chute axis O4; rocker and chute share a shaft
    translate([0, 0, z_gear[0]]) ff_rocker();
    rotate(-psi_mid) translate([0, 0, z_c - chute_w/2]) ff_chute();
}
part("roller") translate([0, 0, z_c - roller_len/2]) ff_roller();

// ----- joints -----
joint("crank", type = "hinge", parent = "frame", child = "crank", at = [G[0], G[1], 0], value = 0);

joint("drum", type = "hinge", parent = "frame", child = "drum",
      follow = "crank", ratio = -gear_ratio);                      // 2:1 gears, opposite sense

joint("crank_pin", type = "hinge", parent = "crank", child = "coupler",
      at = [crank_r, 0, z_coupler[0]]);

joint("chute", type = "hinge", parent = "frame", child = "rocker",
      at = [O4[0], O4[1], 0], value = psi_mid);                    // starting guess for the loop

joint("rocker_pin", type = "hinge", parent = "coupler", child = "rocker",   // closes the four-bar
      at = [coupler_len, 0, 0], child_at = [rocker_len, 0, z_coupler[0]]);

joint("roller", type = "slider", parent = "frame", child = "roller", axis = [0, 1, 0],
      follow = "drum", table = [for (a = [0 : 2 : 360]) [a, ff_roller_y(a)]]);
```

Notes for whoever tries it:

- The design draws the machine in the XY plane and turns it upright with `rotate([90, 0, 0])` at the very end. The sketch leaves it flat. Add `rot = [90, 0, 0]` to `part("frame")` if an upright view is wanted.
- `ff_roller_y` takes the drum angle with the design's sign (`drum_deg = -gear_ratio * crank_deg`). The table's input is the `drum` joint value, which has that same sign, and wraps over 360.
- The design's gears are drawn already meshed at crank 0 (`spin_drum_gear`, `spin_crank_gear`), so no phase offset should be needed.
- `show_labels` only matters in the exploded view, so `text()` (F8) is not reached.
