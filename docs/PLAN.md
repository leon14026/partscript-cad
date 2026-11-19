# Partscript CAD: build plan

Written 16 November 2026 for whoever continues this project, human or model. It covers thirteen phases. Phases 9, 8 and 10 are done (the owner's order of 17 November 2026: 9, then 8, then 10). Phase 8 was tested on the owner's iPhone on 18 November 2026, and Phase 10 is built and checked, and the owner has tested it (the test log in the status notes of 18 November 2026; a GrabCAD assembly is still to try). Phase 11 (collision detection) was added on 18 November 2026 and built the same day, and Phase 12 (drawings) was added then as a proposal and built on 18 November 2026 at the owner's request (not committed yet; his tests are pending). Phase 13 (Partscript as an MCP server for Claude and ChatGPT) was added the same day as an optional proposal.

1. Any OpenSCAD geometry builds (faceted fallback)
2. Many parts from one file (inline parts)
3. Driven joints: gear ratios and cam tables
4. The BOSL2 library
5. Exact extrusions (true cylinders and flats in STEP)
6. Import STEP and STL files, such as GrabCAD downloads
7. Measure tool
8. Phone viewer mode (done, tested on the owner's iPhone 18 November 2026)
9. User manual: how to use the site and how the syntax works (done)
10. Open an assembly STEP as separate parts (built and pushed 18 November 2026; the owner's tests passed, except a GrabCAD assembly he has not tried yet)
11. Collision detection, in a pose and while a joint moves (built and pushed 18 November 2026; the owner's tests passed; what the v3 overlaps are is pending his decision)
12. Drawings: export each part as a dimensioned sheet (built 18 November 2026, not committed; the owner's acceptance is pending)
13. Partscript as an MCP server for Claude and ChatGPT (optional, proposed, not started)

Phases 1 and 2 come first, in that order. After them, phases 3 to 7 are independent and can be done in any order. Each phase ends in a working, tested, releasable site.

### Status

- **Phase 1: done (17 November 2026).** Differences from the text below, so later phases read true: `BuiltModel.solids` is now `BuiltModel.entries` (each an exact solid or a faceted mesh, see `CachedSolid` in `build.ts`). `unsupported()` returns a descriptive reason, for example `hull`, `scale` or `cylinder with $fn`. `meshToSolid` in `solid.ts` uses `sew` and `makeSolid` per shell, not `sewAndSolidify` (F18). `summary.ts` holds the sentence about faceted parts. The tests are `test/mesh.test.ts` and `test/faceted.test.ts`.
- **Phase 2: done (17 November 2026).** `partTag(name)` in `assembly.ts` is the hash. `nodeTag(node)` in `csg.ts` reads a render node's tag. `PartSpec` gained `inline` and `colorGiven`, and `file` is optional. A part wrapped in `translate()` or another operation is an error. The tests are the last six in `test/assembly.test.ts`.
- **Phase 4: done (17 November 2026).** Differences from the text below: `scripts/fetch-libraries.mjs` fetches the pinned commit with `git`, not an archive link, because git reads work where `codeload.github.com` is refused. The zip holds 56 `.scad` files plus `LICENSE` (57 files, 1.22 MiB). `checkProject` now returns the library names a project includes. `ModelBuilder` takes a third argument, a `LibraryLoader`, and mounts only the libraries that project includes in every evaluation run (never in the mesh runs, which read a CSG dump). The worker's loader is `loadLibrary` in `geometry.worker.ts`; the tests use `test/libraries.ts`. A BOSL2 file name that does not exist is reported by name. `fflate` is now a runtime dependency, so its license joins `npm-licenses.txt`. Step 7 (fonts for `text()`) was not done: the owner's v3.3.1 views, `exploded` included, do not call `text()` in their default settings.
- **Phase 3: done (17 November 2026).** Differences from the text below: follower values are not written into the pose (`toPose` skips followers). `placeParts` and `jointValues` derive them with `resolveFollowers`, so the preview, the sliders and the STEP export always agree with the driver and a stale value in a pose cannot disagree with it. `followerStates(assembly, pose)` gives the page each follower, its driver and its value. A hinge that follows another counts as turning without stops, so a 0 to 360 table wraps behind it (the roller behind the drum). More errors than the text lists: a follower that is a fixed joint, a driver that is a fixed joint or unknown, a joint that follows itself, a driver that closes a loop, and `ratio`, `offset` or `table` without `follow`. `parseEcho` reads tokens with a sticky pattern, because slicing a 5,000-row table made it quadratic. The example is `gearedExample.ts` ("Gears and a cam"). The tests are the last nine in `test/loops.test.ts`. `scripts/smoke.py` checks the two follower rows and that they change when the crank plays. A fractional `ratio` on a fully turning driver makes the follower jump at the wrap; the README says to use whole numbers.
- **Parts menu (17 November 2026, after testing phases 3 and 4 on the owner's fan folder).** A **Parts** menu in the preview toolbar hides parts from the preview so the owner can see the gears behind the guard. Preview only: STEP still writes every part. `createViewer` keeps the hidden names (`setHidden`), so a rebuild keeps a part hidden while it has the same name; `Viewport.tsx` forgets names that no longer exist. `SoftwarePart.hidden` leaves a part out of the CPU renderer, including its edges. The check is in `scripts/smoke.py`: it compares the drawn canvas before and after hiding, after a rebuild, and after Show all. Breaking `applyHidden` on purpose makes it fail. The owner's fan folder needed the guard and the two brackets written as their own parts, which the Parts menu cannot split out of a part by itself.
- **Phase 5: done (17 November 2026).** Differences from the text below, so later phases read true:
  - New files `src/engine/flat.ts` (the `Flat` evaluator, pure) and `src/engine/extrude.ts` (`extrudeFlat`, `prism`, `regularPrism`); `extrusion(node)` returns `{height, center, flat}` or `{reason}`, and `unsupported()` calls it, so the two always agree. `csg.ts` gained `moveKind` (rigid, uniform, axes, invalid, other) and `needsCheck`. `placement(input, factor)` in `solid.ts` replaces `rigidMatrix`.
  - **Superseded by follow-up 2 below (the guard is 400 and the work runs on faces).** The guard is `maxLeaves = 100`, not 300. Cost follows overlap: chained overlapping slots cost about 30 ms per leaf, disjoint holes much less. The v3 crank disk is 148 leaves (the plan guessed 93 circles); at 300 it took 9.3 s exact, at 6.5 s after sharing cylinders and one `fuseAll`, so it stays faceted (about 1 s).
  - The check is `#agrees` in `build.ts`; the reason is `mismatchReason` = "an exact build that did not match OpenSCAD's mesh" (it reads after "uses"). Any exception inside a checked tree falls back the same way. A tree of plain solids skips the check and its errors still surface. `ModelBuilder` takes a fourth argument, `buildExact` (default `buildSolid`), so a test can supply a wrong or throwing builder.
  - Evaluator details: a polygon with holes needs the largest ring to be the outer one and the holes strictly inside it and disjoint; a ring over 1,500 points or 30,000 in total is unsupported ("polygon with many points"); `hull` takes convex shapes or unions of them; `offset` takes convex shapes in this first commit and any flat shape after the follow-up below, never with `chamfer`; unequal axis scale uses `generalTransform` (spline faces) and is checked.
  - Reasons added to `unsupported()`: `linear_extrude with twist`, `linear_extrude with scale`, `linear_extrude with more than 100 shapes`, `polygon that crosses itself`, `polygon with several outlines`, `polygon with many points`, `hull of a shape that is not convex`, `offset with chamfer`, and the operation name for anything else in 2D. (`offset of a shape that is not convex` was a reason in the first commit; the follow-up removed it. An `offset` the kernel cannot shrink is not a reason of `unsupported()`: it fails inside the builder, and the part is faceted with the check's reason.)
  - Expectations in the text below that turned out wrong (rule 10): `drum_cap` and `tray_half` offset a union, which this phase first left faceted; the follow-up below makes them exact; `dancer` is exact, not faceted; a STEP of the v3 drum body is 287 KiB, not under 200 KiB (the plan's number was an estimate; the faceted file is 1,109 KiB).
  - **Follow-up, same day: `offset` over any flat shape.** `Flat` gained `{kind: 'offset'}`. A convex outline is still offset in 2D as before. Anything else (a union, a difference, a concave polygon, rounded convex shapes with `delta`) is built as a solid: extrude the inner shape taller, offset the solid with `kernel.offset` (Arc join for `offset(r)`, Intersection join for `offset(delta)`), clip back to the height. Facts the kernel imposed (F25): the offset comes back as shells, to be closed with `makeSolid`; it fails on a compound, so each body goes by itself and the results are fused (the same as offsetting the union); a shrink that removes a body returns a null shape, but the kernel also returns null for bodies it cannot shrink, so a null counts as "vanished" only when the body is narrower than twice the shrink, and otherwise throws and the part is meshed. v4 is now 23 of 30 views exact and v3 27 of 36; newly exact are `drum_cap` (123 KiB STEP, was 491 KiB) and `tray_half` (132 KiB). Tests m to r in `test/extrude.test.ts`: hand volumes on an L-shaped polygon for `delta` and `r`, in and out, and for rounding corners; unions and differences against the fine mesh; and test r, which keeps a small body inside a frame that only the builder's own rule can save (the check would miss it under 0.3%), and fails if the rule is weakened.
  - **Superseded by follow-up 2 below: the plate windows are exact now.** **The plate windows stayed faceted at first.** `offset(r = 3) offset(delta = -3)` over the grid of windows needs 134 and 110 shapes, over the guard, and with the guard lifted the kernel returns null for 12 of the 27 bodies wide enough to survive (any with a thin web, and a circle cut by a straight line). The part then falls back, as designed. Tried and dropped: other tolerances and heights, round joins, turning each cylinder's seam into the shape, quarter cylinders. What would do it is a 2D offset of wires (`offsetWire2D`), which has to build faces from wires with arcs and could not be built from circle wires (cookbook, section 3). Not started.
  - **Polyhedron support was not built, because it would not help.** The two heavy v3 parts that report `polyhedron` are BOSL2 threads: the bracket cuts a 3,822 point, 5,400 triangle `threaded_rod(internal = true)` out of an otherwise exact body, and the thumbscrew is an 11,132 triangle rod. The weight is those triangles (STEP 8.9 and 19.9 MiB), not the rest of the part. A helix cannot be rebuilt as an exact surface from triangles, so making the polyhedron a solid in a mixed part still leaves thousands of faces in the file. The text of this phase, and my own earlier note, were wrong to expect a gain.
  - v3 assembly after the first follow-up (follow-up 2 changes this): STEP 48.0 MiB (was 51.3), export 22.9 s, build 13.5 s (was 10.8 s: more parts try the exact path and are checked). What is left is `frame` (the plates, over the guard), `crank` (the 148-shape crank disk) and the two brackets (threads).
  - `renderMesh` now collapses single-child `group()` nodes first (`flattenGroups`, F24), because BOSL2 dumps nest 141 levels and the browser sometimes ran out of stack in the mesh run.
  - The tests are `test/extrude.test.ts` (27, 32 after follow-up 2) plus updates in `faceted`, `libraries` and `mesh`: 88 tests in all, 93 after follow-up 2, about a minute. The older faceted tests now use inputs that still go down the faceted path: a tapered extrusion, a sheared matrix, a cone with `$fn`, a hull, a twisted extrusion and a sphere with `$fn`.
  - **Follow-up 2, same day: the 2D work runs on faces, so plates and the crank disk are exact.** The owner opened the v3 assembly STEP in Onshape and found the crank handle and the frame faceted. `extrudeFlat` no longer builds a solid for every leaf of the 2D shape. `flatFace` in `extrude.ts` builds the 2D shape as faces in the plane z = 0 (a polygon face, a disc face from `makeFace(makeWire([makeCircleEdge(...)]))`), combines them with `fuseAll`, `cutAll` and `intersect` on faces, merges with `unifySameDomain`, and extrudes the finished face once. An `offset` is done on the wires of each face with `kernel.offsetWire2D` (F28): the outline by `amount`, each hole by `-amount`, Arc joins for `offset(r)` and Intersection joins for `offset(delta)`; the new wires become faces again, holes are cut out, and a body that shrinks away leaves no wire. The kernel's solid offset, with its null results for thin webs and D shapes (F25), is no longer used, so the rule that treated a null as "vanished" is gone. `maxLeaves` is now 400. Measured on the owner's v3 assembly file, same machine: `plate_drive`, `plate_idle` and `crank_disk` build exact and agree with OpenSCAD's fine mesh (so the check passes, no change to it); STEP 29.7 MiB against 48.0 MiB, export 15 s against 36 s (both including the re-import check), 479 cylindrical surfaces against 92, 23 solids, valid, volume 985,880.85 against 985,888.10 (round windows are a little larger than polygon ones: 0.0007%); build 21 s against 13.5 s, because three more parts now try the exact path and are checked. Views that build exact: v4 26 of 30 (was 23; the four left are the `hull` parts and the two views that contain them), v3.3.1 31 of 36 (was 27; left: `assembly`, `exploded`, `chute` for 3D `hull`, `bracket` and `thumbscrew` for threads), and the owner's current file 31 of 35 (left: `bracket`, `thumbscrew`, and `assembly` and `exploded` because they contain the brackets). Tests q and r were rewritten with hand volumes (their old subject, the kernel failing to shrink a solid, is gone) and s to w are new: 135 round holes (135 cylinders in the STEP), a chain of 20 overlapping slots that becomes one slot with 6 faces, opening a square with a hole, a body that vanishes and a neck that splits, and plate windows against the fine mesh. Tests q, r, t and u fail when the hole cut, a size filter or the final merge is taken out. Slowest case at the guard: a ring of 120 overlapping slots takes 5.9 s, 240 slots 27 s (F28).
  - Live since 17 November 2026 (commits `7f7d8ad` and `b9c50a3`). Before that push the browser smoke test built the 7 examples in the Examples menu and the 3 snippets it types in itself (a hull, two inline parts with a hinge, a BOSL2 gear) without a problem, in normal mode and in software mode. (It prints one Playwright traceback, `Dialog.accept: Cannot accept dialog which is already handled`, from a leftover `page.once('dialog')` listener in `scripts/smoke.py`. It is harmless: the exit code is 0 and no example is reported.)
- **Fixes after the owner tested phases 6 and 7 (17 November 2026).** (1) Esc was ignored while a joint slider had keyboard focus, so Measure stayed on; only text and number fields hold Esc now. Esc also takes two presses by design (the first clears the picks, the second leaves Measure), and the Measure hint now says so. (2) **Open** accepts only `.scad`, `.json`, `.zip`, `.step`, `.stp` and `.stl`. Any other file, such as a web page, is refused with a message that names the file and says what to open. Before, it was opened as OpenSCAD and gave "Parser error: syntax error". (3) The asset panel no longer says "STEP, exact geometry" or offers Show and Copy for a file that could not be read. (4) The not-closed STL message reads once: `... (3 open edges), so STEP has flat faces. A mesh that is not closed has no exact volume, and STEP export may fail.` Tests: still 125 (an assertion was added to the open-mesh test). `scripts/smoke.py` gained a slider-focus Esc check and a "bad files" check.
- **`$fn` report (17 November 2026, from the owner's backlog item).** A `cylinder` with `$fn` above zero and equal radii, and a `circle` with `$fn` in an extrusion, are flat-sided prisms in an exact part, so STEP holds a polygon where a hole was meant while the build said "exact". `flatRounds(nodes)` in `csg.ts` counts them with the same rule as `solid.ts` and `flat.ts`, `build.ts` stores the side counts on the exact part's `PartMesh.flatRounds`, and `flatRoundNotes` in `summary.ts` writes the text. The owner chose the levels: always report, as an **error from 16 sides** (`flatRoundErrorSides`), only a **log line below 16** (a hexagon is often meant). An error does not stop the build: the part still shows and exports, like an open loop, and the output turns red with the text `part.scad: 6 cylinders or circles are 48-sided polygons in STEP, not true round (set on line 3). Delete $fn for true cylinders and round holes.` The line comes from searching the part's own file for `$fn` (the CSG dump has no line numbers); a value from an include or a library names no line. A part that is faceted for another reason is not reported, since its faceted reason already is. Tests: `test/rounds.test.ts` (11). `scripts/smoke.py` gained a "round notes" check.
- **Phase 10, open an assembly STEP as parts, is built (18 November 2026) and pushed (commit `62e754f`); the owner tested it on 18 November 2026 (the test log below), and a GrabCAD assembly is still to try.** The owner's go-ahead was "do phase 10 first". What exists, so later work reads true:
  - **`src/engine/stepTree.ts`** reads a STEP through XCAF (`readStructure`, `pickComponent`, `pickBody`, `fileSolids`) and `SelectionError` is its error. `build.ts` opens the XCAF document once for each file used by a build (`docs`, closed in a `finally`), stores the structure by the hash of the file (`#structures`), and reports it in `ModelPreview.steps` (one `StepStructure` for each STEP the parts use: `bodies`, `components`, `unlisted`). A part's solid is cached by `step:<hash>#component=<path>` or `#body=<n>`; a whole file keeps its old key.
  - **`part(name, file, at, rot, color, component, body)`.** `component` is a name or a slash path, `body` counts leaf solids from 1 in file order. Both are for STEP files only and not together. A part keeps the place the file gives it (nested places are composed from the top, F38) and its colour (`color` still wins). A whole-file part still takes its colour from `color` or the palette, which the plan's text below did not say. `assembly.ts` reads them as fields 8 and 9 of the record.
  - **Asset panel.** A STEP with two or more components lists them: swatch, name indented by depth, bodies, size, body numbers, an eye button (build that component alone, from a part line `App.tsx` writes into a file that is not in the project, `_component.scad`) and a copy button. Past `maxListed` (500) components the rest are counted, not listed. The facts of the whole file come from a part that uses the whole file, otherwise from the structure.
  - **Differences from the plan text below (rule 10).** No new worker command: the structure rides in `ModelPreview`. `scad.ts` and `csg.ts` did not change, because `part()` is read from the prelude record. The structure is read when a build uses the file, not when the file is opened, so a tab shows its parts after the first build that uses it (**Show on its own** does that). The old "hang" was not reproduced (F37), so step 1 found nothing to avoid. A placeholder name such as `=>[0:1:1:2]` is treated as no name, and sibling names that repeat get a number (`SOLID`, `SOLID 2`).
  - **Tests (`test/import.test.ts`, seven new, 191 in all):** the swivel arm round-trips by name, colour and volume; a hinge at 30 degrees puts the arm's box where a hand calculation does; `component` and `body` pick the right solid and `at` moves it; the error messages; a file with no structure; nested paths (a mutation that drops the parent's place makes it fail: 90.5 against -9.8); a two-part hinge exported, reopened with `component` and compared at 0, 15, 30 and 90 degrees. The manual's new examples are built by `test/manual.test.ts` (`assembly` marks the ones that need `fixture.step`).
  - **Not done:** the smoke test of the asset panel list on the page (see the checks in the commit) and a GrabCAD assembly with real structure (the NEMA file he has is flat: 9 components named 1 to 9). The owner has since tried his own motor, face plate and base (18 November 2026, passed).
- **Phase 9, the user manual, is done (17 November 2026).** `docs/MANUAL.md` has twelve sections and 40 code examples. `scripts/manual.ts` is a small Markdown renderer that knows only what the manual uses and throws on anything else, so a construct it cannot draw is found by a test and not by a reader. `npm run manual` runs it through `scripts/build-manual.ts` and writes `public/manual.html`, which is not committed: `predev` and `prebuild` run it, Vite copies it into `dist/`, and the Pages workflow gets it from `npm run build`. No dependency was added. The header has a **Manual** link and the Help dialog links to the page. `test/manual.test.ts` (44 tests) reads the manual: it builds every `scad` block; a `scad error` block must fail with exactly the message printed under it; a `scad says` block must give exactly the build output printed under it (the faceted sentence and the `$fn` report); the gear and cam block must equal the shipped example; the `part()` and `joint()` signatures and every argument and default in the tables are compared with the prelude in `assembly.ts`; and the Limits table is compared with the constants in the code. `scripts/smoke.py` gained a "manual" check (the header link, the Help link, and the page with twelve numbered sections). Writing it found two weak messages (the backlog has them). The test also caught the manual's own first draft listing `child_at` and `child_rot` before `axis`: the order in the code is `... at, rot, axis, limits, value, child_at, child_rot, follow, ...`, so the manual shows that order and tells the reader to write the argument names.
- **Phase 8, phone viewer mode, is done (18 November 2026).** Steps 2 to 6 are live (`51bae3a`, `0381d56`) and step 1 was done by the owner on his iPhone the same morning. What exists, so later work reads true:
  - **Narrow means `max-width: 710px`.** `.workspace` carries `data-view="preview|code"` and shows one pane (`.source-pane` or `.preview-pane`). A `.view-switch` nav (two 44 px buttons, Preview first) sits between the header and the workspace; the Code button shows a red alert while the last build failed. Choosing an example switches to the preview. In Preview view the `.output-message` is inside the hidden source pane, so a browser wait for it must use `state='attached'`.
  - **Header.** New, Open, Save file, Save project and Manual are in a `.file-actions` menu opened by a `.more-button` (the three dots). On a wide screen `.more-menu` and `.file-actions` are `display: contents`, so nothing changes there. The hidden file input lives outside the menu. Esc or a tap outside closes it.
  - **Preview.** The Joints panel starts collapsed on a narrow screen (`matchMedia` in `Viewport.tsx`) and opens as a sheet at most 58% of the preview high. `.view-angles` is a column at the right; the Parts menu is a full-width sheet; the Examples list scrolls. Every button, tab, summary, input and range is at least 44 px; number inputs use 16 px text so iOS does not zoom. `Drag to orbit · Scroll to zoom` is hidden, `Drag to orbit · Pinch to zoom` shows under `pointer: coarse`, and the Measure hint says tap.
  - **Touch.** OrbitControls already gave pinch zoom and a two-finger pan. `viewer.ts` tracks the pointers that are down, so a pinch or two-finger gesture never picks in Measure, and `pointercancel` clears them. The joint slider clears its drag on `pointercancel`.
  - **Checked with touch emulated, in WebGL and in software mode:** a pinch changes the picture (the model fills about 5 times the pixels when pinched out); a one-finger drag orbits; a tap on the rim of a hole in the Mounting plate reads Diameter 5; a pinch adds no pick; a finger drag on a joint slider and a tap on Play move the joint; no horizontal overflow at 390 and 360 px; no target under 44 px in the states the smoke test visits. `scripts/smoke.py` runs this as `check_phone` (390 x 844, touch). Targets inside a closed `<details>` are skipped, because Chrome still reports a box for them.
  - **First test on the owner's iPhone (18 November 2026, after the push of `51bae3a`), and the fixes for it.** (1) The open Joints sheet covered the model entirely: it was an overlay up to 58% of the preview, drawn over the centre where the model sits. It is now a strip along the bottom (`--sheet`, 44% of the stage, 168 to 236 px, scrolling), and `.preview-stage:has(.joints.open) .canvas-host` loses that height, so the model is framed in what is left (the viewer's `ResizeObserver` refits an orthographic camera to the new height). `check_phone` fails if the canvas runs under the sheet or is under 200 px high. (2) The iOS file picker greyed out a `.STEP` from GrabCAD, so Open could not choose it. Probable cause: iOS matches files to the types it derives from `accept`, and it does not know `.step` or `.stp`. `App.tsx` now sets no `accept` when `(pointer: coarse)` matches, and `openFiles` still refuses non-CAD files. Not confirmed on an iPhone at the time of writing. The smoke test checks the attribute and that an upper-case `.STEP` with a non-Latin name opens as a `.step` tab. (3) He reported that the label fan folder zip opens with no problem and faster than on his laptop. That is part of step 1; He also said `swivel_arm` loads fast, and that a NEMA 17 STEP (Kingroon, 413 KB, 9 bodies, 20,440 preview triangles) loads in under 5 seconds. These are his estimates, not stopwatch numbers, and they are enough to say a phone needs no size warning for these files. (4) In Code view the **+** that adds a file could not be tapped: the tab strip was capped at 100 px, a phone tab is 44 px, and six tabs (the swivel arm project) or two with a long STEP name wrapped the **+** onto a third row that scrolled out of reach. On a narrow screen the tabs are now one row that scrolls sideways, tabs do not shrink, names stop at 16 characters, the **+** is `position: sticky` at the right edge, and the open tab is scrolled to the left edge (`scrollIntoView` in `App.tsx`). `check_phone` fails if the **+** is not hit-testable (with six tabs and with a long imported name) or if a file added with it does not open as the selected tab in view.
  - **Not checked, needs a real phone:** how a fingertip lands against the fixed 6 px and 8 px picking radii near an edge, and the feel of the slider (he said joints and the model look right, and has not reported on Measure by tap). A phone in landscape that is 711 px or wider still gets the desktop layout.
- **The backlog was reorganised (18 November 2026).** It is now a grouped list with IDs B1 to B11 and a rough size, at the end of this file. Nothing in it is started without the owner's go-ahead. The owner dropped IGES import for now, so it sits under "Dropped for now".
- **Phase 11, collision detection, is built (18 November 2026) and pushed (commit `e53a4d1`); the owner tested it on 18 November 2026 (the test log below), and what the v3 overlaps are is pending his decision.** The owner's go-ahead was "run phase 11, then I'll test both phases at the same time". What exists, so later work reads true:
  - **`src/collision.ts`** (pure, like `picking.ts`). Stage 2: `trianglesCross`, `meshesOverlap` (two bounding volume hierarchies walked together, then the nested test by ray parity), `bodyPoints`. `CollisionChecker` holds the broad stage, the rigid groups (parts joined by fixed joints, and all root parts, never move relative to each other, so their pair is tested once and kept in a cache keyed by the relative matrix) and the counts (`stats`, `byPair`). `sweepJoint` (the motion check, bisecting each start and end to 0.01 degree or 0.001 mm and keeping up to five probe poses of each stretch) and `clearMove` (Stop at collision). `overlapFloor` (0.01 mm³), `touchDepth` (0.001 mm) and `sampleMove` (0.5 mm) are exported, and the manual test compares them with the text. `picking.ts` exports `bvhOf`, with leaves of 3 triangles (was 6; F40).
  - **Stage 3.** `ModelBuilder.collide(model, tests, budgetMs = 40 s)` returns the `common` volume of each pair of each pose (`null` for a faceted side, a failure or the budget), a `collide` command in `protocol.ts` and the worker, and `BrowserGeometryEngine.collide`. `App.tsx` sends measure and collide through one queue (`query`), so one does not turn the other away.
  - **`allow_overlap(a, b)`** is in the prelude (`echo(["@partscript", "allow", a, b])`), `AssemblySpec.allowed` holds the pairs, and its errors name the call, not a line (the echo carries none).
  - **The page.** `Viewport.tsx` checks at every pose while rendering (`useMemo`), asks the worker 250 ms after the pose stops, and drops a pair whose exact volume is under the floor. A card at the top right (the bottom on a phone) names each pair and its volume; the viewers tint the parts (`setCollisions`: an emissive red in WebGL, `SoftwarePart.tint` in software) and draw the crossing lines in yellow. **Check motion** is a magnifier button on each joint row: the sweep runs on the page, yields every 30 ms to show its progress and take a stop, then asks the worker about up to five poses of each stretch in chunks of 12 (a 45 s budget), and lists the stretches (a click sets the joint to the start of one). **Stop at collision** is a tick box under the joints, off by default, kept on the page. The toolbar counts pairs allowed. A model of over 600,000 triangles is not checked at every pose.
  - **Differences from the plan text below (rule 10).** (1) The sweep runs on the page and not in a worker (F40: 28.2 s for a full crank turn on the v3 machine, which a worker would not shorten). (2) The mesh stage sees an overlap from 0.001 mm (`touchDepth`), so first contact reads 15.0015 for a slider that meets at 15 (F42); the plan's tolerance of 0.001 mm is 0.002 in the test. (3) The volume in a stretch is the largest of up to five exact poses, so the card says "in the worst of 5 poses checked". (4) The floor stays at 0.01 mm³ (F41). (5) The F30 shaft test uses true circles, and a second case, 5.099 turned half a side, is the mesh false positive that stage 3 removes (F42). (6) While a joint moves, the tint comes from the preview mesh, and the exact answer arrives 250 ms after it stops, so a pair that only touches can show red for that moment.
  - **Tests.** `test/collision.test.ts` (16), `test/manual.test.ts` (a new section title list and a signature and numbers test), and `scripts/smoke.py` (`check_collisions`: the red tint, the card with 500 mm³, Reset, Check motion and a click on its line, Stop at collision typed and played, `allow_overlap`), run in both modes.
  - **Not done:** what the v3 overlaps are (F41); the owner said on 18 November 2026 to log it as pending. His tests on the v3 machine passed.
- **Phase 12, drawings, is built (18 November 2026) and not committed; the owner's acceptance is pending.** His go-ahead was "run phase 12 before i run the rest of the tests", so he will test it together with his remaining tests (18, 21 and the v3 overlap decision). He has not given a reference drawing yet, so nothing in the layout is checked against one. What exists, so later work reads true:
  - **`src/drawing/`** (all pure except `views.ts`, which runs in the worker with the kernel). `types.ts` (the plain data the worker returns: `PartDrawing`, `ViewData`, `HoleData`, `SectionData`, and the `Sheet` that the writers read), `views.ts` (hidden-line projection, `readFeatures` reading holes and turned steps from the cylinder faces, `makeSection`), `mesh.ts` (`meshView`, views of a faceted or merged mesh), `frames.ts`, `layout.ts` (sheets, scale steps, `placeViews`), `dimensions.ts` (overall sizes, hole callouts, ordinates, hatching, turned diameters), `sheet.ts` (`buildSheet`, `buildSheets`, `buildAssemblySheet`, border and title block), `assembly.ts` (`assemblyView`: parts list, balloons), `font.ts`, `layers.ts`, `svg.ts`, `pdf.ts`, `dxf.ts`, `export.ts` (`exportDrawings`, zip for several SVG or DXF sheets), `options.ts` (`readDrawingOptions`, `titleFieldLimit` 40). `ModelBuilder.draw(model, pose)` returns the plain data and caches it per build; a `draw` command and `BrowserGeometryEngine.draw` follow the Measure pattern. The sheet is built on the page, so choosing another sheet, projection or title field never goes back to the worker.
  - **The page.** `src/components/DrawingDialog.tsx` (a form of sheet, projection, hidden lines, drawn by, date, revision and material, a "Sheet shown" list, the list of what a sheet leaves out under "Not on this sheet", and PDF, DXF and SVG buttons with an "All n sheets" box). The button is beside Export STEP on a wide screen and behind the ⋯ menu on a phone (the header had no room: the first smoke run found the page 23 px wider than a 390 px screen). The settings are `Project.drawing`, saved in the zip's `partscript.json`, in the older JSON and in the draft, and read back with `readDrawingOptions`, so a file with a bad or missing value opens with the default.
  - **Differences from the plan text below (rule 10).** (1) *Scale.* The plan said the largest scale that fits. Built: it starts at 1:1 and goes down (1:2, 1:5 ... 1:50), and a part whose longest side is under 20 mm starts at 10:1, because the plan's own test needs the 40 x 30 x 5 plate of F15 at 1:1 and "the largest that fits" would draw it at 5:1 or more. The isometric has a scale of its own. (2) *Room for the views is the sheet above the title block, full width.* An 80 x 80 x 22 mm base therefore comes out at 1:2 on ANSI A, where a packer that let a view run beside the title block could draw it at 1:1. Known limit; the owner's reference drawing may change it. (3) *Faceted parts* are drawn from the preview's own edges (`edgeSegments`, the 28 degree rule) and silhouettes, not from the kernel's hidden-line removal, which answers the plan's question about matching against the preview's crease set (F47). (4) *Hidden lines in "when there are few"* are drawn only for exact parts that are not imported, in a view with 150 hidden curves or fewer, and never on the isometric. (5) *The assembly sheet* is an isometric of the merged posed meshes, and a balloon's anchor is found with a depth buffer (260 px) of that picture, not with the ray cast in `picking.ts`; a part that cannot be seen gets a dashed leader. (6) *A section* is made only for a blind or counterbored hole, through the axis of the first one; a hollow part with no such hole does not get one (the plan left this to step 1). (7) *Hole callouts* are stacked in at most six rows above a view (`maxCalloutRows`). On a crowded view a leader can cross another callout's text, and a callout with no row left is named in the notes and not drawn (F44). (8) *The dialog has no part picker.* It shows one sheet at a time (a list) and downloads all of them or the one shown. (9) *A job over 60 s is not split by part.* The first `draw` of the v3 machine takes 9 s (F44), so it was not needed.
  - **Not done:** a reference drawing (waiting on the owner); the Measure comparison of sizes (the sizes are checked by hand-worked numbers in the tests); chamfer, fillet and slot dimensions, tolerances and the other things the plan lists as out of scope.
  - **Tests.** `test/drawing.test.ts` (17) and `test/drawing_formats.test.ts` (6), a test in `test/manual.test.ts` (the section's numbers and its example match the code), and `scripts/smoke.py` (`check_drawing`: the example part's callouts and section in the dialog, the three downloads, A4, an assembly and a zip, and the title fields after a reload; `check_drawing_phone`: the dialog fits a 390 px screen with 44 px targets), run in both modes. 242 tests in all.
- **Phase 13, Partscript as an MCP server, was added to the plan as optional (18 November 2026).** Nothing is built and nothing is measured. The owner asked whether it could be a connector in Claude and a plugin in ChatGPT. Both are a remote MCP server at an HTTPS address (ChatGPT's name for them keeps moving: connectors, then apps, and "Plugins" in some menus; the 2023 plugin system is gone), so one server serves both, and the engine already runs in Node, which the tests prove. The catch is hosting: `CLAUDE.md` says "Static site, no backend", and this phase is the first that needs one, so the owner decides where it runs, who may use it and which ChatGPT plan he has before step 2. What was read about each product comes from search results, with the sources named in the phase, and the ChatGPT plan rules disagree between sources. Step 1 re-reads and measures.
- **Two requests while the owner was testing phases 10 and 11 (18 November 2026), built and pushed (commit `1782143`).** The owner said he had started testing, that it seemed to be going well, and that no acceptance step is to be marked as passed until he has done it properly; none was marked at that point; the next note has what he ran afterwards. (1) **A switch for collision detection.** A **Collisions** button in the preview toolbar (shown for a model with two or more parts, on by default, kept in the browser under `partscript.collisions`) turns the whole check off. Off means `Viewport.tsx` builds no `CollisionChecker`, so there is no live check, no red, no card, no exact confirmation, and `Check motion` and `Stop at collision` are hidden; turning it off also stops a motion check that is running. The code does not hold the setting and `allow_overlap` does not change it. (2) **Add a `.scad` file without replacing anything.** What happened: **Open** joins a `.scad` file to the project, but a single `.scad` file replaces a project that has only one file (`replaceDocument`), so adding to a one-file project replaced it. Open keeps that behaviour (it is what a first-time user expects). A new file button beside the **+** on the tabs adds `.scad`, `.step`, `.stp` and `.stl` files and never replaces: `addFiles` in `src/project.ts` gives a name that is taken the next free number (`arm.scad` becomes `arm_2.scad`) and the page says so; a `.zip` or `.json` project is refused with a message that points to Open. The new file opens as the active tab, so the notice says that Run builds the open file unless one is pinned. `test/addfile.test.ts` (6 tests) and the smoke test cover it, 217 tests in all. The smoke test now names the Open input, because the page has two file inputs.
- **The owner's manual tests, first pass (18 November 2026, on the live site at `1782143`).** He started the list of 21 laptop tests and reported by message and screenshots. **A, tests 1 to 5 (collisions on the slider and the hinge, Stop at collision, `allow_overlap`): passed. B, tests 6 to 8 (the Collisions switch): passed. C, tests 9 to 12 (add a file, Open): passed.** **D (Phase 10 on the hinge):** test 13 worked once he changed `swing.step` to `part.step` in the three lines. The fault was in the test list, not the page: Export STEP names the file after the pinned entry file with `.scad` changed to `.step` (`App.tsx`, `snapshot.entry`), the entry was `part.scad`, and the list's snippet said `swing.step`. The page's message for the wrong name was `part("wall"): swing.step is not in this project.` It names the file asked for but not the files the project does have; not changed, because nobody asked. Test 14: first screenshot was the STEP's own view of the file exported at `swing` 20, which is not the step as written. Test 15: first tried with the part name changed to `lid`, which gave the right message for that edit (`joint("swing"): child "bar" is not a part. Declare it with part().`); redone with `component = "lid"` it gave `part("bar"): parts.step has no component "lid". It has: wall, bar.` and **passed**. Test 14 redone as written (the two `part()` lines with `component`, no joint, on the file exported at `swing` 20): **passed**. The page said "Built 2 parts and 0 joints", the bar sits tilted against the wall, and the readout shows Y 12.9397, which is the wall's top edge at 12 plus cos 20° for the bar's low corner below zero (worked by hand before he ran it). So D, tests 13 to 15, has passed. **E, test 16:** run on the file exported at `swing` 20 (`parts.step`), so the joint's zero is test 4's 20 degrees and every angle is 20 degrees lower. Check motion said `wall and bar overlap from 7.1° to the end of the travel of swing`, `28.79 mm³ in the worst of 5 poses checked`; Stop at collision stopped `swing` at 7.09; typing 27.10 gave 27.3 mm³ and 28.0963 gave 26.87 mm³. Worked by hand: contact starts where 20 sin θ + cos θ = 10, which is 27.0963° total, so 7.0963° here; and once the bar's end is clear of the cut (θ above about 39.6°) the overlap is 20 / sin θ mm³, so 27.10 here (47.1° total) is 27.30, 28.0963 (48.0963° total) is 26.87, and 28.79 is 20 / sin 44°. All agree. The card's figure is the worst of the poses it sampled, not the peak: the peak is 31.1 mm³ at 40° total (joint 20°, which is test 4's figure), and 28.79 is lower, so no sampled pose was there. **Passed.** **F, test 17 (motor, face plate and base):** the assembly was given to him again as one file with the face plate and base inline (the owner's copy was lost; it is the bracket written for him on 17 November 2026, `value = 0`), built in Node first (no overlaps at tilt 0, 10, 20 and 30; the reopened export places every part identically to the original at tilt 10, 20 and 30, matrix difference 0). He exported at tilt 0, opened the 831 KB STEP (12 components, 11 bodies, 111.91 cm³, `original` with its nine solids, `faceplate`, `base`), wrote three `part()` lines with `component` plus the hinge and the fixed joint, and the page said "Built 3 parts and 2 joints in 505 ms". The overall size reads 60 × 70.5 × 65.6 mm at tilt 0 and 60 × 93.5535 × 83.6869 mm at tilt 30, which is what the original assembly gives (93.5535 and 83.6869, computed in Node the same way the readout is). The test list said "one hinge"; the motor needs the fixed `motor_mount` joint as well, or it stays behind when the face plate tilts. **Passed.** **F, tests 19 and 20 (the v3 machine, the drag with Collisions on and off, Check motion on the crank, Stop at collision with Play):** he reported both as passing, in one line, with no timings or screenshots, so the 16 ms a pose and 28 s a sweep (F40) are still my Node numbers and not his. He did not say what the frame and drum, drum and roller, and crank and coupler overlaps are in his design, so that decision is **pending**: he said to log it as pending for now (the first Phase 11 box). Each pair is one of three things: a fault in the design to fix, a meant fit to allow with `allow_overlap`, or an overlap that comes from how the scratch assembly splits the machine into parts. **Test 18 (a GrabCAD assembly) and test 21 (the manual): not done yet.** Two acceptance boxes are ticked by this: the Phase 10 round trip of the motor, face plate and base (test 17) and the Phase 11 live check and sweep on his v3 machine (tests 19 and 20). The boxes still open are a GrabCAD assembly with several components for Phase 10, and the overlap decision for Phase 11.
- **Phase 7: done and live since 17 November 2026 (commit `df6cb0a`, with phase 6).** Differences from the text of the phase below, so later work reads true:
  - New files `src/engine/measure.ts` (`measure(kernel, parts, picks)`: reads an exact part from its placed sub-shapes and a faceted part from its mesh; types `MeasurePick`, `Reading` and `MeasureResult` live in `protocol.ts`) and `src/picking.ts` (page side: `pickAt`, `castRay`, a bounding volume hierarchy per part, `toScreen`, `viewRay`; pure, so Node tests drive it). `PartMesh` gained `faceOf` (face or region per triangle), `edgeOf` (edge per line segment, empty for a faceted part) and `corners` (x, y, z of each corner). `ModelBuilder.measure(model, pose, picks)` wraps the call in `checkpoint` / `releaseSince`; the worker answers a `measure` command and the client has `measure(revision, pose, picks)`. `App.measurePicks` refuses while a build or an export runs, and a stale preview can still be measured, because the worker keeps the last build.
  - **Expectations in the text below that turned out wrong (rule 10):** `faceGroups` are `[first index, number of indices, hash]` (three indices to a triangle), not `[triStart, triCount, faceHash]`. The plan sent faceted parts to the page; they are measured in the worker from the stored mesh, so one code path serves both kinds and the page only picks. A plane's `normal` ignores which way the face looks (the kernel's own note), so an upward face cannot be told from a downward one by it; angles are therefore reported between planes or axes, 0 to 90 degrees (`Angle`), and a test picks the top face by its height. The kernel has no closest-point call (`distanceBetween` returns a number), so there is no "line between the two closest points": the line is drawn where the distance reading has its own geometry (corner to corner; parallel faces, from the picked face's centre; parallel axes, centre to centre; axis to a parallel face; a corner to a face or an edge, only when its projection gives the kernel's shortest distance). Any other pair has the number and no line.
  - Readings beyond the table: a circular edge is an axis like a cylinder wall (two hole rims read the same 64 centre to centre as the two walls); a cone has an axis and a `Half angle` and no diameter; a straight edge is a line (`Distance between lines` when parallel); a face against an axis gives the angle, and the distance when they are parallel. `Shortest distance` (from `distanceBetween`) is on every pair of exact picks except two parallel faces that overlap, where it would repeat `Distance between faces`. Labels used by the tests: `Diameter`, `Length`, `Area`, `Half angle`, `X`, `Y`, `Z`, `Angle`, `Distance`, `ΔX`, `ΔY`, `ΔZ`, `Distance between faces`, `Centre-to-centre distance`, `Distance between lines`, `Distance from axis to face`, `Shortest distance`.
  - How it looks: a face is tinted, an edge is drawn as a wide line (three.js `LineSegments2`; two solid pixels in the software view) and a corner as a dot; the first pick is amber, the second cyan, the hover white. The dots and the line between picks show through the parts. A pick keeps the index of its face, edge or corner, so a joint move re-measures (one reading at a time, the latest wins) and the numbers follow the pose. A new build clears the picks. Playing a joint is off while anything is picked.
  - Picking: a corner within 8 px beats an edge within 6 px beats the face under the pointer; a corner or an edge behind a surface is skipped (a ray cast at its own pixel). A click that moved more than 4 px is an orbit. The hierarchy is built when the tool is turned on (or at the first pick): 180,000 triangles take 150 ms, then a ray costs 0.04 ms. The owner's v3 assembly has 68,004 triangles and 31,617 edge segments in all.
  - Numbers: the v3 assembly builds in 20.6 s (21.1 s before; the labels cost nothing measurable) and a measure call takes 1 to 4 ms for one pick and up to 50 ms for the first pair on the 547-face frame. Tests: `test/measure.test.ts` (9, with the plan's numbers and the 50 mm between the base top and the level arm top worked by hand), `test/picking.test.ts` (7, rays against every triangle, corner / edge / face priority, hidden edges, a turned part) and `test/labels.test.ts` (3, the order of faces, edges and corners against the kernel's areas and lengths, and the regions of a faceted cube and a faceted cylinder): 112 tests in all. `scripts/smoke.py` measures the mounting plate in both modes (a rim reads 5, two rims 64 apart, the top face 3121.46, Esc, Esc) and checks that a click on the swivel arm picks a part and locks the joint play buttons.
  - Not done: measuring an imported part (waits for phase 6); a wall cannot be called a hole or a shaft; a sphere and a torus offer their own sizes and nothing between pairs except the shortest distance; no dimension stays on screen.
- **Phase 6: done and live since 17 November 2026 (commit `df6cb0a`, with phase 7).** Differences from the text of the phase below, so later work reads true:
  - New file `src/engine/assets.ts` (name pattern, `assetFormat`, `unreadableFormat` for `.sldprt`, `.ipt`, IGES and other formats that cannot be read, `contentHash`, `formatBytes`) and `src/components/AssetPanel.tsx`. `ProjectFiles` stayed text-only. Assets are a separate type, `ProjectAssets = Record<string, Uint8Array>`, because a union would have touched every place that reads `.source`. `Project.files` on the page is the union (`TextFile | AssetFile`), with `toFiles` and `toAssets` splitting it for the engine. `checkProject(files, entry, assets)` still returns the libraries; `inspectProject` also returns the STL files that `import()` reads.
  - **Assets are sent once, in the build command, not by a separate command.** `{ kind: 'build', files, entry, assetNames, newAssets }`: the client remembers which arrays the current worker holds (by identity) and sends only the new ones; the worker keeps them by name and drops the names a build does not list. A cancelled or crashed worker clears the client's memory, so the next build sends everything.
  - `ModelBuilder.build(files, entry, progress, assets)`. An asset is cached by SHA-256 of its bytes and its format (`step:<hash>`), so renaming a file or opening the same bytes again rebuilds nothing, and two parts from one asset share a solid. `#exact` became `#keep`, used by both. A STEP is read with `importStep`, its solids joined in one compound (`PartMesh.bodies` counts them), stored through the BREP round trip and meshed with `previewSolid`, so measuring works on it (test and smoke check). An STL is parsed (`parseStl`: binary when the length is 84 + 50 per triangle, text when it starts with `solid`), turned around if its triangles face inward, and built faceted with the reason `an imported STL mesh`; a mesh with open edges says so in the reason and still shows.
  - **Expectations in the text below that turned out wrong (rule 10):** (1) *A retry at three times the deflection does nothing.* OpenCascade keeps the first mesh of a shape and there is no way to clear it, so the second `meshShape` returned the same 338,412 triangles. What costs time is triangles, about 9,000 a second in the browser, and the angular tolerance sets them, not the linear one. A plate of 1,800 faces and 1,200 holes (4.9 MB STEP, built here and kept outside the repository) read in 3.8 s and then meshed in 38 s at 0.18 radians (338,000 triangles), 8.5 s at 0.5 and 3.6 s at 0.8. So `previewSolid(kernel, shape, imported)` picks the fineness from the face count before meshing: up to 400 faces as every part made here (0.18), then 0.3, 0.5 and 0.8 (`importedMeshing`, tested). The same plate now imports in 13.5 s. (2) *The `import()` dump carries a modification time*: `import(file = "/m.stl", ..., timestamp = 1794958621)`. It changes on every run, so a part is keyed with the timestamp removed and the STL's hash added, and OpenSCAD runs with the STL at `/<name>`, which is where the dump looks for it. (3) STEP reading is slow: about 0.8 s per MB in the same probe, so a 40 MB STEP may not finish inside the 60 s job. Unmeasured on a real supplier file; the NEMA 17 check will tell. (4) A name's extension is lower case only in the extension: `NEMA 17.STEP` is stored as `NEMA_17.step`. (5) The `.scad`, `.step`, `.stp` and `.stl` names cannot collide, so no duplicate-name check is needed between them.
  - Page: Open takes `.scad`, `.json`, `.zip`, `.step`, `.stp` and `.stl`. A single `.scad` replaces a one-file project as before; anything else joins the project. An asset tab shows `AssetPanel` (format, size, and after a build bodies, bounding box, volume and triangles) in place of the editor, with **Show on its own** (builds that file whatever Run is set to build, without changing the pin) and a copyable `part("name", "file");` line. `Save file` downloads the original bytes. **Save project** writes `<name>.partscript.zip`: every file at the top level plus `partscript.json` (`{format, version: 2, entry, active}`), zipped and unzipped off the page's thread (`fflate` `zip` and `unzip`); `readProjectZip` also opens a zip made from a folder, ignores `__MACOSX` and a readme, and refuses a file over its limit before unpacking it. Version 1 JSON and the old one-file drafts still open (`readProject`). Limits are in `projectProblem` and in `inspectProject`: 40 files, 40 MB for one asset, 120 MB for all of them.
  - **Autosave** is IndexedDB version 2 with a second store, `assets`. The draft holds a stub for each asset and the bytes are written only when the array is a different one, so typing in a file does not copy tens of megabytes. A version 1 database upgrades and its drafts load.
  - `import()` in a `.scad` file: only a quoted name of an STL in the project passes. `import("x.step")` says to use `part()` instead; a name in a variable, a missing STL and other formats each have their own message with the file and line. `import_stl`, `import_dxf` and `surface` stay rejected.
  - Not done: step 7 (names and colours through `importXCAFFromSTEP`); an imported part takes its colour from `part(color = ...)` or the palette. Dropping files on the page is not built, only Open. The owner's NEMA 17 STEP came from GrabCAD and works (see the acceptance list).
  - Tests: `test/import.test.ts`, 13 (125 in all), covering every case the phase listed, plus the limits, the error messages, a hole measured on an imported STEP and the project zip. The browser smoke test (`scripts/smoke.py`, both modes) exports the swivel arm as STEP, opens it and an STL it writes itself, shows the STEP on its own (4 bodies), picks a face on it, uses both as parts of a hinged assembly, reuses them on the second run, reloads the page, and checks that the saved zip holds both files byte for byte.
- Open items carried forward:
  - A STEP from the v3 assembly has been opened in Onshape (good) and not yet in SolidWorks or FreeCAD.
  - Hosting: the site is public on GitHub Pages. Whether to keep it public or move it behind a login is undecided.
  - Threads (BOSL2 `polyhedron`) stay faceted and make big STEP files (F26). A smaller file needs a change in the design (a plain cylinder for the thread, or fewer thread facets), not in the engine.

Phase 5 was the hardest phase.

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
9. **Update `README.md`, the Help dialog in `src/App.tsx` and `docs/MANUAL.md`** when a phase changes what the user can do, the syntax of `part()` or `joint()`, or a build message. Remove limits the phase lifts. Do it in the same commit. `test/manual.test.ts` builds every example in the manual and compares each printed message and each argument table with the code, so a manual that has fallen behind fails the tests.
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
| `src/engine/protocol.ts` | Message and data types shared by page and worker. `CadError`. Size limits (text 256 KiB, assets 40 MB each and 120 MB in all). `ProjectFiles` (text) and `ProjectAssets` (imported bytes). |
| `src/engine/assets.ts` | Imported files: name pattern, `assetFormat`, the sentence for a format that cannot be read, `contentHash`, `formatBytes`. |
| `src/engine/scad.ts` | `checkProject` and `inspectProject` (source and asset checks; the libraries a project includes and the STL files `import()` reads), `evaluateScad` (one OpenSCAD run: files and mounted libraries in, CSG text + ECHO lines out). Appends the prelude to the entry file. `libraries` is the registry of bundled libraries (BOSL2). |
| `src/engine/assembly.ts` | The prelude (`part()`, `joint()` as OpenSCAD modules that `echo` records), record reader and validation, `structureOf` (which joints carry parts, which close loops, which follow which), matrices, `resolveFollowers`, `followerStates`, `solvePose`. |
| `src/engine/kinematics.ts` | Loop solver (Levenberg-Marquardt), `moveJoint`, `advanceJoint`, `settlePose`, `openingPose`, `loopStates`. Runs on the page, not in the worker. |
| `src/engine/csg.ts` | Parser for OpenSCAD's CSG dump. Reads every node with its character range. `unsupported()` says which parts the exact builder cannot make. `taggedParts`, `childrenText`, `firstColor` serve inline parts. |
| `src/engine/flat.ts` | Evaluates the 2D tree under `linear_extrude` into a small `Flat` tree (hulls of discs, polygons with holes, Booleans), or says why it cannot. `extrusion()` is what `unsupported()` asks. Pure TypeScript. |
| `src/engine/extrude.ts` | Turns a `Flat` into faces in the plane z = 0 (`flatFace`): polygon and disc faces combined with Booleans on faces, offsets done on wires, merged with `unifySameDomain`; `extrudeFlat` extrudes the result once. Also `prism` and `regularPrism`. |
| `src/engine/mesh.ts` | Pure TypeScript triangle meshes: binary and text STL readers (`parseStl`), `flipTriangles`, `toBinaryStl`, volume, bounds, and `toPartMesh` (flat-shaded triangles plus feature edges, and the smooth regions and corners the measure tool reads). |
| `src/engine/measure.ts` | `measure(kernel, parts, picks)`: readings for one or two picks, an exact part from its placed sub-shapes and a faceted part from its mesh. Pure apart from the kernel calls. |
| `src/picking.ts` | What the pointer is over: a ray cast per part through a bounding volume hierarchy, corners and edges by pixel distance, hidden ones skipped. Pure numbers, used by both views and by `test/picking.test.ts`. |
| `src/engine/solid.ts` | CSG tree to OCCT solid (`buildSolid`), preview mesh with its face, edge and corner numbers (`previewSolid`), faceted mesh to solid (`meshToSolid`), STEP writers (`writeStep`, `writeAssemblyStep`). |
| `src/engine/summary.ts` | The sentence and tooltip that name faceted parts. |
| `src/engine/build.ts` | `ModelBuilder`: orchestrates a build, caches solids by CSG text, exports STEP. A part is built exact or faceted. An imported STEP is an exact part, an imported STL a faceted one; both are cached by the hash of their bytes. It reads the structure of an imported STEP once (`stepTree.ts`) and answers `collide` (the exact overlap volume of pairs at poses). |
| `src/engine/stepTree.ts` | The structure of a STEP through XCAF: components, bodies, colours and places (`readStructure`), and the picks behind `part(..., component = ...)` and `body = ...` (`pickComponent`, `pickBody`). |
| `src/collision.ts` | Collision detection, stages 1 and 2 (boxes, then the preview meshes through bounding volume hierarchies): `meshesOverlap`, `CollisionChecker`, `sweepStep` (Check motion) and `clearMove` (Stop at collision). Pure numbers, like `picking.ts`. Stage 3 is `ModelBuilder.collide`. |
| `src/engine/geometry.worker.ts`, `client.ts` | Worker entry and its page-side client (one job at a time, 60 s timeout, cancel). The worker also fetches and unzips a library the first time a build includes it. |
| `scripts/fetch-libraries.mjs`, `public/engines/libraries/` | Rebuilds `BOSL2.zip` from a pinned commit (`npm run libraries`). The zip is committed. |
| `src/components/viewer.ts`, `softwarePreview.ts` | three.js viewer, and a CPU renderer used when WebGL2 is missing. Both draw one mesh per part with a matrix, and both draw the marks of the measure tool (tinted faces, wide edges, dots, the distance line). |
| `src/components/Viewport.tsx` | Preview pane, joint sliders, play button, loop status, a read-only row for each following joint, the Parts menu that hides parts in the preview, the Measure tool (button, picks, result card, Esc), and collision detection (red tint, the card, Check motion, Stop at collision, and the Collisions switch). |
| `src/App.tsx`, `project.ts`, `drafts.ts`, `src/components/AssetPanel.tsx` | Shell: file tabs (an imported file's tab shows `AssetPanel`), run, export, open/save (project zip with `fflate`), adding files without replacing (`addFiles`), autosave to IndexedDB (assets in their own store). |
| `src/examples.ts`, `assemblyExample.ts`, `linkageExample.ts`, `gearedExample.ts` | Example projects. |
| `docs/MANUAL.md`, `scripts/manual.ts`, `scripts/build-manual.ts` | The user manual, the renderer that turns it into `public/manual.html` (generated, not committed), and the script that runs it. `test/manual.test.ts` checks the manual against the code. |
| `test/*.test.ts` | Node tests that run both WASM engines. `geometry` (single parts), `faceted` (meshed parts), `labels` (face, edge and corner numbers), `measure` (readings), `picking` (rays and priorities), `import` (STEP and STL assets, project zip), `extrude` (exact extrusions and the check), `mesh` (pure functions), `assembly` (joints, inline parts, STEP round trip), `loops` (solver), `collision` (the three stages, with numbers worked out by hand), `addfile` (adding a file never replaces one), `rounds` (the report on `$fn` rounds), `manual` (the manual's examples against the code), `libraries` (BOSL2; `test/libraries.ts` reads the zip the way the worker fetches it). |

### The assembly language today

```scad
part(name, file, at = [0,0,0], rot = [0,0,0], color = undef);   // or part(name) { shapes }, no file
joint(name, type = "fixed" | "hinge" | "slider", parent, child,
      at, rot,              // joint frame in the parent's coordinates
      child_at, child_rot,  // the same frame in the child's coordinates (default: child origin)
      axis = [0,0,1], limits = [lo, hi], value,
      follow = "other_joint", ratio = 1, offset = 0, table = [[in, out], ...]);   // a following joint has no limits or value
```

Joints are read in order. A joint that links two groups of parts not yet connected carries one from the other. A joint between already-connected parts closes a loop. Numbers cross from OpenSCAD to TypeScript as `[whole, millionths]` pairs (`_ps_n`), because `echo` prints only six significant digits.

---

## 2. Facts measured on 16 and 17 November 2026

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

| F21 | The owner's v3.3.1 file builds whole with BOSL2 mounted: one faceted part, 41,032 triangles, volume 833,318.3 mm³, 277 × 214 × 346 mm. Build 5.2 s (BOSL2 evaluation 3.4 s, mesh 1.7 s, two OpenSCAD runs). STEP export 32.9 s, 40.8 MiB, re-imports as 15 solids and 10,498 faces with volume 833,318.3. Views `exploded`, `gear_drum`, `gear_crank`, `crank_disk`, `rocker`, `handle` and `thumbscrew` all build (0.5 to 5.4 s). A BOSL2 `spur_gear(mod = 2, teeth = 20, thickness = 8)` is 1.2 s, volume 9,830.5 against a hand estimate of 9,800. **The 32.9 s export is more than half of the 60 s job limit on a cloud machine; a laptop two to three times slower would exceed it.** For v4, splitting into five inline parts cut the export from 20 s to 6.2 s (F18, F20). Splitting v3.3.1 into seven inline parts does not do that (F22). | Scratch scripts, not in the repository. |
| F22 | The owner's v3.3.1 as a jointed assembly, written as a scratch file that includes it with `part = "none"`: seven inline parts (frame, tray, drum, crank, coupler, rocker, roller) and seven joints (the crank; the drum following the crank at ratio −2; the tray fixed; the crank pin, the chute shaft and the closing rocker pin of the four-bar; the roller following the drum through a 361-row table of the design's own `ff_roller_y`). Build 5.5 s, eight OpenSCAD runs, every part faceted, no warnings. The loop is closed at the opening pose (coupler −116.607°, rocker −7.136°). At crank 0, 37, 90, 180, 215, 270 and 359 degrees every part's world bounding box equals what OpenSCAD gives for the design's own `ff_assembly()` expressions at that crank angle, to within 0.0001 mm, with the loop shut each time. At 12.3, 101.7 and 333.3 degrees, where the drum angle falls between table rows, the roller is within 0.0065 mm. STEP export of the assembly at one pose: 37 to 38 s, 40.7 MiB, 20 solids, so **splitting v3.3.1 into parts does not shorten the export** (whole file: 32.9 s, F21). The 60 s limit is still the risk for this machine on a slower laptop. | Scratch scripts `v3_assembly.mjs` and `v3_assembly.scad`, not in the repository (the design file is the owner's). |

| F23 | Exact extrusions of the owner's parts, measured after phase 5 and again after its offset follow-up (OCCT kernel in Node). Views that build exact: after the first commit v4 20 of 30 and v3 25 of 36; after the follow-up **v4 23 of 30 and v3 27 of 36**. None falls back on a mismatch. A v3 drum body STEP is 287 KiB exact against 1,109 KiB faceted; `drum_cap` 123 KiB (491 KiB faceted); `tray_half` 132 KiB. The v3 assembly (23 solids, 14,623 faces, 92 cylindrical surfaces, valid) exported 58.5 MiB before phase 5, 51.3 MiB after the first commit and **48.0 MiB after the follow-up**, STEP export 22.9 s (25.7 s before), build 13.5 s (10.8 s before: more parts try the exact path and are checked). What stays faceted and why: v4 `assembly`, `exploded`, `plates`, `plate_drive`, `plate_idle` (plate windows, over 100 shapes), `motor_mount` and `chute` (3D `hull`); v3 the same plates and views plus `crank_disk` (148 shapes), `bracket` and `thumbscrew` (`polyhedron`). The heavy items of the assembly are the brackets (threads) and the plates. | Scratch scripts, not in the repository. **After follow-up 2 (same day):** the plates and the crank disk are exact too; v4 26 of 30, v3.3.1 31 of 36, the owner's current file 31 of 35; the v3 assembly STEP is 29.7 MiB with 479 cylindrical surfaces (see the status note and F28). |

| F24 | A BOSL2 part's CSG dump is nested far deeper than its shapes need: the spur gear is 141 levels, 166 of its nodes `group()` wrappers. OpenSCAD takes a level of its own stack for each, and the mesh run needs about 600 to 700 KB of the roughly 1 MB a worker has. In the browser it then failed now and then with `RangeError: Maximum call stack size exceeded` inside OpenSCAD's `invoke_*` shims, and only late in a long session (0 of 20 in a fresh page, about 3 in 10 in the full smoke sequence); Node never showed it unless `--stack-size` was lowered to 600. Phase 5 made it visible, because an exact build adds a second mesh run (the check) and a failed check adds a third. The cause is older than phase 5. `flattenGroups` in `scad.ts` removes every `group()` with a single child before each mesh run: the gear goes from 141 to 16 levels with the same volume to 15 digits, and meshes at 400 KB of stack. 14 of 14 full smoke runs pass after, 5 of 5 in software mode. | `test/faceted.test.ts` (600-deep dump) and `test/mesh.test.ts`. |

| F25 | `kernel.offset(solid, distance, tolerance, join)` offsets every face of a solid, so a flat shape is offset by extruding it taller and clipping afterwards. It returns **shells** (`getSubShapes(result, 'shell')`, then `makeSolid`; check the volume sign), refuses a compound of several bodies (so offset body by body and fuse), returns a **null shape** when a body shrinks away and also for some bodies it cannot shrink. Round (Arc) and sharp (Intersection) joins failed on the same bodies. Fails (null): a circle cut by a straight line (D shape) at any size; a body with a web thinner than twice the shrink. Works: rectangles, rounded rectangles, full circular holes, notches, slots whose ends are clear of the edges. Tolerance from 1e-7 to 1e-2 and the extra height made no difference; neither did turning the cylinders' seams or building them as quarters. Plate windows: 134 and 110 shapes; with the guard lifted 12 of 27 bodies return null. Solid offsets of the plates took 1 s, extruding them 1.3 s. **Not used any more:** follow-up 2 offsets wires instead (F28). | Scratch scripts, not in the repository. |
| F26 | The `polyhedron` in the owner's v3 parts is a BOSL2 thread. `bracket`: 3,822 points, 5,400 triangles, an internal `threaded_rod` cut out of an exact body; STEP 8.9 MiB, 2.6 s. `thumbscrew`: 6,916 points, 11,132 triangles; STEP 19.9 MiB, 5.6 s. About 1.6 KiB of STEP per triangle. | Scratch scripts. |

| F27 | A BOSL2 `spur_gear(mod = 2, teeth = 20, thickness = 8)` has no shaft hole: `shaft_diam` defaults to 0. With `shaft_diam = 8` the gear is still exact, but the hole is a 16-sided polygon in the tooth outline (removed volume 391.87 mm³ against the round hole's 402.12) and the STEP has no cylindrical surface. `difference() { spur_gear(...); cylinder(d = 8, h = 20, center = true); }` removes 402.124 mm³, the hand value, and gives one `CYLINDRICAL_SURFACE`. Plain gear 9,830.47 mm³, 2.1 MiB STEP. | Scratch script `bore_probe.mjs`, not in the repository. |

| F28 | The kernel works on faces and offsets wires, in `occt-wasm` 5.17.2. `makeFace(makeWire([makeCircleEdge(c, +Z, r)]))` **does** make a valid circular face (area 78.5398 for r = 5), and so does a wire of two lines and two arcs (a stadium, area 378.5398); `makeFace` of a bare edge throws. `cut`, `cutAll`, `fuseAll` and `intersect` work on faces and keep the area right (a 40 by 30 face minus a circle of radius 4: 1,149.7345); `kernel.extrude(face, 0, 0, h)` gives a positive volume whichever way the face or its wire runs. `kernel.offsetWire2D(wire, distance, join)` moves a wire by `distance` away from the area it encloses, whatever its direction, so a hole's wire is offset by the opposite sign to grow the material. A wire that shrinks away returns no wire (not a null shape); a neck that closes returns two wires; Arc joins round the corners that open (an L shrunk by 1 with an Arc join: 224.2146, the sharp join 224.0000, each as worked by hand). Face Booleans cost far less than solid ones: the v3 crank disk, 148 leaves, 1.1 to 1.5 s (6.5 s as solids at a limit of 300); a plate 0.35 to 0.9 s. Whole builds with the evaluation and the check against OpenSCAD's mesh: 100 disjoint round holes 1.6 s, 200 4.1 s, 400 9.9 s; a ring of overlapping slots 60 1.9 s, 120 5.9 s, 240 27 s; 300 squares opened by `offset(r = 1) offset(delta = -1)` 3.7 s. | Scratch scripts `face2d*.mjs`, `scale.mjs` and `plate_time.mjs`, not in the repository. |
| F29 | Labelling a solid for measuring, in `occt-wasm` 5.17.2. `getSubShapes(shape, 'face')`, `'edge'` and `'vertex'` come in the same order as the groups of `meshShape` (`faceGroups`, one per face, `[first index, index count, hash]`: divide by 3 for triangles) and `wireframe` (`edgeGroups`, `[first point, point count, hash]`); each face's triangle area adds up to `getSurfaceArea` within 3e-4 on a cylinder and exactly on planes, and each edge's polyline length to `curveLength`. This holds after `toBREPBinary` / `fromBREPBinary`, which is why the preview is meshed from the stored solid. `located(sub, matrix12)` places a sub-shape and **composes** with the placement it already has; `surfaceData`, `curveData` and `vertexPosition` then answer in world coordinates; `distanceBetween` of two placed shapes is correct (a hole wall to a corner 10.142 away, as worked by hand). Vectors are `{x, y, z}` objects, not arrays. A plane's `normal` ignores the orientation of its face. A BVH ray cast over 180,000 triangles: 150 ms to build, 0.04 ms a ray. | Scratch scripts `labels.mjs`, `located.mjs`, `measure_v3.mjs`, not in the repository; `test/labels.test.ts`. |
| F30 | Overlap and gap in the kernel, `occt-wasm` 5.17.2 (probe of 18 November 2026). `kernel.common(a, b)` then `getVolume` gives the overlap volume to the digit printed: two 10 mm cubes overlapping by 2 mm give 200 (hand 200), a cube 2 mm inside another gives 216 (hand 216), an overlap of 0.01 mm gives 1.0000 and of 0.0001 mm gives 0.0100. Parts that touch on a face, along an edge or at a corner, and parts that are apart, give 0 (no throw, no null shape). `distanceBetween` gives the true gap when parts are apart (3.0; a hinged bar and a wall give 9, 5.54223 and 2.21990 at 0, 10 and 20 degrees, each as worked by hand) and **0 for touching, overlapping and nested parts alike**, so a distance of 0 cannot tell contact from collision. A bar 20 × 2 × 5 mm (y from −1 to 1) hinged about z at the origin first touches a wall 40 × 2 × 5 mm (y from 10 to 12, x from −5) at 27.0963 degrees (the corner (20, 1) reaches y = 10 where 20 sin t + cos t = 10): 0.01 degree before, the gap is 0.00303 and the volume 0; 0.01 degree after, the volume is 0.0001 mm³; one degree after (28.0963) it is 0.5461 mm³, which is also the hand value 5 h² / sin 2t with h = 20 sin t + cos t − 10. A shaft of radius 5.0 in a hole of radius 5.1 gives volume 0 and gap 0.1; a shaft of radius 5.2 gives 32.3584, the hand value π (5.2² − 5.1²) 10. Each call took 1 to 55 ms on these small shapes. | Scratch script `collide_probe.ts`, not in the repository. |
| F31 | The preview mesh lies inside a round surface. `previewSolid` meshes a cylinder wall as 70 flat sides at radius 5, 10 and 40 mm and at a part span of 40, 100 and 300 mm (the linear deflection of span / 1,200 never decided it), so each chord lies r (1 − cos(π/70)), about 0.001 r, inside the true surface: 0.0050 mm at r 5, 0.0101 at r 10 and 0.0403 at r 40, measured at the midpoints of the wall's rim chords. A check on the preview mesh alone cannot decide a fit tighter than that. | Scratch script `sag_probe.ts`, not in the repository. |
| F32 | Exact overlap checks on real parts: the owner's v3 machine as a scratch assembly of eight parts (frame, guard, tray, drum, crank, coupler, rocker, roller) at its opening pose. Build 19.8 s; seven parts exact and the rocker faceted. 28 pairs, 14 with overlapping world boxes, 11 of those exact on both sides. `common` took 5 to 210 ms a pair (1.17 s for all 11). `distanceBetween` took 18 ms to **4.25 s** a pair (12.7 s for all 11; frame and crank 4.25 s, drum and crank 3.2 s, frame and drum 2.5 s). One pair overlaps: **frame and drum, 8.441 mm³**. It has not been looked at, so it is not known whether it is a fault in the design or a shaft pressed into a plate. Four pairs have volume 0 and gap 0, which is contact by design: frame and guard, frame and crank, crank and coupler, drum and roller. | Scratch script `pairs_probe.ts`, not in the repository (the design file is the owner's). |
| F33 | Hidden-line removal in `occt-wasm` 5.17.2 (probe of 18 November 2026, on solids read back from the exported STEP). `kernel.projectEdges(shape, origin, viewDirection, xAxis)` returns six compounds (`visibleOutline`, `visibleSmooth`, `visibleSharp` and the three `hidden` ones). **A category with no edges is handle 0**, and `isNull(0)` throws `Invalid shape ID: 0`, so test for 0 before using a handle. `viewDirection` points from the part toward the viewer, and the projected edges lie in z = 0 with x along `xAxis` and y along `viewDirection × xAxis`. Front is `(0, -1, 0)` with x `(1, 0, 0)`, top is `(0, 0, 1)` with x `(1, 0, 0)`, right is `(1, 0, 0)` with x `(0, 1, 0)`. These are the kernel's own front, top and right views once its camera direction is reversed (`basisFor` in `views.js`), and they show world x and z, x and y, and y and z (worked from the cross product; the top view of the base has its holes at their world x and y). Time for one view: faceplate (25 faces) 32 to 41 ms; base (33 faces) 15 to 23 ms; a block with two `$fn = 64` holes (134 faces) 19 to 28 ms; the NEMA 17 STEP (305 faces, 9 bodies) 93, 156 and 116 ms for front, top and right; a faceted ring (2,304 faces) 144 to 201 ms. Hidden edges outnumber visible ones in every view measured: base front 18 visible and 64 hidden, faceplate top 10 and 64, NEMA top 60 and 766. | Scratch script `drawing/probe.ts`, not in the repository. The faceplate and base are the two parts of the motor bracket written for the owner on 17 November 2026. |
| F34 | What the projected edges are made of (same probe). A circle seen square-on stays a `circle` edge: the base's top view has four of radius 2.25 at (±25, 6) and (±25, 56), with their centres in the view plane. A circle or arc seen at an angle comes back as a `bspline` (the faceplate's top view: 6 `line` and 4 `bspline` edges, no circle). A `$fn` hole is only `line` edges: a block with a Ø8 and a Ø6 hole, both `$fn = 64`, has 68 visible edges in its top view and all 68 are lines (64 from the hole seen square-on, 4 from the outline), and the same 68 in its front view. So hole sizes and places are read from the solid's cylinder faces (`surfaceData`: radius, axis, location), not from the projected edges. | Scratch script `drawing/probe2.ts`, not in the repository. |
| F35 | A section is a cut (same probe). `kernel.cut(shape, box)` with a box over one side of a plane, then `getSubShapes(cut, 'face')` filtered for a `plane` whose normal is the cut normal and whose location is on the plane, gives the areas to hatch, with their wires for the outline and the holes. Plane x through the middle of each part: faceplate 2 faces (3 wires, 156.39 mm²), cut 34 ms and face search 6 ms; base 2 faces (391.63 mm²), 29 and 5 ms; NEMA 17 STEP 8 faces (2,026.45 mm²), 207 and 7 ms; faceted ring 2 faces, 290 and 22 ms; the 40 by 30 by 20 block cut at x = 20, clear of both holes, 1 face of 600 mm², the hand value 30 × 20 (the other areas are not worked by hand). The hidden-line view of a cut solid took 8 to 66 ms. `kernel.sectionPlane(shape, origin, normal)` returns edges only (4 to 48 of them), no faces, so it cannot be hatched. | Scratch script `drawing/probe2.ts`, not in the repository. |
| F36 | Faceted parts in a drawing (same probe). A solid made from a mesh has its coplanar triangles merged already: `unifySameDomain` changed no face count (a hull of two cubes 10 faces, a hull of two 48-sided discs 146, a `rotate_extrude` ring 2,304). A part with flat faces draws cleanly: the hull of two cubes has 7 visible and 7 hidden edges in the front view. A part with curved faces draws every facet: the 48-sided hull 138 visible and 134 hidden, the ring 832 and 2,248. The preview already hides facet edges under a 28 degree crease (`toPartMesh`, `creaseDegrees = 28`): the ring's `edgeSegments` is empty and the 48-sided hull's holds 96 segments, its two rims. Whether the solid gives the two faces of an edge cheaply enough to apply that rule to hidden-line edges is not measured. | Scratch script `drawing/probe3.ts`, not in the repository. |
| F37 | Reading the structure of a STEP (Phase 10, 18 November 2026, Node, medians of seven cold builds of one `part()` line on the same machine, with and without `readStructure`). The owner's NEMA 17 file (`original.step`, 0.66 MB): 722 ms before, 834 ms after, so the structure read adds about 0.11 s. His 3.54 MB export of motor, face plate and base: 1,246 ms before, 1,499 ms after, about 0.25 s. Both are far under the 0.8 s a megabyte that reading the solids costs, and the spread between runs is 200 ms. Picking one component of the export: 778 ms (face plate), 893 ms (base), a body of the motor file alone 219 ms once the document was open. **The old hang did not reproduce.** The scratch script that ran for five minutes is lost; a later probe that exported all 11 solids of the export one at a time took 3.4 s, and the "hang" I thought I saw was a `head -14` that cut off the output. If it comes back, it was in a call the builder does not make. |
| F38 | Order and placement in an XCAF file (same work). `getChildren` of an assembly gives its components in file order, and a component's `getLocation` is relative to its parent, so the place of a nested part is the product of the locations from the top (`kernel.composeTransform(parent, location)`). `kernel.located(shape, matrix)` puts the definition shape there without copying it and without the cost of `transform`. A body number is the position of a leaf solid in a depth-first walk, so a component with nine solids under it has `firstBody` 1 and `bodies` 9 and the next one starts at 10. The face plate of the owner's export is body 10 and the base body 11, which is how `body = 10` and `component = "faceplate"` agree. A file with one root and nothing below it has no components, and a file with several roots lists the roots. An export from this app names its parts, nests an imported file as a component with its own solids below it, and carries each part's colour on the component. |
| F39 | What the owner's real files hold (same work). `part.step` (his export): components `original` (9 bodies named `SOLID` to `SOLID 9`, colour 0.784 0.616 0.349), `faceplate` (colour 0.753 0.376 0.298) and `base` (0.357 0.478 0.600). Whole file 111,911.527 mm³ = 80,892.131 (motor) + 7,837.432 (face plate) + 23,181.962 (base), which are the hand values of the owner's three parts; a component pick gives the last two exactly. `original.step` (his GrabCAD NEMA 17): nine components named `1` to `9` at the top, one solid each, no colour on the components, 80,892.131 mm³ in all, and the third solid is 16,046.569 mm³. So the file is flat in structure but not nameless, and `body = n` and `component = "3"` both work on it. |
| F40 | Cost of the quick check (Phase 11, 18 November 2026, Node, the owner's v3 machine as eight scratch parts with 28,102, 3,238, 256, 8,232, 11,278, 996, 3,008 and 1,360 triangles). A check of a whole pose from cold takes 245 to 320 ms (43 to 108 ms when it stops at the first hit and keeps no lines) and 0.2 ms when every pair is in the cache. A sweep of the crank through 360 degrees is 1,810 samples: **92 s** with the first narrow phase, 35 s after a box transform from centre and half-size, a test of a triangle's corners against the other's plane before the full test and a skip of faces that lie against each other, and **28.2 s** after leaves of 3 triangles instead of 6 (a 10 degree slice, 52 samples: 6 gives 933 ms, 3 gives 685, 2 gives 738). About 16 ms a pose. The pairs that cost most sit in tight fits and take 20,000 to 29,000 triangle tests a call (frame and drum, frame and crank, frame and rocker, guard and crank, crank and coupler, coupler and rocker): their bounding boxes overlap in many leaves though their surfaces do not cross. The sweep stays on the page, because the meshes are there and a worker would not be faster. | Scratch scripts `cost.ts` and `floor.ts`, not in the repository. The design file is the owner's. |
| F41 | Exact volumes along the same sweep. `common` took 63 to 200 ms a pose, so 5 poses of one stretch took 0.3 to 1.0 s and the 110 poses of 22 stretches about 8 s. Every one of the 22 stretches the mesh stage found is a real overlap on the exact solids: frame and drum 8.441 and 1.807 mm³ through the whole travel; 20 stretches of drum and roller, each 7.87 degrees wide, 0.598 to 25.79 mm³; crank and coupler from 39.841 to 107.279 degrees, 0.0128 to 238.2 mm³. The smallest volume of any pose was 0.0128 (the first and the last of the crank and coupler stretch), and no stretch had every pose under 0.01, so the floor stays at 0.01 mm³ and no stretch of mere touching turned up. Whether these are in the owner's design or come from how my scratch assembly splits it into parts is not known. | Scratch script `floor.ts`. |
| F42 | What the mesh stage sees. Two boxes that share less than `touchDepth` (0.001 mm) in some axis are touching, so a slider block that meets its wall at 15 mm (hand) is first seen at 15.0015 (the bisection is to 0.001), and the F30 hinge bar at 27.0963 within 0.01 degree. A round shaft of radius 5.099 in a hole of 5.1 (a gap of 0.001 mm), turned half a side (360 / 140 degrees), is a crossing on the preview mesh and 0 on the exact solids: F31's sag, and the case stage 3 is for. A shaft of radius 5.2 on true circles gives π (5.2² − 5.1²) 10 = 32.3584, and the same pair as 64-sided prisms gives 10 (A(5.2) − A(5.1)) with A(r) = 32 r² sin(2π / 64). | `test/collision.test.ts`. |
| F44 | A whole drawing set for the owner's v3 machine (Phase 12, 18 November 2026, Node, eight parts). The first `ModelBuilder.draw` takes 9.0 s after the 18.3 s build; with the parts cached the assembly sheet alone takes 1.0 s. The nine sheets are laid out in 14 ms, and the writers take 130 ms (PDF, 167,534 bytes), 65 ms (SVG zip, 192,266 bytes) and 90 ms (DXF zip, 231,860 bytes). Holes read: frame 8, guard 4, crank 6, coupler 2, roller 1 (and its turned steps), tray and drum 0. A section is made for the frame, the guard and the crank (each has a blind or counterbored hole). The rocker is faceted and gets overall sizes only. The notes count what is drawn and not dimensioned: 291 rounded faces on the frame (engraved letters and slot ends), 65 on the crank (gear teeth and slots), 10 on the guard. The crank sheet has four callout groups clustered over a view at 1:5, which is what made six rows necessary. A drawing set for the swivel arm takes 194 ms. |
| F45 | Output checks (18 November 2026). `qpdf --check` finds no syntax or stream error in the example part's PDF or in the 9-page v3 PDF, `pdfinfo` reads them (letter, 792 x 612 pt, producer Partscript CAD) and `pdftoppm` renders them. `ezdxf` 1.4.5 reads the DXF as AC1009 and `audit()` finds no error; it has the layers `BORDER`, `DIM`, `HATCH`, `HIDDEN`, `OUTLINE` and `TEXT`, with `LINE`, `TEXT`, `SOLID` (arrowheads), `POLYLINE` and `CIRCLE` entities. Not checked here: Chrome's own PDF viewer, an iPhone, and the CAD program the owner uses. |
| F46 | The cylinder reading, from the tests and the v3 parts. A hole is read from its cylinder face: through when both ends open onto outside faces, blind with a depth otherwise, counterbored when a wider coaxial cylinder sits over a narrower one. A cylinder that is only part-round (a slot end, a fillet), on a skewed axis, or a cone is not a hole and is counted in the notes. A `$fn` prism is read as a hole of its corner circle (a 64-sided Ø8 reads 8.000 within 0.001) and the sheet says it is a polygon and which file and line to change. A hole of Ø4 or less on an imported part is drawn and not dimensioned. |
| F47 | Faceted views. The preview's `edgeSegments` (creases over 28 degrees) with the outline give the views of a faceted part. The hull of two cubes has four curves in its front view, because two top faces turn only 14 degrees (below the rule) and two edges that bend 14 degrees chain into one polyline. Lowering the rule to 20 degrees was tried and gave nothing, so it was left at 28. |
| F48 | Layout numbers. The scale steps are 10, 5, 2, 1, 1/2, 1/5, 1/10, 1/20 and 1/50 (`scaleSteps`), the title block is 130 x 40 mm in the lower right corner inside a 10 mm border, and the space kept for a row of callouts is 7 mm (11 mm when a callout has a second line). A plate has one side under 15 % of its longest and gets two views. |
| F49 | The owner's NEMA 17 STEP (Kingroon, from GrabCAD) drawn as an imported part (18 November 2026, Node). `draw` takes 1.4 s. One hole is dimensioned. The four mounting holes at x and z of ±15.5 are reported as round cuts that are not a plain through, blind or counterbored hole, so they are drawn and not dimensioned; the notes also count 34 rounded faces, 78 conical faces and 16 other curved faces. The sheet is at 1:2 and every note says what to change or why it was left. |

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

**A circle wire does make a face** (F28; this entry said the opposite until follow-up 2, which was wrong or true only of an older kernel). `makeFace(makeWire([makeCircleEdge({ x, y, z: 0 }, { x: 0, y: 0, z: 1 }, r)]))` is a valid disc in the plane z = 0, and a wire of lines and arcs with coinciding ends makes a face too. Only `makeFace` of a bare edge, without `makeWire`, throws. Faces are what `extrude.ts` works on now.

**Offsetting a flat shape** (F28, `offset` in `flatFace`, `extrude.ts`). Work on the faces, not on a solid. For each face take its outline and its hole wires (`getSubShapes(face, 'wire')`; the outline is the wire whose bounding box equals `outerWire(face)`'s). Offset the outline with `kernel.offsetWire2D(wire, amount, join)` and each hole by `-amount` (a positive distance always moves a wire away from the area it encloses). Join `JoinType.Arc` rounds corners as `offset(r)` does, `JoinType.Intersection` keeps them sharp as `offset(delta)` does. Each result wire (`getSubShapes(result, 'wire')`: none when the body shrank away, two when a neck closed) goes through `makeFace`; cut the hole faces out of the body faces and merge. Check the area against a hand value: an L-shaped polygon, 300 in area, shrunk by 1 with sharp joins is 224. The kernel's solid offset (`kernel.offset`) is not used for this any more: it returned null for thin webs and D shapes (F25).

**Kernel call shapes that are easy to get wrong.** `kernel.rotate(shape, { point, direction }, angleRadians)`: an axis object and radians. `kernel.makeBoxFromCorners(c1, c2)` takes two `{ x, y, z }` objects, not six numbers. `kernel.offset` has a fourth, optional join type.

**Worker stack** (F24). OpenSCAD uses a piece of the worker's roughly 1 MB of stack for every nesting level of a dump it reads. BOSL2 dumps are 100 levels deep or more, mostly single-child `group()` wrappers. `renderMesh` runs `flattenGroups` on the text first. Anything new that writes a dump back to OpenSCAD should go through it too. The failure is a `RangeError: Maximum call stack size exceeded` that shows up only late in a long browser session; Node hides it unless started with `--stack-size=600`.

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
- Keep the `import`/`surface` rejection until phase 6. (Phase 6 lifted it for a quoted STL name of the project.)
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

- [x] All tests pass, including the 16 that exist today. (Checked 18 November 2026: 217 of 217 pass; the first 16 are part of that suite.)
- [x] Every example still builds with every part `exact`. (Checked 18 November 2026: all 7 menu examples, 16 parts, none faceted.)
- [x] `label_fan_folder_v4.scad` opened as a single file builds its default view (the whole machine as one faceted part) and exports a STEP that re-imports. Ask the owner for the file. (Checked 18 November 2026 in Node on the owner's v4 file: one faceted part (hull), 30,558 triangles, built in 1.0 s; STEP 30.5 MiB in 20 s; it re-imports as 10 solids with volume 709,383.97, the mesh's volume. Same numbers as F18.)
- [x] Build output names the faceted parts and the reason. (Checked 18 November 2026: `test/faceted.test.ts` asserts the reason, and a `hull` gives "This solid is faceted because it uses hull, so STEP has flat faces.")
- [x] `scripts/smoke.py` passes. (Checked 18 November 2026, normal and software modes.)

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

- [x] Tests pass. (Checked 18 November 2026: 217 of 217.)
- [x] With the owner's `label_fan_folder_v4.scad` in a project, an assembly file that includes it and declares five inline parts builds in one OpenSCAD run. Confirm by counting calls to the OpenSCAD factory in a test with a stand-in fixture. (Checked 18 November 2026: `test/assembly.test.ts` counts the factory calls for an include and five inline parts with a stand-in library, and gets 1. On the owner's own v4 file a faceted part adds one mesh run each, F20.)
- [x] Editing one inline part rebuilds one mesh (`rebuilt === 1`). (Checked 18 November 2026: `test/assembly.test.ts` asserts `rebuilt` 1 after editing one part.)

**Out of scope:** `-D` overrides per part, nested assemblies.

---

## Phase 3. Driven joints: gear ratios and cam tables (done)

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

- [x] Tests pass (58). The new example plays in `scripts/smoke.py`, normal and `--software`, and the script checks its two follower rows.
- [x] Followers appear in the exported STEP at their resolved positions (the last test in `test/loops.test.ts`: crank 30 and 90 put the plunger 3 mm and 12 mm up).

**Out of scope:** gear *contact* (teeth are not simulated; the ratio is stated), cams defined by contact between surfaces.

---

## Phase 4. The BOSL2 library (done)

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

- [x] Tests pass (49).
- [x] The owner's `label_fan_folder.scad` (v3.3.1) opens and builds its `assembly` view as one faceted part. Measured in Node: 5.2 s with two OpenSCAD runs (F21). STEP export of the whole machine is 32.9 s (F21). Splitting it into inline parts does not shorten that (37 s, F22).
- [x] With phases 2 and 3 done: an assembly file that includes the v3.3.1 file reproduces its motion, to 0.0001 mm at seven crank angles (F22). The owner keeps that file; the appendix is the starting sketch.

---

## Phase 5. Exact extrusions (done)

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

Guard: when a part would need more than 400 faces (`maxLeaves` in `flat.ts`; 100 until follow-up 2, which moved the work from solids to faces), treat it as unsupported. The plan first said 300 and guessed the v3.3.1 crank disk at 93 circles; it is 148 shapes. As solids that took 6.5 s at best and it stayed faceted; follow-up 2 builds it from faces in about a second (F28).

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

- [x] Tests pass (88; 93 after follow-up 2), and the browser smoke test builds the 7 menu examples and its 3 typed snippets without a problem in normal mode and in software mode. After the stack-depth fix, repeated full runs passed 14 of 14 in normal mode and 5 of 5 in software mode. All earlier examples still `exact`.
- [x] On the owner's v4 file, which parts are exact and which are faceted, with reasons. After the follow-up, 23 of 30 views are exact. Faceted (7): `assembly`, `exploded`, `plates`, `plate_drive`, `plate_idle` (the plate windows: more than 100 shapes, and a kernel that cannot shrink some of their bodies), `motor_mount` and `chute` (3D `hull`). The three combined views report the plates' reason. In the first commit `drum_cap`, `tray_half` and `label_kit` were faceted as well (`offset` of a shape that is not convex); the follow-up made them exact. `dancer` was expected faceted and is exact. **After follow-up 2: 26 of 30 are exact; the four left are `assembly`, `exploded`, `motor_mount` and `chute` (3D `hull`). The plates and `plate_drive`, `plate_idle` are exact.**
- [x] A STEP of the drum body keeps its true cylinders and is far smaller than the faceted one: 287 KiB against 1,109 KiB (v3). The 200 KiB target was an estimate and is not met. The offset follow-up gave the same kind of gain for `drum_cap` (123 KiB against 491 KiB).

**Out of scope:** `rotate_extrude`, twisted or tapered extrusions, 3D `hull`, `minkowski`, `polyhedron`, `offset` with `chamfer`, and exact geometry mixed with faceted geometry inside one part. Each stays faceted. They are backlog items. (`offset` over booleans was listed here and was done in the follow-up.)

---

## Phase 6. Import STEP and STL files (done)

The status note at the top lists where the build differs from this text; read it first.

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

- [x] Tests pass (125).
- [x] A NEMA 17 motor STEP opens, shows, and is hinged to a bracket (the owner's `original.step`, 644 KiB, a GrabCAD download, not committed). Tried by the owner on 17 November 2026: 9 bodies, 305 faces, 20,440 triangles, built in 1.5 s in Node and in 1.7 s with the bracket in his browser. His motor, face plate and base exported as one STEP re-open as 11 bodies and 111.91 cm³, which equals the three parts' volumes (80,892.1 + 7,835.8 + 23,181.1 mm³).
- [x] Autosave and reopening the page keep the asset (`scripts/smoke.py`, both modes). Tried by the owner on 17 November 2026: after a refresh and after reopening a saved project zip, three files with an imported STL came back and built the same.

**Out of scope:** IGES, native CAD formats, editing imported geometry, per-face colours.

---

## Phase 7. Measure (done)

The status note at the top lists where the build differs from this text; read it first.

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

- [x] Tests pass (112).
- [x] In the browser: measure a hole diameter and a hole-to-hole distance on the mounting plate, in the WebGL view and in the software view (`scripts/smoke.py`, `scripts/smoke.py --software`). Tried by the owner on 17 November 2026 in the WebGL view: a hole reads 3.4 mm and the pilot 22.4 mm, two neighbouring holes 31.2 mm apart (shortest distance 27.8), a hole to the pilot 22.062 mm, a face-to-face angle of 70.37 degrees, and an edge of the imported motor 30 mm, all equal to the values worked out by hand. The owner chose not to try the software view; the smoke test covers it.
- [x] Measuring an imported STEP part works (`test/import.test.ts` reads a hole of an imported mounting plate as diameter 5; the smoke test picks a face on an imported STEP).

**Out of scope:** dimensions that stay on screen, section views, mass and centre of gravity, drawings.

---

## Phase 8. Phone viewer mode (done)

Asked by the owner on 17 November 2026: can the site have a phone version, or is it too much compute? Answer: the compute is not the obstacle. The page layout is. Do this phase only when the owner asks for it. Phone **editing** is not part of it.

### What was measured on 17 November 2026

All of this is from a desktop Chrome with a software GPU. **Nothing was timed on a real phone.** A phone is likely 2 to 4 times slower on the CPU, but that is an estimate and the first step below replaces it with a number.

- **Touch already works.** A one-finger drag in the preview orbits the model at 390 and 360 px wide with touch emulated (`touch-action: none` is set on the canvas). Two-finger zoom and a tap in Measure were tried in step 5 below and work.
- **The page is too wide.** At a viewport of 390 px the page is 453 px wide, and at 360 px it is 415 px. The header (Export STEP is cut off), the source toolbar with the Examples menu, and the preview toolbar all run past the right edge. The stacked layout under `@media (max-width: 710px)` in `src/styles.css` is the starting point. It puts the editor above the preview, but the editor takes 62 dvh, so the model starts below the fold.
- **Touch targets are small.** 34 of the 41 buttons on the page are under 40 px in width or height.
- **The Joints panel covers about half of the 390 px preview.** The sliders and play buttons themselves work.
- **Engine size.** The OpenCascade kernel is a 21.3 MB file (`dist/assets/occt-wasm-*.wasm`, uncompressed on disk). It downloads once and the browser caches it. Mobile data will make the first load slow.
- **Heavy files.** On desktop the full v3 fan folder assembly builds in about 13.5 s and exports a 48 MiB STEP in about 22.9 s (see Phase 5). A phone could hit the 60 s job limit on that file. Small parts and assemblies are not at risk. Phone browsers also kill a tab that uses too much memory, iPhones sooner than Android.

### Design

- **Viewer first.** On a narrow screen the page opens the preview, the joint sliders, the Play button, the Parts menu and Measure. The editor is behind a **Code** toggle, so the model is on screen straight away.
- Open a saved project zip, or a draft that is already on the device, and look at it. Do not promise typing code on a phone.
- Keep one codebase and one set of engine code. Only `App.tsx` layout, `Viewport.tsx` panels and `styles.css` change. Do not fork the engine for phones.
- Joints panel: collapsed to one row by default, opened by a tap, so it does not cover the model.

### Steps

1. (Done 18 November 2026, see the status note.) **Measure on real hardware.** Ask the owner to open the live site on his phone, load `swivel_arm`, the label fan folder zip and a NEMA 17 STEP, and report load time, build time and whether the tab survives. Record the numbers in section 2 as new facts. Use them to decide whether a size limit or a warning is needed.
2. (Done.) Fix the horizontal overflow at 360 and 390 px (`.app-header`, `.source-toolbar`, `.preview-toolbar`). Acceptance for this step is `document.documentElement.scrollWidth <= clientWidth`.
3. (Done.) Add the Code / Preview toggle under 710 px. Preview is the default.
4. (Done.) Raise touch targets to at least 44 px under 710 px. Collapse the Joints panel.
5. (Done.) Check two-finger pinch zoom and a tap for Measure picking. The picking is in `viewer.ts`. A pinch was picking by accident, so it now ignores a gesture with two or more fingers down.
6. (Done, `check_phone`.) Add a `scripts/smoke.py` check at a 390 x 844 viewport with touch: no horizontal overflow, the toggle switches, a joint slider moves a part.

### Tests

No engine change, so no new engine tests. The browser smoke test carries the check (step 6). Run both modes.

### Acceptance

- [x] The owner has opened the live site on a phone and reported the timings from step 1 (18 November 2026: the fan folder zip faster than his laptop, `swivel_arm` fast, a NEMA 17 STEP under 5 seconds).
- [x] No horizontal scrolling at 360 and 390 px (smoke test, both modes).
- [x] The model is on screen without scrolling, joints move, Play runs, Measure picks a face by tap (emulated touch, both modes; the owner's own phone is the real test).
- [x] Tests pass and `scripts/smoke.py` passes in both modes.

**Out of scope:** editing code on a phone, a native app, offline install (a PWA is a possible later step), and anything that changes the engine.

---

## Phase 9. User manual (done)

Asked by the owner on 17 November 2026: add an instruction manual that says how to use the site and how the syntax works. It needs no engine change and can be done at any time. After it exists, a change to the syntax or to a build message updates the manual too (step 5).

### Why

Today the language is taught in three places that each cover part of it: the README sections ("Assemblies and joints", "Linkages and closed loops", "Gears and cams", "Geometry and precision"), the small Help dialog in the page, and the Examples menu. Nothing lists every argument of `part()` and `joint()` in one place, and nothing explains the exact and faceted difference to someone who has not read this plan.

### Who it is for

A mechanical engineer who knows CAD and does not write code. Say what to change, with a worked example, and never assume the reader knows OpenSCAD. This is the same reader the error messages are written for (see `CLAUDE.md`).

### Contents

1. **Getting started.** New, Run, the file tabs and the **+**, pinning the file Run builds, Examples, Save file and Save project, Open, autosave and what "Draft saved on this device" means, Export STEP.
2. **OpenSCAD in ten minutes.** Millimetres, `cube`, `cylinder`, `sphere`, `translate`, `rotate`, `union`, `difference`, `linear_extrude`, `$fn`. Each with a one-line picture of what it makes.
3. **Parts.** `part(name, file, at, rot, color)`, a part in a file and a part written in place with `part(name) { ... }`. What `at` and `rot` mean, and in which coordinates.
4. **Joints.** `joint(...)` with a table of every argument: what it means, its unit, its default. `hinge`, `slider` and `fixed`. The joint frame (`at`, `rot`) in the parent and the same frame in the child (`child_at`, `child_rot`). `axis`, `limits`, `value`. A worked two-link arm that the reader can change one number at a time.
5. **Linkages and driven joints.** Closed loops, `follow`, `ratio`, `offset` and `table` (gears and cams), with the gear and cam examples from the Examples menu explained line by line.
6. **Several files.** `include`, `use`, parameters in one file shared by many, and the BOSL2 library.
7. **Importing STEP and STL.** Opening a file, **Show on its own**, the `part("name", "file");` line, naming rules, units, why an STL part is faceted.
8. **Measure.** Face, edge and corner picks and what each pair of picks reports.
9. **Exact and faceted.** What each word means for the exported STEP, which features stay exact, which fall back (`hull`, a polyhedron, a mesh import), and how to read the message in the build output. Include the `$fn` trap: a `cylinder` with `$fn` is a prism with that many flat sides, so its holes are polygons in STEP. Leave `$fn` out for round holes. The owner met this on 17 November 2026 (a face plate of 343 flat faces became 25 faces with 8 true cylinders when `$fn` was removed), while the build output still said the part was exact.
10. **When something goes wrong.** The common build messages, each with the change that fixes it.
11. **Limits.** 40 files, 256 KiB per text file, 40 MB per imported file, 120 MB of imported files in all, and the 60 s job.
12. **A one-page cheat sheet** of the syntax that can be printed.

### Design

- Write it once, as Markdown in `docs/MANUAL.md`. The README keeps its short version and links to it.
- Ship it with the site so it works with no backend: a build step turns `docs/MANUAL.md` into a static page that the Help dialog and the header link to. Pick the way to render it that adds the fewest dependencies (rule 8). If the owner would rather have a plain file on GitHub, the Markdown alone is the first release and the page can follow.
- The syntax reference is written from `src/engine/assembly.ts`, which is what actually reads `part()` and `joint()`. Where the plan, the README and the code disagree, the code wins and the others are fixed.

### Steps

1. Write the outline above as `docs/MANUAL.md`, with every section present and the code blocks filled in.
2. Write `test/manual.test.ts`. It reads every fenced block marked `scad` in the manual and builds it. A block that is meant to fail is marked `scad error` and must fail with the message printed under it. A manual whose examples stop building then fails the tests.
3. Add the page build step and the Help dialog and header links.
4. Add a smoke check that the link opens the page and that the page has the twelve section headings.
5. Extend rule 9 in section 0 of this plan: a change to the syntax or to a build message updates `docs/MANUAL.md` in the same commit.

### Tests

`test/manual.test.ts` as above. The examples that it builds are small, so it should add seconds to the run, not minutes.

### Acceptance

- [x] Every section above exists and every `scad` example in the manual builds (`test/manual.test.ts`).
- [x] The argument tables for `part()` and `joint()` match `src/engine/assembly.ts`. The test checks every argument name and default, so no spot-check is needed.
- [ ] The owner can follow the manual from a blank project to a jointed assembly and then to an exported STEP without opening the README.
- [x] Tests pass and `scripts/smoke.py` passes in both modes.

**Out of scope:** video, translations, and a documentation site with search.

---

## Phase 10. Open an assembly STEP as separate parts (done, 18 November 2026, commit `62e754f`)

The status note at the top says what was built and where it differs from the text below. The sections that follow are the plan as it was written; the "unexplained" item is answered in F37 and the motor test line was corrected.

Asked by the owner on 17 November 2026, after exporting his motor, face plate and base as one STEP and opening it again: can the app split it back into its parts? Today it cannot. Phase 6 reads a STEP into one rigid part, so `part.step` with three parts in it opened as a single part with 11 bodies. This phase reads the structure of the file and lets `part()` pick one component or one body.

### What is true today (17 November 2026)

- `build.ts` `#importStep` calls `kernel.importStep(text)`, takes every solid with `getSubShapes(..., 'solid')` and joins them in one compound. Names, colours and the position of each component in the file are dropped. Plan step 7 of Phase 6 (names and colours) was never built.
- The app's own STEP export keeps the structure. The owner's export has three components named `base`, `faceplate` and `original.step`, each with its colour and its position in the pose that was shown. The motor inside it shows up only as products named `SOLID`, so a third-party file without good names needs to be picked by body number.
- `occt-wasm` can read this structure. `kernel.importXCAFFromSTEP(text)` returns a document with `getRoots`, `getChildren`, `getReferredLabel`, `getLocation`, `getSubShapes` and `getLabelInfo`, which gives the name, the colour (`hasColor`, `r`, `g`, `b`), and whether the label is an assembly or a component. `writeAssemblyStep` in `solid.ts` already uses the writing half of this.
- **Unexplained, check first (answered in F37: it did not reproduce).** A scratch script that imported the owner's 3.4 MB export with `kernel.importStep`, then called `getCenterOfMass`, `transform` and `exportStep` on the solids, ran at 100% CPU for more than five minutes and produced nothing. I stopped it and did not find which call was at fault. A plain import of the same file through the builder took 2.5 s in Node, and the owner's 832 KB re-export opened in the page in 734 ms. The file is not in the repository.
- A STEP has no joints. What the file holds is the pose it was exported in, with the joints already applied.

### Design

- When a STEP is opened, read its structure once, through XCAF, and keep a list of components next to the asset: name, number of bodies, bounding box, colour, position. Cache it with the asset by the hash of its bytes.
- The asset panel (`AssetPanel.tsx`) shows that list when the file has two or more components. Each row has **Show on its own** and **Copy the part line**.
- `part(name, file, component = "faceplate")` builds only that component. `part(name, file, body = 2)` builds only the second solid of the file (counted from 1) for files without useful names. With neither, the part is the whole file, as today.
- A part keeps the position the file gives it. The `at` and `rot` of `part()` apply on top of that. So an exported assembly opens already assembled, and the pose it was exported in comes back as it was.
- Colours come from the file unless `color` is given.
- Joints stay in the code. The manual (section 7) should then say: **export the assembly with every joint at its zero if you want to articulate it again**, because the exported pose is the new starting pose.
- Nested sub-assemblies are flattened: a component inside a component is named by its path with a slash, such as `arm/link`.
- Errors name the file and line and say what to change, for example: `part("p", "part.step", component = "plate") has no component "plate" in part.step. It has: base, faceplate, original.step.`

### Steps

1. Time `importXCAFFromSTEP` on the owner's exported assembly (832 KB after the round-hole fix, 3.4 MB before) and on the owner's GrabCAD motor STEP (`original.step`, 644 KiB). Find the call that hung (see above). Record both as new facts in section 2.
2. New `src/engine/stepTree.ts`: read the structure into `{ name, path, bodies, bounds, color, location }[]`. Add a worker command and a `protocol.ts` message that returns it with the asset facts.
3. `scad.ts`, `assembly.ts` and `csg.ts`: the `component` and `body` arguments of `part()`. `unsupported()` and the exact builder must agree about what is covered.
4. `build.ts`: build the chosen solids only, and cache the solid by the hash of the file plus the component or body. A coarser retry does nothing in OpenCascade (CLAUDE.md), so reuse `importedMeshing` as it is.
5. `AssetPanel.tsx`: the list of components, **Show on its own** and **Copy the part line** for each.
6. README, the Help dialog and the manual: update them in the same commit (rule 9).

### Tests (`test/import.test.ts`)

- Export the swivel arm example, read it back, and expect the four part names. The volume of each part must match the volume of the same part built from its `.scad` file to within 0.1%.
- Export an assembly with a hinge at 0 and at 30, read each back, and expect each component's position to equal `solvePose` for that value. Work one of them by hand (a 30 degree hinge puts a point at a known place).
- `part("a", "f.step", component = "arm")` builds one body with that part's volume. `body = 2` picks the second solid. A wrong name gives the message above.
- A file with no structure (a single exported part, or a flat compound) lists no components, and `body = n` still works. The owner's NEMA motor is not such a file: it has nine components named 1 to 9 (F39).
- The round trip the owner did by hand: motor, face plate and base exported together, then opened as three parts with the same hinge, and the pose at three tilt values matches the original to 0.0001 mm.

### Acceptance

- [x] An export from this app opens with every part listed by name and colour, and in the pose it was exported in. (Tests, 18 November 2026.)
- [x] The owner's motor, face plate and base round-trip: export, **New**, open the STEP, three `part()` lines, the hinge and the fixed joint that carries the motor with the face plate, and it moves as before. (The owner, 18 November 2026: the overall size at tilt 0 and 30 is the same as the original assembly's.)
- [ ] A real GrabCAD assembly with several components lists them. The owner downloads it and does not commit it.
- [x] Reading the structure of a 1 MB file is timed and reported: F37, about 0.17 s a megabyte on the motor and 0.07 on the export.
- [x] Tests pass and `scripts/smoke.py` passes in both modes. (Checked 18 November 2026: 217 of 217, and the smoke test in normal and software modes.)

**Out of scope:** reading joints or mates (a STEP file does not hold them), editing the structure, writing nested sub-assemblies, per-face colours, and IGES.

---

## Phase 11. Collision detection (done, 18 November 2026, commit `e53a4d1`)

Asked by the owner on 18 November 2026: find parts that collide, and especially while a joint moves. This replaces the backlog row "Collision check", which asked only for the current pose. The status note at the top says what was built and where it differs from the text below. The sections that follow are the plan as it was written.

### What is true today (18 November 2026)

- Nothing checks for overlap. The README (the loops paragraph) and the Help dialog (the limits entry) both say collision checks are unavailable. This phase removes those sentences (rule 9).
- Pieces that exist and can be reused:
  - `placeParts` and `solvePose` in `assembly.ts` give a world matrix for every part in any pose, and `transformBounds` gives its world box.
  - `moveJoint` and `advanceJoint` in `kinematics.ts` move one joint and keep every loop shut and every follower in step.
  - `picking.ts` already builds a bounding volume hierarchy for each part mesh (private to that file today).
  - Measure is the pattern for a kernel call on a pose: `ModelBuilder.measure` wraps it in `checkpoint` and `releaseSince`, the worker answers a command, and the client has a method. The worker keeps the last build, so a stale preview can still be asked.
  - Both views already tint faces and draw lines for Measure.
- What the kernel gives (F30 to F32): `common` gives the overlap volume exactly and says 0 for parts that only touch, in 5 to 210 ms a pair on the v3 machine. `distanceBetween` says 0 for touching, overlapping and nested parts alike and took up to 4.25 s a pair. The preview mesh of a round surface lies up to about 0.001 r inside it.
- The owner's v3 machine has one overlap in its opening pose (frame and drum, 8.441 mm³, not yet understood) and four pairs that touch on purpose.

### Design

- **What a collision is.** Two parts that share volume. Touching is not one, whether on a face, along an edge or at a corner. A volume under a floor is ignored; step 1 sets the floor from the noise measured on curved parts (F30 shows 0.01 mm³ is resolved, so start there). A warning for parts closer than some clearance is **not** in this phase, because `distanceBetween` is too slow for it (F32).
- **Three stages for one pose.**
  1. *Broad.* Compare world boxes. Pairs with no box overlap are clear. A pair joined only by fixed joints never moves relative to each other, so it is checked once per build, not once per pose.
  2. *Narrow, on the page, on the preview meshes.* Walk two bounding volume hierarchies together and test triangle pairs. A pair counts as crossing only when each triangle has vertices clearly on both sides of the other's plane (by more than 1e-6 of the part's size), so faces lying against each other do not count. A part that lies wholly inside another has no crossing triangles, so one vertex of each is tested by ray parity. This stage works for exact, faceted and imported parts alike, and it returns the crossing segments so they can be drawn.
  3. *Confirm, in the worker, for pairs that are exact on both sides.* `kernel.common` on the two placed solids; the volume decides. A pair the mesh called crossing whose volume is under the floor is reported as touching, not as a collision (F31 is why the mesh alone cannot decide). A pair with a faceted side has no exact answer, because building a solid from a mesh takes seconds (F18), so it is reported as found from the preview mesh only.
- **In a pose, live.** After a build, and after every change of pose (a slider, Play, Reset), stages 1 and 2 run on the page. Colliding parts are tinted red in both views, the crossing segments are drawn as red lines, and the Joints panel shows one line such as `Collision: crank and frame`. When motion stops, stage 3 runs for the flagged pairs, and a pair that turns out to be touching loses its tint. If step 1 shows that stage 2 cannot keep up with a slider drag on the owner's machine, the live check runs when the pointer pauses and on release.
- **Along a joint's travel: Check motion.** A **Check motion** button in the Joints panel sweeps each joint that has a value to set (`movingJoints`), one at a time with the others where they are now. The travel is the joint's limits, or 0 to 360 for a hinge with no stops (`turnsFully`). Poses come from `moveJoint`, so loops stay shut on one branch and followers follow. The step is the one that keeps every point of every part from moving more than 0.5 mm between samples, bounded by the part's centre move plus its radius times its turn, and never more than 1 degree for a hinge. A pair whose two matrices equal the last sample's keeps its last answer. When a sample first shows a collision, the sweep bisects between it and the last clear sample down to 0.01 degree (or 0.001 mm for a slider), so the first-contact value is sharp. Stage 3 then confirms each flagged pair at its worst sample. The result is a list, one row per pair and joint, such as `crank and frame overlap from 112.4° to 118.9° of crank (6.2 mm³ at worst)`, and `No overlap in 360 poses of crank` when it is clear. Clicking a row sets the joint to its first-contact value, so the owner sees it.
- **What the sweep cannot promise.** A feature thinner than one step can be stepped over. Joints are swept one at a time, so a machine with two independent joints needs the sweep run again with the other joint moved. A machine with one driver (a crank with its followers and loops) is covered by one sweep.
- **Stop at collision.** A toggle in the Joints panel, off by default, kept on the page and not in the code. When it is on, a slider and Play stop at the last clear value (found by the same bisection) and do not pass through.
- **Overlaps that are meant.** A new module `allow_overlap(a, b)`, written like `part()` and `joint()`, names two parts whose overlap is by design, for example a thread modelled as a plain shaft in a plain hole. The pair is skipped by every check, and the panel counts them (`2 pairs allowed`). A name that is not a part is an error that names the file and line. Every other pair is checked, including a joint's parent and child (a hinge pin of the exact size in its hole only touches, so it is not flagged). Parts hidden in the Parts menu are still checked, because that menu changes the preview and not the machine.
- **Where the code goes.** `src/collision.ts` (new, pure like `picking.ts`: stages 1 and 2, the rigid groups, and the sweep taking its pose and test as functions, so Node tests drive it without a page). `picking.ts` exports its hierarchy for it. `ModelBuilder.collide(model, pose, pairs)`, a worker command and a client method for stage 3. `assembly.ts` for the prelude and `AssemblySpec.allowed`. `Viewport.tsx` for the panel, `viewer.ts` and `softwarePreview.ts` for the red tint and lines. No change to what a build produces or to STEP export.
- **Imported assemblies (Phase 10).** An assembly read from a STEP file will have bodies that overlap by design (a bolt in a hole). A way to allow a whole group is not planned here. Revisit it when Phase 10 has a real GrabCAD file to try.

### Steps

1. **Measure before building**, in the style of Phase 8 step 1, on the owner's v3 machine and on the manual's four-bar: time stage 2 on every box-overlapping pair in one pose, time `moveJoint` for 360 one-degree steps, and time a whole sweep. Measure the noise of the `common` volume on curved parts that touch (a shaft the size of its hole) and set the floor from it. Record the numbers as new facts in section 2. Ask the owner what the frame and drum overlap of 8.441 mm³ is. If stage 2 is too slow on the page for a sweep, decide whether it moves to a worker before step 2 goes further.
2. `src/collision.ts`: stages 1 and 2, with tests for cubes that overlap, touch and nest.
3. Stage 3: `ModelBuilder.collide`, the worker command, `protocol.ts` types and the client method, with tests.
4. `allow_overlap` in the prelude and the reader, with its error messages and a manual signature test (`test/manual.test.ts` compares the prelude with the manual).
5. The live check: the red tint and lines in both views, the panel line, and the confirmation when motion stops.
6. Check motion and Stop at collision.
7. README, Help dialog and manual in the same commit (rule 9). Remove both "collision checks are unavailable" sentences. The manual gets a new section after Measure (sections 9 to 12 become 10 to 13, and `test/manual.test.ts` lists the section titles, so it changes too), and `allow_overlap` joins the cheat sheet.
8. `scripts/smoke.py`, both modes: a slider moved into a part tints it red, Check motion lists the pair with its first-contact value, and Reset clears the tint.

### Tests (`test/collision.test.ts`, new)

Every expected number is worked by hand.

- Two 10 mm cubes, one moved 2 mm into the other: stage 2 says crossing, stage 3 says 200 mm³ (F30). Moved so they touch on a face: no collision, volume 0. A 6 mm cube 2 mm inside a 10 mm cube: no crossing triangles, ray parity finds it, volume 216.
- A shaft of radius 5.0 in a hole of radius 5.1: no collision, and the exact result agrees with the mesh. The same shaft at 5.2: a collision of 32.3584 mm³, the hand value π (5.2² − 5.1²) 10.
- The hinge case of F30 (the bar 20 × 2 × 5 mm and the wall 40 × 2 × 5 mm, placed as there). Check motion reports first contact at 27.0963 degrees, within 0.01, and the volume at 28.0963 degrees is 0.5461 mm³, from 5 h² / sin 2t.
- A slider: a block 10 mm long (x from 0 to 10) on a slider along x with limits 0 to 30, and a fixed block 10 mm long (x from 25 to 35). First contact at 25 − 10 = 15 mm, checked to 0.001, and at 30 mm the two overlap by 5 mm of length (a volume worked from the block's other two sides).
- A part with a faceted side is flagged by the mesh alone and the result says so. `allow_overlap` removes a pair from every check, and a part name that does not exist gives the message with the file and line.
- Parts joined only by fixed joints are checked once, not once per pose: count the stage 2 calls over a 360 pose sweep.
- 200 parts (the limit) pass the broad stage: time it and put the number in the test's message, with a ceiling.
- A four-bar loop sweeps the whole crank turn with the loop shut at every sample.

### Acceptance

- [ ] The owner has said what the frame and drum overlap in his v3 machine is, and it is either fixed in the design or allowed with `allow_overlap`. (Pending, 18 November 2026: the owner will decide later.)
- [x] Moving a joint slider into a part tints both parts red in both views, and moving it back clears the tint (`scripts/smoke.py`, both modes). Parts that only touch are never tinted after the exact check (F42); while a joint moves, a touching pair can show red until it stops.
- [x] Check motion finds the first contact of the F30 bar and wall within 0.01 degree, and lists a collision interval for a slider (`test/collision.test.ts`, and the smoke test clicks the listed line).
- [x] Stop at collision halts a slider and Play at the last clear value (`scripts/smoke.py`).
- [x] (Measured: a pose costs about 16 ms and a crank sweep 28 s, F40. The owner tried it on his v3 machine on 18 November 2026 and reported tests 19 and 20 as passing; he sent no timings.) On the owner's v3 machine the live check keeps a slider drag usable (the target is 30 frames a second; step 1 reports the number and decides whether the check waits for the pointer to pause), and a sweep of the crank finishes in a time step 1 reported.
- [x] README, Help and the manual are updated, and `test/manual.test.ts` passes.
- [x] Tests pass (211) and `scripts/smoke.py` passes in both modes.

**Out of scope:** a warning for parts closer than a clearance (F32: `distanceBetween` is too slow), forces, contact physics and friction, parts that collide with themselves, sweeping several joints at once, collision between two samples of a sweep beyond the bisection, automatic avoidance, and allowing a whole group of overlaps at once.

---

## Phase 12. Drawings: export each part as a dimensioned sheet (built 18 November 2026, not committed; the owner's acceptance is pending)

Asked by the owner on 18 November 2026: export parts to engineering drawings automatically. He had the same idea in his repository `leon14026/scad2drawing` (a Google Colab notebook), told me it was not robust, and said this plan need not follow it. The status note at the top says what was built and where it differs from the text below. The sections that follow are the plan as it was written.

### What scad2drawing did, and why it was fragile (read 18 November 2026)

- Its chain was `.scad` to `scad2step` (scad123d, MIT) to a STEP file to `draftwright` (AGPL-3.0, Python) to PDF, SVG and DXF. The two tools ran in two locked Python environments, with STEP on disk between them. The repository holds only the glue (a command line, a notebook, four samples and tests of the command line), not a drawing engine.
- Its own `FEASIBILITY.md` gives the reasons it was fragile. The two tools pin different `build123d` versions on Colab's Python 3.12, so they cannot share an environment. An unlocked install gave `OCP TopTools ImportError`. A mesh fallback (a `hull` of three spheres, `minkowski`, `projection`, `surface`, a twisted extrusion) gave a faceted STEP and "junk drawings". The automatic dimensions are heuristic. A fused assembly STEP gives nothing per part, so the glue had to loop a `-D part=` selector. Assembly sheets, balloons and bills of material were out of scope.
- What draftwright produces, from its README (read 18 November 2026): three orthographic views, sized and scaled automatically, with an isometric in its example; overall dimensions on each principal face; hole callouts with diameter, depth, counterbore and spotface, and pattern callouts such as `4× ⌀8 THRU`; diameter leaders for the external steps of turned parts; a section A to A when blind or stepped holes would be hidden; an ISO 7200 title block; an ISO or ASME standard scale picked for the page; and PDF (with a JSON sidecar), SVG and DXF. It does not dimension chamfers or fillets, and threads are not automatic. It does not say whether it draws first or third angle. Its README warns that a part can score 1.0 with whole features missing from the drawing, and says to read its `excludes` and `unrecognised_geometry_reports` lists. This plan takes three ideas from that: the turned-part diameters, the counterbore callout, and the rule that the sheet must list what it did not recognise. Nothing here depends on its code.
- Nothing is reused. draftwright is AGPL-3.0 and Python, and this site is GPL-3.0-or-later and runs in the browser. The ideas carry over, the code does not.

What Partscript has that scad2drawing did not: the exact solid of every part is already in memory (no STEP round trip, no second environment, nothing to install), the parts are named by `part()` (no `-D` loop), every part says whether it is exact or faceted, and the kernel's hidden-line removal is in the same WASM file.

### What is true today (18 November 2026)

- Nothing makes a drawing. There is no PDF or DXF writer and no dependency for either. `fflate` (zip) is the only file-format library.
- The kernel has what a drawing needs: `projectEdges` (hidden-line removal), `wireframe`, `cut`, `surfaceData` and `curveData` (F33 to F35). It also has `toSVG` and `renderMultiviewSVG`, which are made for an agent to look at a shape (four panels on one scale, an axis gnomon, the overall size in a footer). They have no dimensions, no section, no hatching and no title block, so this phase does not use them.
- Pieces in the repository that can be reused: `BuiltModel.entries` (one solid per part, and parts with the same geometry share an entry, which gives the quantities of a parts list), `ModelBuilder`'s stored solids (`#shape`, which `exportStep` reads), the face and edge numbering that Measure reads, and the ray cast in `picking.ts` (private to that file today), which can find a visible point of a part for a balloon.
- `$fn` makes polygons. A cylinder or a circle with `$fn` above 0 is a flat-sided prism in the STEP (`flatRounds` in `csg.ts`, and the build message already says so). A hole without `$fn` is a true cylinder. A drawing has to cope with both.
- The Export STEP button is in `App.tsx`; the Drawing button goes beside it.

### What was measured (F33 to F36)

- Hidden-line removal takes 15 to 200 ms a view, even on the NEMA 17 STEP with 305 faces (F33). A whole set of three views and a section for one part is well under a second.
- A circle stays a circle only when seen square-on, and a `$fn` hole is only straight lines (F34), so hole sizes and places are read from the cylinder faces of the solid, not from the projected edges.
- A section is a cut of the solid by a half-space box. The faces left in the cutting plane are the areas to hatch, found in 1 to 22 ms (F35). `sectionPlane` returns edges only and cannot be hatched.
- A faceted part with flat faces draws cleanly. One with curved faces draws every facet, and needs the preview's 28 degree crease rule applied before it is usable (F36).

### Design

- **The principle.** The drawing is read from the exact solid, not from a picture of it. Lines come from hidden-line removal and dimensions come from faces. A feature that is not understood is not dimensioned, and the page lists what was left out, in the build-message style (what, where, what to change). Nothing about tolerances is invented: the general note reads `DIMENSIONS IN MM. TOLERANCES NOT SPECIFIED.` until the owner edits it, because OpenSCAD has no tolerances to carry.
- **One sheet for each part, from `part()`.** The sheet is drawn in the part's own coordinates, before `at` and `rot` place it. Parts with the same geometry share one sheet with a quantity. An assembly can also get a sheet of its own (see below). A single-solid project is one part with the project's name.
- **Views.** Third angle projection, the North American standard, is the default, with first angle as a choice. The views are the kernel's: front (looking along +Y, so the sheet shows world x and z), top (world x and y) and right (world y and z), from F33. A part with one thin side (under 15 % of its longest side, to be tuned in step 1) is a plate and gets two views, the face and one edge view. Otherwise three views, plus an isometric view of the solid in the free corner. Which views a part needs is step 1's question, and the owner's reference drawing decides it.
- **Hidden lines.** Dashed, on for the views of exact parts with few hidden edges, off beyond a limit that step 1 sets (hidden edges outnumber visible ones in every view measured, F33). The owner can switch them in the dialog.
- **Sheet and scale.** The default is ANSI A, landscape (Letter, 279.4 by 215.9 mm), with A4, A3 and ANSI B as choices. The scale is the largest of 1:1, 1:2, 1:5, 1:10, 1:20, 1:50, 2:1, 5:1 and 10:1 at which the views, their dimensions and the title block fit. The scale and the projection symbol go in the title block.
- **Dimensions.** Four kinds, each in a lane of its own so they cannot overlap by construction:
  1. *Overall*: the bounding box width, height and depth of the part in its own frame, on the views that show them.
  2. *Holes*: every cylinder face is read with `surfaceData` (radius, axis, location). A cylinder whose axis lies along a view direction is a hole or a boss seen square-on in that view. Equal diameters with the same axis are one callout, such as `4X Ø3.4 THRU`. Through or blind is decided by whether both ends of the cylinder open onto outside faces (step 1 tests the rule on real parts), and a blind hole adds `DEEP 8`. A `$fn` prism (a closed ring of equal flat faces around an axis, 8 or more of them) is recognised as a hole of its corner circle, and the page says it is a polygon and which file and line to change to make it round. A counterbore or spotface (a wider cylinder coaxial with a narrower one) is one callout with a second diameter and a depth (`CBORE Ø11 DEEP 6`).
  3. *Places*: ordinate dimensions from one corner of the view (the lower left), stacked in lanes along the bottom and the left of the view. Ordinate dimensions avoid chains, stay small and never cross each other.
  4. *External diameters of turned parts* (shafts, pulleys, bosses): a cylinder face whose axis lies in the plane of a view is dimensioned `Ø` in that view, one dimension for each step, with a length for each step along the axis. Partscript parts are often turned shapes (the owner's pulley and motor shaft), so step 1 tests this on them.
  Rounds (an arc seen square-on, `R3`) are the next kind; chamfers, slots and pockets are not in this phase. A diameter that appears in a section only is dimensioned there.
- **Sections.** A section A to A is added when a hole is blind or stepped (a counterbore). The plane runs through the axis of the first such hole. Step 1 tests whether a hollow part, with many hidden edges and no blind hole, should get one too. It is made as in F35, hatched at 45 degrees with an even-odd fill over the cut faces' outer wires and holes, drawn from the cut side, with a cutting-plane line and the letters on the parent view.
- **The title block** sits in the lower right corner, in the style of the ASME sheet formats: part name, scale, sheet size, projection symbol, units, drawn by, date and a revision letter, with material as a free text line and the general note. The fields are filled in the Drawing dialog and saved with the project, so Save project and Open carry them (whether that is a file in the zip or a field of the draft is decided in step 2); there is no new `part()` or `joint()` syntax, so the manual's syntax chapter does not change.
- **The assembly sheet.** An isometric view in the pose on screen, a parts list (item, name, quantity, bounding size) and a numbered balloon for each part, joined by a leader to a point that a ray cast from the view direction hits on that part. A part that hides entirely behind others gets a balloon with a leader to its centre and a note. Exploded views are not in this phase.
- **Faceted and imported parts.** A faceted part with flat faces is drawn like an exact one, with overall dimensions and no hole recognition beyond what its flat faces give. A faceted part with curved faces keeps only the edges the preview keeps (`toPartMesh`, `creaseDegrees = 28`), gets overall dimensions only, and the page says it is faceted (the summary sentence already exists). An imported STEP gets views and overall dimensions, with hidden lines off by default, and a hole callout only for cylinders over 2 mm radius; its sheet says it was imported. Step 1 measures whether those rules read well on the NEMA 17.
- **Where the code goes.** New folder `src/drawing/`. `views.ts` runs in the worker with the kernel and returns a plain description of lines, circles, arcs and the faces to hatch (no handles). The rest is pure and runs on the page and in Node: `dimensions.ts` (from face records to dimension records), `layout.ts` (scale, view places, lanes), `sheet.ts` (border and title block), and one writer for each format, `svg.ts`, `pdf.ts` and `dxf.ts`. One description feeds all three writers, so SVG, PDF and DXF agree by construction. `ModelBuilder.draw(model, options)`, a worker command `draw` and a client method are the Measure pattern again. A job over the 60 s limit is split by part (one command for each).
- **Outputs.** SVG (shown in the page and downloaded), PDF (one page for each sheet, vector lines and the built-in Helvetica font, so no font file; written by hand) and DXF (ASCII, R12 so every CAD program reads it, with the layers `OUTLINE`, `HIDDEN`, `DIM`, `HATCH`, `TEXT` and `BORDER`, where `Ø` is written `%%c`). The file names are `<part>.svg`, `.pdf` and `.dxf`; several sheets go in one PDF, or in one zip for SVG and DXF. The same input gives the same bytes: the PDF writes no creation time of its own (the date in the title block comes from the dialog).
- **The page.** A **Drawing** button beside Export STEP opens a dialog: which parts (all by default), sheet, projection, hidden lines, and the title block fields. It shows the first sheet as SVG with the list of what was not dimensioned, and offers PDF, DXF and SVG downloads. On a phone it is one column, like the other dialogs.

### Steps

1. **Measure the rest before building** (F33 to F36 were measured while writing this plan, on the two parts of the motor bracket I wrote for the owner, the NEMA 17 STEP and three small solids). Still to measure: a whole drawing set for the largest parts of the owner's v3 machine (the 547-face frame); how many of its holes the cylinder reading recognises and how many it misses; whether the kernel gives the two faces of an edge cheaply enough to filter facets by angle, or whether to match the hidden-line edges against the preview's crease set; the hidden-line limit, the plate rule and the section rule on real parts; a `$fn` prism recogniser on the owner's files; and a hand-written PDF against a checker (`qpdf --check` if it is installed here, and Chrome's own viewer). Record the numbers as F44 onward. **Ask the owner for one drawing he would draw by hand today** (a photo of one is enough) and make it the reference for the views, the lanes and the title block. (Steps 1 to 8 were built on 18 November 2026; the measurements are F44 to F48 and the reference drawing is still to ask for.)
2. Views, sheet and SVG, without dimensions: `src/drawing/views.ts`, `layout.ts`, `sheet.ts`, `svg.ts`, the worker command, the client method, the button and the dialog with an SVG preview. Tests for the plate.
3. Overall and hole dimensions, ordinate places, the list of what was left out.
4. Sections and hatching.
5. The PDF and DXF writers.
6. The parts list, balloons and the assembly sheet.
7. Faceted and imported parts.
8. README, Help dialog and manual in the same commit (rule 9). The manual gets a new section after Measure (the later sections move up by one, and `test/manual.test.ts` lists the section titles, so it changes too). The smoke test, both modes: open the dialog, see a sheet with a `Ø` dimension, download all three files.

### Tests (`test/drawing.test.ts` and `test/drawing_formats.test.ts`, new)

Every expected number is worked by hand.

- The plate of F15, 40 by 30 by 5 mm with an 8 mm hole at (10, 15): two views (the top and one edge view); overall dimensions 40, 30 and 5; one callout `Ø8 THRU`; the ordinates 10 and 15 from the lower left corner; no section. Scale 1:1 on ANSI A, because the views fit; a 400 by 300 by 20 mm plate of the same kind gets the largest listed scale at which both views and their dimension lanes fit, worked out from the sheet's drawing area once step 2 fixes the margins.
- A 40 by 30 by 20 block with a blind hole of 8 mm diameter and 12 mm depth: a section A to A, whose hatched area is the plane's cut face, 40 × 20 minus 8 × 12 = 704 mm² at a plane through the hole's axis (a hole that is 8 mm wide and 12 mm deep in the plane). The block cut at x = 20 with no hole through it has the area 600 mm² (F35).
- Four equal holes make one callout, `4X Ø3.4 THRU`. Two diameters make two callouts. A hole in a `$fn = 64` prism is recognised, dimensioned as Ø8 (its corner circle), and the message names the file and line.
- The faceted ring (F36) draws with the preview's crease edges only (under 40 visible edges, a limit set in step 1), has overall dimensions and no hole dimension, and the message says it is faceted. The hull of two cubes draws its 7 visible edges in the front view.
- The parts list: two parts with the same geometry are one row with quantity 2.
- The writers: the same input twice gives identical bytes; the DXF has the hole as a `CIRCLE` of radius 4 on its own layer, at the position the scale gives; the PDF's cross-reference offsets point at their objects and its stream lengths are right; the SVG is well formed and has the same number of lines as the description.
- A drawing set for the whole swivel arm runs in under 10 s, and one part's sheet under 2 s. Put the numbers in the test's message, with a ceiling.

### Acceptance

- [ ] The owner has given one reference drawing, and the sheet the site makes for the same part is something he would hand in, or he has listed what is missing.
- [ ] The swivel arm's parts each get a sheet. The overall sizes and the hole sizes on them match the model (checked with Measure). *(Mine: the sheets, the sizes 80 x 80 x 22 and the callout `4X Ø5 THRU` are tested by hand-worked numbers in `test/drawing.test.ts` on 18 November 2026. Comparing them with Measure by clicking is not done.)*
- [ ] The owner opens the PDF on his laptop and on his iPhone, and the DXF in the CAD program he uses.
- [x] A part with a blind hole gets a hatched section, and a plate gets two views. (`test/drawing.test.ts`, 18 November 2026: the plate of F15 has two views, and the counterbored block has a section A-A of 640 mm².)
- [x] A faceted part and the NEMA 17 STEP both produce a sheet, and the page says what it did not dimension. (A faceted ring and an imported STEP are in `test/drawing.test.ts`, and the owner's NEMA 17 STEP gave a sheet with seven notes, F49; 18 November 2026.)
- [x] README, Help and the manual are updated, and `test/manual.test.ts` passes. (18 November 2026: manual section 9, 14 sections, a test that checks its numbers and builds its example.)
- [x] Tests pass and `scripts/smoke.py` passes in both modes. (18 November 2026: 242 tests; smoke passed in hardware mode, and in software mode on the second run. The first software run failed once in `check_hiding` ("Show all did not bring back the original picture", a canvas picture comparison on the crank-rocker example) and passed on the rerun; the drawing checks passed both times.)

**Defaults chosen, which the owner may change:** third angle projection, ANSI A landscape, millimetres only, title block fields in the dialog and saved in the project, PDF first and DXF second in the order of work.

**Out of scope:** tolerances and fits, GD&T, thread callouts (Partscript has no thread), surface finish and weld symbols, chamfer, slot and pocket dimensions, several sheets for one part, exploded views, sheet-metal flat patterns and bend tables, DWG (DXF only), editing a sheet on the page (the owner edits the SVG or DXF in another program), and drawings of an imported assembly until Phase 10 has opened it as separate parts.

---

## Phase 13. Partscript as an MCP server for Claude and ChatGPT (optional, proposed, not started)

Asked by the owner on 18 November 2026: "as part of an additional phase, is it possible to make it a connector in Claude and plugin in chatgpt". He asked for it to be listed as **optional**. Nothing else waits for it, and rule 1 and the backlog's rule apply: it is not started without his go-ahead. The status note at the top says what was built and where it differs from the text below. The sections that follow are the plan as it was written.

### A decision the owner has to make first (rule 10)

`CLAUDE.md` says "Static site, no backend". Every other phase kept that. This one cannot, because both products call a server over the internet, and GitHub Pages cannot run one. What stays true: the site stays static, and the server is a separate deployment built from a separate folder. What changes: the commit that adds the server also rewrites that line of `CLAUDE.md` and says so in the README. The owner decides three things before step 2:

1. **Where it runs and who pays.** Step 1 prices the candidates (a small container service, a small virtual machine, or his own computer behind a tunnel) and measures what the engine needs.
2. **Who may use it.** Only him (a secret in a header or a sign-in) or anyone with the link. A public endpoint that runs submitted OpenSCAD needs limits whatever the answer is.
3. **His ChatGPT plan.** See the next section: what a plan allows is not settled.

### What was read (18 November 2026, from search results and not measured)

- **Claude.** A custom connector is the URL of a remote MCP server. Claude calls it from Anthropic's cloud, not from the user's computer, so the server must be reachable from the public internet. It is available on Free (one connector), Pro, Max, Team and Enterprise. The local alternative is a desktop extension (an MCPB file) that runs on the owner's computer and works in Claude Desktop only. A server set up in `claude_desktop_config.json` is not available in claude.ai. A custom connector may send up to four custom headers, and Anthropic reviews each header name. Sources: https://support.claude.com/en/articles/11175166 and https://claude.com/docs/connectors/custom/remote-mcp. Claude's documentation also says that most partners ship a remote server and a plugin that wraps it with skills (https://claude.com/docs/connectors/overview).
- **ChatGPT.** The old plugin idea is gone. The name moves (connectors, then apps, and some menus now say Plugins), but the thing is a remote MCP server at an HTTPS address, added in Developer mode. OpenAI's help page says apps, full MCP support and Developer mode are available for Business and Enterprise/Edu on web (https://help.openai.com/en/articles/12584461). One third-party guide says Plus and Pro get Developer mode for read-only connectors (https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup). Two third-party pages say there is no stdio (a local server reaches ChatGPT only through a tunnel that is limited to enterprise) and that apps are web only, with agent mode not using custom apps (https://zuplo.com/learn/mcp/compatibility/clients/chatgpt-connectors.md and https://coworker.ai/blog/chatgpt-mcp). **Step 1 re-reads OpenAI's page and checks it against the owner's plan**, because the sources disagree and the rules change often.
- **MCP Apps.** The first official MCP extension (26 January 2026, SEP-1865) lets a tool return an interactive page, a `ui://` resource shown in a sandboxed frame in the chat. Claude and ChatGPT both support it, and it was co-developed by Anthropic and OpenAI (https://workos.com/blog/2026-01-27-mcp-apps and https://www.thoughtworks.com/radar/platforms/mcp-apps).

### What is true today (18 November 2026)

- **The engine already runs outside the browser.** `ModelBuilder` (`src/engine/build.ts`) has `build`, `measure`, `collide` and `exportStep`. The tests run it in Node with both WASM engines, and `test/libraries.ts` reads the BOSL2 zips from `public/`, so a server needs no browser API to build. `src/collision.ts` (`CollisionChecker`, `sweepJoint`, `clearMove`) is pure and ran in Node in the Phase 11 probes (F40).
- **One piece lives in the page.** The exact confirmation of Check motion (the poses sent to `collide` in chunks of 12 under a 45 s budget) is in `checkMotion` in `src/components/Viewport.tsx`, not in a shared module. The build summary and messages come from `src/engine/summary.ts` and `ModelPreview.messages`, which the page and a server can both use.
- **Sizes that matter.** The OpenSCAD files in `public/engines/openscad/` are about 9 MB on disk and `node_modules/occt-wasm` is 22 MB. A crank sweep of the v3 machine took 28 s (F40). A STEP of the v3 machine was 48 MiB after Phase 5's first follow-up, far too big to return in a tool result.
- Nothing in the repository serves HTTP, signs anyone in or uses the MCP SDK, and there is no dependency for it.
- **Not measured:** the memory one build needs in Node, a cold start, how many builds a small host runs at once, how large a tool result each host accepts, and which sign-in each host accepts for a private server.

### Design (intent, not measured)

- **One server for both products.** A remote MCP server over HTTPS (the streamable HTTP transport) named Partscript. Claude and ChatGPT add the same URL. The only client-specific code is the optional viewer in the last step.
- **Where the code goes.** A new folder `server/`, outside `src/` and outside the site build, so `npm run build` makes the same `dist/` as today. It imports `src/engine/*` and `src/collision.ts`, so there is one engine and the answers match the page. Its one new dependency is the MCP SDK (`@modelcontextprotocol/sdk`), named here for rule 8, and it is not loaded by the site.
- **Tools.** Each call is stateless: the caller sends the project's `.scad` text and gets text back. Tools do not change anything outside the call, so they are marked read-only. Step 1 checks whether a Plus or Pro account can use read-only tools if its plan does not allow the rest.
  1. `build_assembly(files, entry)`: the parts and joints, each part's volume and whether it is exact or faceted, and the build messages in the page's own words.
  2. `check_collisions(files, entry, pose)`: the pairs that overlap and the volume of each, from `collide`.
  3. `check_motion(files, entry, joint)`: the stretches of travel where parts overlap, in the words of the page's card. This needs the exact-confirmation code moved out of `Viewport.tsx` first (step 2).
  4. `measure(files, entry, pose, picks)`: the distance, angle or size, from `measure`.
  5. `export_step(files, entry, pose)`: a short-lived download link, with the size and the part list. A model under a size limit that step 1 sets may come back as an embedded file.
- **Not in the tools:** imported STEP and STL files. A model cannot send megabytes through a tool call, so a project with an imported file answers in the build-message style that it needs the site.
- **Limits.** A time limit for each call, a cap on the size of the text sent, and one build at a time for each process. A call that goes over says so in plain words, with what to change, and the next call works. The page's 60 s job rule is the starting point.
- **Sign-in.** Decided in step 1 from what each host accepts: a header with a secret for Claude, and for ChatGPT possibly OAuth or no sign-in. No accounts and no billing.
- **Three stages.** (A) The server on the owner's computer over stdio, as a Claude Desktop extension: no hosting, Claude Desktop only, and it proves the tools. (B) The same server hosted at an HTTPS address, which both products need. (C) Optional: a `ui://` page that draws the model in the chat with the same `createViewer` as the site (`src/components/viewer.ts`), with the collision tint from `setCollisions`. The mesh in a tool result must stay small, so step 1 sets a limit.
- **The site.** No change in how it works. README, the Help dialog and the manual get a short section on using Partscript from Claude or ChatGPT (rule 9), so `test/manual.test.ts` changes too.

### Steps

1. **Read and measure, no code in `src/`.** Re-read both products' documents and ask which plan the owner has. In a plain Node process time one build, one `collide` and one `exportStep`, with the memory used, on the v3 machine and on a small model. Find the largest tool result each host takes, the sign-in each accepts, and the cost of the hosting candidates. Record the numbers in section 2 under the next free F numbers, and stop and tell the owner if a fact above is wrong (rule 10).
2. Move the exact-confirmation chunks out of `Viewport.tsx` into a pure module that the page and the server share. The page behaves as before: tests and the smoke test in both modes.
3. `server/` over stdio with tools 1 to 4 and the tests below.
4. `export_step`, the limits and the messages for a call that goes over.
5. The Claude Desktop extension for stage A. The owner tries it.
6. The hosted server, its sign-in and its URL. The owner adds it to Claude and to ChatGPT.
7. Optional: the viewer page (stage C).
8. README, Help, manual and `CLAUDE.md` in the same commit (rule 9).

### Tests (`test/server.test.ts`, new)

Every expected number is worked by hand, and most are the numbers of `test/collision.test.ts`. The tools are called through the SDK's in-memory client and server, so tool names and schemas are tested as well as the code.

- `build_assembly` on `part("a") cube(10);` gives one part of 1000 mm³, exact.
- `check_collisions` on two 10 mm cubes with the second at x = 8 reports one overlap of 200 mm³. Cubes that touch on a face report none.
- `check_motion` on the hinge of F30 (a 20 by 2 by 5 bar swinging into a wall) says the overlap starts at 27.0963° within 0.01°, and the volume at 28.0963° is 0.5461 mm³. The slider of the Phase 11 tests starts at 15 mm and gives 500 mm³ at 30.
- A project with an error gives the same message, file and line as `ModelBuilder.build` gives the page, compared as strings.
- A call over the time limit answers in plain words and the next call succeeds. A project with an imported file answers that it needs the site.
- The same input twice gives the same answer.

### Acceptance

- [ ] The owner has decided where it runs, who may use it and which ChatGPT plan he has.
- [ ] In Claude Desktop (stage A), Claude builds the hinge snippet above and reports a first contact near 27.10° and about 0.546 mm³ at 28.0963°.
- [ ] Hosted (stage B): the owner adds the URL to Claude and to ChatGPT, both list the tools, and both give the same numbers.
- [ ] A project with an error and a call that runs too long both answer in plain words, and the server stays up.
- [ ] `npm run build` makes the same site as before, with no server code in `dist/`.
- [ ] Optional: the viewer shows the model in both products.
- [ ] README, Help, the manual and `CLAUDE.md` are updated, and `test/manual.test.ts` passes.
- [ ] Tests pass and `scripts/smoke.py` passes in both modes.

**Defaults chosen, which the owner may change:** stateless tools, `.scad` text only, read-only tools, stage A before stage B, one server for both products, no accounts.

**Out of scope:** imported STEP and STL files through the tools, editing the owner's files in place, accounts and billing, a Claude plugin of skills beside the server (Claude's documents say partners often ship one, so it can come later), a listing in either product's directory, ChatGPT on a phone and ChatGPT's agent mode (a third-party page says custom apps do not work there).

---

## Backlog

Work that is wanted or noted but not scheduled. **Nothing here is started, and nothing here is started without the owner's go-ahead.** The owner has not ranked these (18 November 2026), so the groups are by kind, not by priority. The four planned phases are not in this list: Phase 10 (open an assembly STEP as separate parts), Phase 11 (collision detection), Phase 12 (drawings) and Phase 13 (an MCP server, optional) have their own sections above.

Size is a rough guess when the row was written, and nobody has measured it: **S** is a few hours, **M** a day or two, **L** several days or carries the risk the note names. Check it before promising anything. When an item is done, delete its row and add a status note at the top of this file, as the phases do. When the owner asks for one, give it a section of its own like the phases and keep its ID.

### Features

| ID | Item | Size | Note |
|---|---|---|---|
| B1 | Share by link | S | Encode a small project in the URL fragment (deflate + base64url). Agreed with the owner early on and still wanted. Assets are too large for a link. |
| B2 | Parameter panel | M | Sliders for top-level variables with OpenSCAD customizer comments (`// [0:0.05:1]`), fed through `-D`. |
| B3 | Limits on closing joints | M | A closing joint's travel is not limited today. |

### Engine

| ID | Item | Size | Note |
|---|---|---|---|
| B4 | Faster evaluation | M | A pool of two or three OpenSCAD workers for projects with many part files. |
| B5 | Exact `rotate_extrude` | L | Revolve the `Flat` leaves. Needs faces, so needs the wire recipe with shared vertices and arcs. |
| B6 | Exact geometry mixed with faceted in one part | L | Boolean an exact solid with a meshed one. OCCT booleans on thousands of facets are slow and can fail. |
| B7 | `offset` over booleans | L | Needs real 2D faces and a 2D offset the kernel wrapper does not expose. |

### Small fixes

| ID | Item | Size | Note |
|---|---|---|---|
| B8 | Size readout in a tilted pose | S | The X, Y, Z chip in an assembly rotates each part's bounding box and merges them, so it over-reports when a joint is turned off-axis (86.64 mm against a true 78.72 mm in the owner's tilted motor). The 3D view, Measure and the STEP are right. The owner chose not to fix it on 17 November 2026. Fix: take the size from the mesh points. |
| B9 | Missing semicolon message | S | A line that lacks its `;` gives OpenSCAD's own "module cube() does not support child modules", which says nothing about a semicolon. Say it in plain words, with the line before. Found while writing the manual, 17 November 2026. |
| B10 | `text()` message | S | `text()` draws nothing because no fonts are bundled, and the build says "This model has no solid volume. Check the dimensions and Boolean operations." Say that `text()` is not available. Found while writing the manual, 17 November 2026. |
| B11 | Open mesh volume | S | An STL that is not closed shows a volume in the asset panel as if it were exact. Mark it approximate there too. |

### Dropped for now

| Item | Why |
|---|---|
| IGES import | Not needed for now (owner, 18 November 2026). It is also not available in `occt-wasm` 5.17.2. The Help dialog already tells a person to download or export the STEP version of an IGES file. Bring it back to the list only if the owner asks. |

---

## Appendix. Starting point for the fan folder assembly

This is a sketch for the acceptance checks of phases 2 to 4. It follows the positions in `ff_assembly()` of the v3.3.1 file, and the names are that file's own. It was run once (F22) with the two corrections below, which are applied to the code here, and with the extra parts listed after it. The owner keeps the full file, which is not committed because it is built on the owner's design.

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
      at = [crank_r, 0, z_coupler[0]], value = ff_ang(B_now - ff_A(th_pin)));   // starting guess: the coupler's angle at crank 0

joint("chute", type = "hinge", parent = "frame", child = "rocker",
      at = [O4[0], O4[1], 0], value = psi_now);                    // the rocker's angle at crank 0

joint("rocker_pin", type = "hinge", parent = "coupler", child = "rocker",   // closes the four-bar
      at = [coupler_len, 0, 0], child_at = [rocker_len, 0, z_coupler[0]]);

joint("roller", type = "slider", parent = "frame", child = "roller", axis = [0, 1, 0],
      follow = "drum", table = [for (a = [0 : 1 : 360]) [a, ff_roller_y(a)]]);
```

Notes for whoever tries it:

- The full version also holds the tray (its own part, a `fixed` joint to the frame), the guard and detent arm (in the frame), the spacers and detent wheel (with the drum), the knob and the crank pin (with the crank), the second pin and the chute stubs (with the rocker), and the roller's axle (with the roller). Each is placed with the same expression `ff_assembly()` uses, moved into its part's frame. Its roller table has 361 rows.
- The design draws the machine in the XY plane and turns it upright with `rotate([90, 0, 0])` at the very end. The sketch leaves it flat. Add `rot = [90, 0, 0]` to `part("frame")` if an upright view is wanted.
- `ff_roller_y` takes the drum angle with the design's sign (`drum_deg = -gear_ratio * crank_deg`). The table's input is the `drum` joint value, which has that same sign, and wraps over 360.
- The design's gears are drawn already meshed at crank 0 (`spin_drum_gear`, `spin_crank_gear`), so no phase offset should be needed.
- `show_labels` only matters in the exploded view, so `text()` (F8) is not reached.
