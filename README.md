# Partscript CAD

Partscript CAD is a browser workbench for parametric CAD written as code. Write parts as SCAD files, connect them with joints, move the joints, and download a STEP AP214 file in millimetres. Nothing is installed on the computer that uses it: the site is static files and every calculation runs in the browser tab. The editor reopens its last project from local browser storage. Use **Save project** to download every file as one `.partscript.json` file that a teammate can open.

## Use it without installing anything

The people who use Partscript need a browser and the site's address. Hosting it needs no installation either:

1. Create a repository on github.com and upload the contents of this directory with **Add file → Upload files**. Include the `.github` folder.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The included workflow builds, tests and publishes the site. The address appears under **Settings → Pages**. Each later upload publishes again.

Any static host works the same way: upload the built `dist/` directory. The site cannot be opened from a folder on disk with `file://`, because browsers load workers and WebAssembly over HTTP only.

## Run locally

Install Node.js 24, then run these commands in this directory.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite in a recent desktop Chrome or Edge browser. WebGL2 provides hardware accelerated drawing. The viewport can also draw in software when WebGL2 is unavailable. Use Ctrl/Cmd+Enter to build and Ctrl/Cmd+S to download the source.

Run `npm run build` to produce `dist/`. Serve that directory over HTTP or HTTPS from a static host. The `.wasm` files use the `application/wasm` content type. The generated source archive is in `dist/source/`. The site's initial build downloads two CAD engines, about 30 MiB combined before HTTP compression. Each engine asset is under 25 MiB. CAD jobs and draft storage run in the browser.

## Assemblies and joints

Write each part in its own file, with the point it pivots or slides on at the origin. A further file lists the parts and connects them. It is ordinary OpenSCAD, so it can use variables, loops and `include`:

```scad
include <params.scad>

part("base", "base.scad");
part("arm", "arm.scad", color = "#c0604c");

joint("lift", type = "hinge", parent = "base", child = "arm",
      at = [0, 0, pivot_height], axis = [0, 1, 0],
      limits = [0, 90], value = 30);
```

`part(name, file, at, rot, color)` adds one part. Two parts can use the same file. `at` and `rot` place a part that no joint carries. `joint(name, type, parent, child, at, rot, axis, limits, value)` hangs the child from the parent. `at` and `rot` give the joint's position and orientation in the parent's coordinates, in the same order as `translate(at) rotate(rot)`, and the child's origin sits on the joint. `type` is `"fixed"`, `"hinge"` (turns about `axis`, in degrees) or `"slider"` (moves along `axis`, in millimetres). `limits` bounds the travel and `value` is the pose the model opens in.

The preview shows a slider for each moving joint. Moving a joint repositions the built parts and recalculates no geometry, so it stays quick on integrated graphics and in the software preview. **Export STEP** writes an assembly with one named, coloured component per part, in the pose shown. STEP carries the positions and not the joints.

Shared dimensions go in a file such as `params.scad` that each part starts with `include <params.scad>`. Pin a tab to keep **Run** building the assembly while a part file is open. An edit rebuilds the solids whose geometry changed and reuses the rest.

A part hangs from one joint, so the joints form a tree. Closed loops such as four-bar linkages, mates solved from constraints, and collision checks are unavailable in this version. Open the **Swivel arm assembly** example to see four parts, two hinges and a slider.

## Geometry and precision

Use `cube`, `sphere`, `cylinder` (including a cone or frustum), `translate`, `rotate`, `mirror`, `union`, `difference`, and `intersection`. Use OpenSCAD variables, functions, local modules, conditionals and loops to define the part. The examples cover a drilled plate, an open enclosure, a tapered spacer and a spherical seat.

Each part file must produce one connected valid solid. The geometry worker runs the official OpenSCAD evaluator, parses its constructive solid geometry tree and builds analytic surfaces in OpenCascade. The worker keeps the validated solid for the current build. The Three.js view draws a mesh of this solid and the STEP writer uses the solid itself. An edit invalidates export until the new revision builds. The STEP file contains the geometry. Keep the SCAD file as the parametric source.

The OpenSCAD CSG format serializes numeric values to six significant digits. Expect that precision before CAD operations, including translations and rotation matrices. The bridge restores matrix orthogonality within the serialization tolerance. Explicit `$fn`, `$fa` and `$fs` assignments are rejected because they can specify intentional facets. The worker also rejects unavailable operations, file imports, external libraries, non-rigid transforms and the `%` background modifier. `include` and `use` reach other files in the same project. Joint positions are passed with 0.000001 mm resolution.

Each job has a 60-second deadline and the user can cancel it. Input is limited to 256 KiB per file, 40 files and 1 MiB per project, 200 parts per assembly and 2,000 evaluated nodes per part. Designed for modest mechanical parts on laptops with integrated WebGL2 graphics, the 4 GB system memory target needs measurement on physical hardware. The examples and controls are available in a single tab. A future v2 can move the geometry worker protocol to an optional remote service.

## Validate

`npm run check` checks TypeScript. `npm test` runs both WASM kernels against the example parts and the example assembly, writes STEP fixtures in `.test-output/`, and exercises failure cases. The assembly test reads the exported STEP back and compares every part's position with the pose solved for the preview. The fixture test checks previews, dimensions, volume, units, analytic surfaces and parameter regeneration. Run `test/verify_in_freecad.py` with a Python environment where FreeCAD's `FreeCAD` and `Part` modules can be imported to check the exports independently in FreeCAD.

## License

The Partscript application source is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE) and [third-party notices and corresponding source](public/licenses/NOTICES.txt). The OpenSCAD and OpenCascade engines are distributed as separate WebAssembly modules.
