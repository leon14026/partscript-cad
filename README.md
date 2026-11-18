# Partscript CAD

Partscript CAD is a browser workbench for parametric CAD written as code. Write parts as SCAD files, connect them with joints, move the joints, and download a STEP AP214 file in millimetres. Nothing is installed on the computer that uses it: the site is static files and every calculation runs in the browser tab. The editor reopens its last project from local browser storage. Use **Save project** to download every file as one `.partscript.json` file that a teammate can open.

**New to it?** Read the [manual](docs/MANUAL.md). It covers the page, the OpenSCAD you need, every argument of `part()` and `joint()`, importing STEP and STL files, measuring, exact and faceted parts, and what to do when a build fails. The site serves it as `manual.html`, linked from the header. `npm run manual` writes that page from the Markdown, and `npm run dev` and `npm run build` do it for you.

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

To see inside a machine, open **Parts** in the preview toolbar and untick a part, such as a gear guard or a side plate. The part leaves the picture, the toolbar says how many are hidden, and **Show all** brings them back. A part stays hidden through a rebuild for as long as it keeps its name. Hiding changes the preview only: **Export STEP** still writes every part. A part that should be hidden on its own needs its own `part()`, so write a cover or a bracket as a separate part and fix it to the frame with a `fixed` joint.

On a phone, under 711 pixels wide, the page shows the preview or the code, one at a time, with a switch under the header, and the file buttons move behind a **⋯** button. The joint sliders fold into a **Joints** button, every button is at least 44 pixels, one finger turns the model, a pinch zooms it, and a tap reads a size in Measure.

To read a size, press **Measure** in the preview toolbar and click. A face reads its area, a hole or a shaft its diameter and length, an edge its length (and its diameter when it is a circle or an arc), and a corner its position. Click a second thing and the card also gives the distance and the angle between the two: the centre-to-centre distance of two holes (click the hole walls or their rims), the distance between two parallel faces, the angle between two faces, or the shortest distance between any two exact parts of the model. Values are in millimetres, square millimetres and degrees, to 0.001 and 0.01, each with a copy button, and they are read in the pose shown: move a joint and the numbers follow. A line is drawn for a distance when the line is the distance. **Esc** clears the picks, a second **Esc** leaves the tool, and playing a joint is off while a measurement is shown. A faceted part offers areas and corners only; its edges and curves are made of triangles, so they are not measured.

### Starting a project
**New** replaces the project with one blank file, `part.scad`, after asking if there are unsaved changes. Add files with the **+** beside the tabs, import STEP and STL files with **Open**, and keep the work with **Save project**. A project has no name of its own: the zip is named after the file Run builds, so pin your assembly file (the pin on its tab) before you save.

### Importing STEP and STL files
Press **Open** and choose a `.step`, `.stp` or `.stl` file, such as a motor or a bearing from GrabCAD or a supplier. It becomes a tab in the project, kept exactly as it was opened. The tab shows the file's size and, after a build, how many solid bodies it holds and how big it is; **Show on its own** builds it by itself so you can look at it and measure it. To use it in an assembly, write `part("motor", "nema17.step");` and connect it with `joint()` like any other part. A STEP keeps its true curves, so it exports as it came, and its faces, edges and holes can be measured. An STL is a mesh with no units, read as millimetres, so it exports with flat faces. Inside a `.scad` file, `import("bracket.stl");` reads an STL of the project too. Files in a CAD program's own format (`.sldprt`, `.ipt`, `.f3d`, `.x_t`) and IGES files cannot be read: download or export the STEP version. One file can be up to 40 MB and a project up to 120 MB of them. A very large STEP can take a long time to read (about a second a megabyte here), and a part with thousands of faces is previewed with coarser curves to stay quick; the STEP export is not affected.

**Save project** writes a `.partscript.zip` with every file, imported ones included, and a `partscript.json` that remembers which file Run builds. **Open** takes that zip, and still takes the older `.partscript.json`. It opens only `.scad` files, `.step`, `.stp` and `.stl` files, and project zips, and says so when you choose anything else. Imported files are kept in the browser's draft storage between visits too.

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

Hinges, sliders and fixed joints can all close a loop, so slider-cranks and scissor mechanisms work the same way. Travel limits apply to the joints that have sliders and not to closing joints. Mates solved from faces and collision checks are unavailable in this version. Open the **Crank-rocker linkage** example to watch a crank turn fully while its rocker swings.

## Gears and cams

A joint can follow another. Give it `follow` with the other joint's name. A gear pair is a `ratio`. A cam, or any motion that a formula gives, is a `table` of `[input, output]` rows that OpenSCAD computes when the model is built:

```scad
// The drum turns twice per crank turn, the other way round
joint("drum", type = "hinge", parent = "frame", child = "drum", follow = "crank", ratio = -2);

// The roller rides the drum: its height comes from the design's own function
joint("roller", type = "slider", parent = "frame", child = "roller", axis = [0, 1, 0],
      follow = "drum", table = [for (a = [0 : 1 : 360]) [a, roller_height(a)]]);
```

Without a table the follower's value is `offset + ratio × driver`, and `ratio` is 1 and `offset` is 0 when left out. With a table it is `offset + ratio × output`, where the output is read from the table in straight lines between rows. A table needs at least two rows and at most 5,000, and the inputs must increase from one row to the next. Past the first or last row the output stays at that row's value. The exception is a hinge that turns without end, one with no `limits` or one that follows another hinge. When the table's inputs run exactly 360 apart, such as 0 to 360, the driver's angle is wrapped into that range, so a cam goes round and round.

A follower has no value of its own. It takes no `limits` and no `value`, and the page shows it as a read-only row under the sliders, naming the joint it follows. Followers can follow followers. The joint a follower follows can be part of a closed loop, so one crank can drive a four-bar and a gear train at once. A follower cannot be part of a loop itself. Use a whole-number `ratio` for a hinge that turns fully, because any other ratio makes the follower jump when the driver comes round to its start. Gear teeth are not simulated, so the ratio is the gear pair, and the teeth are drawn to mesh at the pose the model opens in. Open the **Gears and a cam** example.

## Geometry and precision

Anything OpenSCAD can render builds: `linear_extrude`, `rotate_extrude`, `hull`, `offset`, `minkowski`, `polyhedron`, `scale`, `resize`, and every `$fn`, `$fa` and `$fs` setting. Use OpenSCAD variables, functions, local modules, conditionals and loops to define the part. The examples cover a drilled plate, an open enclosure, a tapered spacer and a spherical seat.

A part is built one of two ways, and the build output says which:

- **Exact.** A part is rebuilt in OpenCascade with true planes, cylinders, cones and spheres, and that is what the STEP file contains. Exact parts are made only of:
  - `cube`, `sphere`, `cylinder` (including a cone or frustum), `translate`, `rotate`, `mirror`, `union`, `difference`, `intersection`, `color` and `render`. Curves stay smooth at any `$fa` and `$fs`. A `cylinder` with `$fn` above zero and equal radii is a prism with that many flat sides. The part is still exact, but its STEP holds a polygon where a hole or pin was meant, so the build output reports it: an error from 16 sides up, and a log line for fewer (a hexagon is often meant). It names the file and the line where `$fn` is set. Leave `$fn` out for true cylinders and round holes.
  - `scale`. One factor on all axes keeps flat faces flat. Different factors on the axes (`scale([1, 2, 3])`) are exact in size, but the faces of a scaled part become spline surfaces. A shear, a zero factor or a negative factor is faceted.
  - `linear_extrude` of a flat shape, without `twist` or `scale`. The flat shape may use `circle`, `square`, `polygon` (with holes, not crossing itself), `union`, `difference`, `intersection`, `hull` of convex shapes, `offset` of any of these (`offset(r)` rounds corners and `offset(delta)` keeps them sharp, in or out), and `translate`, `rotate`, `mirror` and `scale` with one factor. Round parts of the outline become true cylinders, so a hole is round in STEP. An extrusion may take up to 400 pieces (a square counts one, a circle two, a slot three), and a polygon up to 1,500 points per outline. A plate with dozens of round windows and slots is fine.
  
  When a part uses an extrusion, a `$fn` prism or a scale, the build compares it with OpenSCAD's own mesh of the same shapes made at fine resolution: the volume must agree within 0.3% and each side of the bounding box within 0.05 mm. If it does not, the part is faceted instead and the build output says so, so a bug in the exact builder can cost smooth curves but never a wrong shape.
- **Faceted.** Any other part is meshed by OpenSCAD itself and shown as it is. The common causes are `hull` of 3D shapes, `rotate_extrude`, `minkowski`, `polyhedron`, a twisted or tapered `linear_extrude`, an `offset(chamfer = true)`, a `hull` of a shape that is not convex, and more than 400 pieces in one extrusion. Threads and other `polyhedron` parts are faceted, and a thread has thousands of faces, so its STEP file is large. For STEP the mesh is sewn into a valid solid and triangles in one plane are merged, so the file has flat faces and no true curves. Faceted STEP files are large, about 4 KiB per face. The build output names each faceted part and the operation that caused it, for example `chute.scad uses hull`.

A part may hold several separate bodies. A file that draws only flat 2D shapes needs `linear_extrude`. `text()` fails because no fonts are bundled. The only import is an STL or STEP file of the project (see above). The geometry worker runs the official OpenSCAD evaluator and keeps the solids for the current build. The Three.js view draws a mesh of each part and the STEP writer uses the solid itself. An edit invalidates export until the new revision builds. Keep the SCAD file as the parametric source.

The OpenSCAD CSG format serializes numeric values to six significant digits. Expect that precision before CAD operations, including translations and rotation matrices. The bridge restores matrix orthogonality within the serialization tolerance. `include` and `use` reach other files in the same project, and BOSL2 (below). Joint positions are passed with 0.000001 mm resolution.

Each job has a 60-second deadline and the user can cancel it. Input is limited to 256 KiB per file, 40 files and 1 MiB per project, 200 parts per assembly, and 200,000 evaluated nodes and 16 MiB of evaluated geometry text per part. Designed for modest mechanical parts on laptops with integrated WebGL2 graphics, the 4 GB system memory target needs measurement on physical hardware. The examples and controls are available in a single tab. A future v2 can move the geometry worker protocol to an optional remote service.

### Libraries

BOSL2 is bundled. Write `include <BOSL2/std.scad>` and, for example, `include <BOSL2/gears.scad>`, and gears, threads, screws and the rest of the library build. Other libraries are unavailable in this version, and the build output names any include it cannot find.

- **Download.** The library is a 1.2 MiB zip, fetched the first time a project includes it during a visit. Projects that do not include BOSL2 never download it.
- **Speed.** Each OpenSCAD run that includes BOSL2 takes about a quarter of a second longer to read it. A part file per part means one run per file, so for a machine with many parts prefer `part("name") ...` in one assembly file (see above), which evaluates once.
- **Exact and faceted.** BOSL2 gears come out as `linear_extrude` of a polygon, so a gear is exact: a prism of its tooth outline, with flat flanks and flat top and bottom faces. A gear has no shaft hole unless asked for. The `shaft_diam` option cuts one, but BOSL2 draws it as part of the outline with a coarse polygon (16 sides for an 8 mm hole), so it is not a true cylinder in STEP. For a round bore, subtract your own `cylinder(d = 8, h = 20, center = true)` from the gear instead. Threads come out as `polyhedron`, so those parts are faceted and their STEP files have flat faces, as described above. The build output names each faceted part.
- **Version.** The zip holds the top-level `.scad` files of BOSL2 commit `ca677d0`, unmodified, with its BSD-2-Clause license. `npm run libraries` rebuilds it from that commit.

## Validate

`npm run check` checks TypeScript. `npm test` runs both WASM kernels against the example parts and the example assembly, writes STEP fixtures in `.test-output/`, and exercises failure cases. The assembly test reads the exported STEP back and compares every part's position with the pose solved for the preview. The loop tests turn a crank-rocker through a full revolution and compare the rocker's swing and a slider-crank's piston position with their closed-form values. The page check hides a part, rebuilds, and shows it again, and compares the drawn picture each time. The follower tests check a ratio, a table read between rows, a table that wraps, a chain of followers and a gear wheel that follows the crank of a closed linkage through a full turn, and read the exported STEP back to see each follower where its formula puts it. The extrusion tests build plates, slots, rounded rectangles, offsets and real machine parts, compare each volume with a value worked out by hand, check that the STEP keeps true cylinders, and check that a wrong exact build is caught and the part comes back faceted with the reason. The manual test builds every example in `docs/MANUAL.md`, checks that each error message printed there is the one the build gives, and compares the `part()` and `joint()` argument tables and the limits with the code. The fixture test checks previews, dimensions, volume, units, analytic surfaces and parameter regeneration. Run `test/verify_in_freecad.py` with a Python environment where FreeCAD's `FreeCAD` and `Part` modules can be imported to check the exports independently in FreeCAD.

## License

The Partscript application source is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE) and [third-party notices and corresponding source](public/licenses/NOTICES.txt). The OpenSCAD and OpenCascade engines are distributed as separate WebAssembly modules.
