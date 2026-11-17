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

`part(name, file, at, rot, color)` adds one part; the shapes can also be written in braces, as below. Two parts can use the same file. `at` and `rot` place a part that no joint carries. `joint(name, type, parent, child, at, rot, axis, limits, value)` hangs the child from the parent. `at` and `rot` give the joint's position and orientation in the parent's coordinates, in the same order as `translate(at) rotate(rot)`, and the child's origin sits on the joint. `type` is `"fixed"`, `"hinge"` (turns about `axis`, in degrees) or `"slider"` (moves along `axis`, in millimetres). `limits` bounds the travel and `value` is the pose the model opens in.

The preview shows a slider for each moving joint. Moving a joint repositions the built parts and recalculates no geometry, so it stays quick on integrated graphics and in the software preview. **Export STEP** writes an assembly with one named, coloured component per part, in the pose shown. STEP carries the positions and not the joints.

### Parts written in place

A part does not need its own file. Put its shapes in braces after `part()`:

```scad
part("base") cube([40, 30, 6]);
part("arm", color = "#c0604c") { translate([0, 0, 6]) cube([8, 8, 40]); }
part("motor", "nema17.scad");        // a part from its own file still works
```

Give `part()` a file or braces, not both. A shape drawn outside every `part()` is an error. Do not wrap a `part()` call in `translate()` or another operation; put the move inside the braces, or use `at` and `rot`. A part's shapes are taken as written, so its origin is the file's origin, and a joint places that origin (or `child_at`). If the braces hold a `color()`, the part takes that colour unless `part()` is given one. Two parts with identical shapes share one solid.

This also turns a design kept in one file into an assembly without splitting it up. Include the file, assign `part = "none"` after the include so the file draws nothing of its own, and call its modules inside `part()`:

```scad
include <machine.scad>               // draws one thing at a time, chosen by a variable called part
part = "none";                       // the last assignment wins

part("drum") { drum_body(); translate([0, 0, drum_length]) drum_cap(); }
part("coupler") coupler();
```

All the inline parts come from a single evaluation of the file, however many there are. A part that is faceted adds one short meshing run when it changes. An edit rebuilds only the parts whose shapes changed.

Shared dimensions go in a file such as `params.scad` that each part starts with `include <params.scad>`. Pin a tab to keep **Run** building the assembly while a part file is open. An edit rebuilds the solids whose geometry changed and reuses the rest.

Open the **Swivel arm assembly** example to see four parts, two hinges and a slider.

## Linkages and closed loops

Joints are read in the order they are written. A joint that links two groups of parts not yet connected carries one from the other. A joint between parts that are already connected closes a loop. In a four-bar linkage three hinges carry the crank, the coupler and the rocker, and the fourth hinge closes the ring:

```scad
joint("crank",      type = "hinge", parent = "ground",  child = "crank",   at = [0, 0, t], value = 40);
joint("crank_pin",  type = "hinge", parent = "crank",   child = "coupler", at = [crank_length, 0, t]);
joint("rocker",     type = "hinge", parent = "ground",  child = "rocker",  at = [ground_length, 0, t], value = 100);
joint("rocker_pin", type = "hinge", parent = "coupler", child = "rocker",
      at = [coupler_length, 0, 0], child_at = [rocker_length, 0, t]);
```

`child_at` and `child_rot` say where a joint sits on the child when that is not the child's origin. A part with two joints needs them on at least one.

A closing joint has no slider. The joints around its loop move together to keep it shut. Drag any of them, or press play on one: a hinge without `limits` keeps turning, and any other joint runs back and forth. A move stops where the loop can no longer stay shut, such as the end of a rocker's swing or a piston's dead centre. The solver takes small steps from the current pose, so a linkage stays in the form it was assembled in.

In a loop, the first joint with a `value` is held when the model opens, and the `value` of any other joint is a starting guess. A guess picks between the forms a linkage can assemble in, such as open and crossed. If the links cannot reach each other, the build output names the closing joint and the gap that is left.

Hinges, sliders and fixed joints can all close a loop, so slider-cranks and scissor mechanisms work the same way. Travel limits apply to the joints that have sliders and not to closing joints. Gears, cams, mates solved from faces, and collision checks are unavailable in this version. Open the **Crank-rocker linkage** example to watch a crank turn fully while its rocker swings.

## Geometry and precision

Anything OpenSCAD can render builds: `linear_extrude`, `rotate_extrude`, `hull`, `offset`, `minkowski`, `polyhedron`, `scale`, `resize`, and every `$fn`, `$fa` and `$fs` setting. Use OpenSCAD variables, functions, local modules, conditionals and loops to define the part. The examples cover a drilled plate, an open enclosure, a tapered spacer and a spherical seat.

A part is built one of two ways, and the build output says which:

- **Exact.** A part made only of `cube`, `sphere`, `cylinder` (including a cone or frustum), `translate`, `rotate`, `mirror`, `union`, `difference`, `intersection`, `color` and `render` is rebuilt in OpenCascade with true planes, cylinders, cones and spheres. This is what the STEP file contains. Curves stay smooth at any `$fa` and `$fs`; only `$fn` above zero asks for visible facets.
- **Faceted.** Any other part is meshed by OpenSCAD itself and shown as it is. For STEP the mesh is sewn into a valid solid and triangles in one plane are merged, so the file has flat faces and no true curves. Faceted STEP files are large, about 4 KiB per face. The build output names each faceted part and the operation that caused it, for example `chute.scad uses hull`.

A part may hold several separate bodies. A file that draws only flat 2D shapes needs `linear_extrude`. `text()` fails because no fonts are bundled. Imports are unavailable in this version. The geometry worker runs the official OpenSCAD evaluator and keeps the solids for the current build. The Three.js view draws a mesh of each part and the STEP writer uses the solid itself. An edit invalidates export until the new revision builds. Keep the SCAD file as the parametric source.

The OpenSCAD CSG format serializes numeric values to six significant digits. Expect that precision before CAD operations, including translations and rotation matrices. The bridge restores matrix orthogonality within the serialization tolerance. `include` and `use` reach other files in the same project, and BOSL2 (below). Joint positions are passed with 0.000001 mm resolution.

Each job has a 60-second deadline and the user can cancel it. Input is limited to 256 KiB per file, 40 files and 1 MiB per project, 200 parts per assembly, and 200,000 evaluated nodes and 16 MiB of evaluated geometry text per part. Designed for modest mechanical parts on laptops with integrated WebGL2 graphics, the 4 GB system memory target needs measurement on physical hardware. The examples and controls are available in a single tab. A future v2 can move the geometry worker protocol to an optional remote service.

### Libraries

BOSL2 is bundled. Write `include <BOSL2/std.scad>` and, for example, `include <BOSL2/gears.scad>`, and gears, threads, screws and the rest of the library build. Other libraries are unavailable in this version, and the build output names any include it cannot find.

- **Download.** The library is a 1.2 MiB zip, fetched the first time a project includes it during a visit. Projects that do not include BOSL2 never download it.
- **Speed.** Each OpenSCAD run that includes BOSL2 takes about a quarter of a second longer to read it. A part file per part means one run per file, so for a machine with many parts prefer `part("name") ...` in one assembly file (see above), which evaluates once.
- **Faceted.** BOSL2 gears come out as `linear_extrude` of a polygon and threads as `polyhedron`, so those parts are faceted and their STEP files have flat faces, as described above. The build output names each faceted part. A gear's tooth flanks are short straight segments, and its top and bottom faces are flat.
- **Version.** The zip holds the top-level `.scad` files of BOSL2 commit `ca677d0`, unmodified, with its BSD-2-Clause license. `npm run libraries` rebuilds it from that commit.

## Validate

`npm run check` checks TypeScript. `npm test` runs both WASM kernels against the example parts and the example assembly, writes STEP fixtures in `.test-output/`, and exercises failure cases. The assembly test reads the exported STEP back and compares every part's position with the pose solved for the preview. The loop tests turn a crank-rocker through a full revolution and compare the rocker's swing and a slider-crank's piston position with their closed-form values. The fixture test checks previews, dimensions, volume, units, analytic surfaces and parameter regeneration. Run `test/verify_in_freecad.py` with a Python environment where FreeCAD's `FreeCAD` and `Part` modules can be imported to check the exports independently in FreeCAD.

## License

The Partscript application source is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE) and [third-party notices and corresponding source](public/licenses/NOTICES.txt). The OpenSCAD and OpenCascade engines are distributed as separate WebAssembly modules.
