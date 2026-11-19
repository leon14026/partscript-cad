# Partscript CAD manual

Partscript CAD turns OpenSCAD code into a solid model in your browser and exports it as a STEP file. It can also hang parts from each other with hinges and sliders, so you can move a mechanism and export it in the pose you want. Nothing is uploaded: the calculations run on your computer.

This manual is for a mechanical engineer who knows CAD and does not write code. Every example below builds in the page as it is written, so you can copy it into a blank project and press **Run**. Lengths are in millimetres and angles are in degrees throughout.

## 1. Getting started

**The page.** The code is on the left and the model on the right. Under the code is the **Build output**, which says what was built, how long it took, and what went wrong if something did.

**On a phone.** On a screen narrower than 711 pixels the page shows one pane at a time. It opens on the **Preview**, and the **Preview** and **Code** buttons under the header switch between the two. The file tabs are one row that you swipe sideways, and the two buttons that add a file (**+** and the file button) stay at its right edge. Choosing an example shows its preview, and a red mark on **Code** means the last build failed, so open it to read the message. The buttons below (New, Open, Save file, Save project and the Manual) and **Drawing** are behind the **⋯** button in the header. The joint sliders start folded into a **Joints** button at the bottom left of the preview. A tap opens them as a strip along the bottom, and the model shrinks to fit above it. Scroll the strip when there are more joints than fit. The file picker behind **Open** shows every file on a phone, because an iPhone greys out a `.STEP` it does not recognise; it still refuses a file that is not CAD. Drag one finger to turn the model, pinch to zoom, and drag two fingers to move it. Every button is at least 44 pixels square.

**Buttons in the header.**

- **New** replaces the project with one blank file, `part.scad`. If you have unsaved changes it asks first.
- **Open** takes OpenSCAD files (`.scad`), STEP and STL files to import (`.step`, `.stp`, `.stl`), and saved projects (`.zip`). It refuses anything else and says so. A saved project replaces the project. So does a single `.scad` file when the project has only one file. Otherwise a file joins the project, and Open asks before it replaces a file of the same name. To add a `.scad` file and be sure that nothing is replaced, use the file button beside the **+** (see "Files and tabs").
- **Save file** downloads the file that is open, as it is.
- **Save project** (Ctrl or Cmd + S) downloads every file, imported ones included, as one `.partscript.zip`. The zip is named after the file Run builds, so pin your assembly file (below) before you save.
- **Run** (Ctrl or Cmd + Enter) builds the model. **Cancel** takes its place while a build runs.
- **Drawing** opens dimensioned sheets of the parts, to download as PDF, DXF or SVG (section 9).
- **Export STEP** downloads the model you see. For an assembly it writes one named, coloured component per part, in the pose shown.
- **Examples** opens a menu of ready projects: a swivel arm, a crank-rocker linkage, a gear and cam, and four single parts. They are a good way to see how a finished file looks.

**Files and tabs.** A project is a set of files, each with a tab. The **+** beside the tabs adds a blank file, and the file button next to it adds a `.scad` file from your computer. Neither replaces anything: a file whose name is taken is added with a number, so `arm.scad` becomes `arm_2.scad`, and the page says so. The new file is opened, so pin your main file if you want Run to keep building the assembly. A saved project (`.zip`) is not added this way: use **Open**. The pencil on a tab renames it, the cross deletes it, and the pin makes Run build that file whichever tab is open. Pin the file that lists your parts, so you can edit a part file and still run the whole assembly. A project holds up to 40 files.

**Saving.** The footer says **Draft saved on this device** once your work is kept in the browser. That is one draft, kept between visits. **New** and **Open** replace it, so use **Save project** to keep a project you want to come back to or send to someone.

**Your first part.** Choose **New**, replace the code with this, and press **Run**:

```scad
// A plate 40 x 30 x 5 with an 8 mm hole in the middle
difference() {
  cube([40, 30, 5]);
  translate([20, 15, -1]) cylinder(d = 8, h = 7);
}
```

The model appears with its size under it. Change `d = 8` to `d = 12` and press **Run** again. Press **Export STEP** to download it.

## 2. OpenSCAD in ten minutes

OpenSCAD describes a solid as shapes that you move and combine. There are no sketches: you write the numbers.

| You write | You get |
| --- | --- |
| `cube([x, y, z])` | A box with one corner at the origin, running along +X, +Y and +Z. |
| `cube([x, y, z], center = true)` | The same box, centred on the origin. |
| `cylinder(h = 20, d = 8)` | A round bar standing on the XY plane, along +Z. Use `r` for a radius. |
| `cylinder(h = 20, r1 = 10, r2 = 4)` | A cone: radius 10 at the bottom, 4 at the top. |
| `sphere(d = 10)` | A ball centred on the origin. |
| `translate([x, y, z]) shape` | The shape moved by x, y, z. |
| `rotate([a, b, c]) shape` | The shape turned by a degrees about X, then b about Y, then c about Z. |
| `mirror([1, 0, 0]) shape` | The shape reflected across the plane whose normal is X. |
| `union() { a; b; }` | Both shapes joined. Shapes written side by side are joined anyway. |
| `difference() { a; b; }` | The first shape with every later shape cut out of it. |
| `intersection() { a; b; }` | Only the part that is in both. |
| `linear_extrude(height = h) flat` | A flat shape (`square`, `circle`, `polygon`) pushed up by h. |
| `color("#c0604c") shape` | The shape in a colour. |

A line ends with a semicolon. A shape applies to the one thing after it, or to everything in braces after it.

**Variables.** Give a number a name and use it, so one change updates every place:

```scad
plate_w = 40;   plate_d = 30;   plate_t = 5;
hole = 6;

difference() {
  cube([plate_w, plate_d, plate_t]);
  for (x = [10, 30])                       // one hole at x = 10 and one at x = 30
    translate([x, plate_d / 2, -1]) cylinder(d = hole, h = plate_t + 2);
}
```

The holes start 1 mm below the plate and are 2 mm taller than it, so they cut cleanly through both faces.

**A shape from a flat outline.** Draw the outline in 2D and extrude it. Round parts of the outline become true cylinders in STEP:

```scad
linear_extrude(height = 5)
  difference() {
    square([40, 30]);
    translate([20, 15]) circle(d = 8);
  }
```

**`$fn`.** OpenSCAD lets you set `$fn` to say how many flat sides a round shape has. Do not set it for parts that should be round. A `cylinder` with `$fn` is a many-sided prism, and its holes are polygons in the STEP file. Section 11 explains this, and the build output warns you when it happens.

## 3. Parts

A **part** is one rigid piece of an assembly. A file that calls `part()` is an assembly: it lists the pieces and, with `joint()`, how they connect. Everything in the file must then belong to a part.

```text
part(name, file, at, rot, color, component, body)
```

| Argument | Meaning | Default |
| --- | --- | --- |
| `name` | The part's name, in quotes. Letters, digits, `_`, `.` and `-`, starting with a letter, up to 64 characters. Joints refer to parts by this name, and each name can be used once. | Required |
| `file` | The file that draws the part, in quotes: a project file such as `"arm.scad"`, or an imported file such as `"motor.step"` or `"bracket.stl"`. Leave it out when the shapes are written in braces. | None |
| `at` | Where the part's origin sits in the world, in mm. Only for a part that no joint carries. | `[0, 0, 0]` |
| `rot` | How the part is turned in the world, in degrees, in the order of `translate(at) rotate(rot)`. Only for a part that no joint carries. | `[0, 0, 0]` |
| `color` | `[r, g, b]` with each value from 0 to 1, or a string such as `"#c89d59"`. | The first `color()` inside the part. For a `component` or `body` of a STEP file, the colour the file gives it. Otherwise a colour from a built-in palette. |
| `component` | For a STEP `file`: the name of one part of the assembly inside it, in quotes. A part nested inside another is named by its path, such as `"arm/link"`. | None, which takes the whole file |
| `body` | For a STEP `file`: the number of one solid body in it, counting from 1 in the order the file lists them. The asset's tab shows each part's numbers. | None, which takes the whole file |

**A part written in place.** Put its shapes in braces after `part()`:

```scad
part("base") cube([40, 30, 6]);
part("arm", color = "#c0604c") { translate([0, 0, 6]) cube([8, 8, 40]); }
```

**A part in its own file.** Give `part()` a file name instead. Two parts can use the same file, so a pair of identical arms is one file and two lines. The file is the part's own drawing: its origin is the part's origin, so draw it with the point it pivots on at the origin.

```scad project=arms file=main.scad entry
part("left", "arm.scad");
part("right", "arm.scad", at = [60, 0, 0], rot = [0, 0, 180]);
```

```scad project=arms file=arm.scad
cube([40, 8, 8]);
```

The second block is the file `arm.scad`. Here `right` is the same arm moved 60 mm along X and turned half a turn about Z.

**Rules.**

- Give `part()` a file or braces, not both.
- Give `component` or `body`, not both, and only with a STEP file (section 7).
- Do not wrap a `part()` call in `translate()` or another operation. Put the move inside the braces, or use `at` and `rot`.
- A part that a joint carries is placed by the joint. Do not also give it `at` or `rot` (section 4).
- A shape drawn outside every `part()` is an error once the file declares parts:

```scad error
cube(5);
part("a") cube(3);
```

```text
This file declares parts and also draws shapes outside them. Move the shapes into a part file, or into the braces of a part() call.
```

## 4. Joints

A **joint** hangs one part (the child) from another (the parent). Parts that no joint carries stay where `at` and `rot` put them.

```text
joint(name, type, parent, child, at, rot, axis, limits, value,
      child_at, child_rot, follow, ratio, offset, table)
```

Write the arguments by name, as every example here does. The order above is the order OpenSCAD would take them in if you left the names out.

| Argument | Meaning | Unit | Default |
| --- | --- | --- | --- |
| `name` | The joint's name, in quotes. Same rules as a part name. | | Required |
| `type` | `"fixed"` (does not move), `"hinge"` (turns about `axis`) or `"slider"` (moves along `axis`). | | `"fixed"` |
| `parent` | The name of the part that carries the joint. | | Required |
| `child` | The name of the part that hangs from it. | | Required |
| `at` | The joint's position, in the parent's coordinates. | mm | `[0, 0, 0]` |
| `rot` | The joint's orientation, in the parent's coordinates. Same order as `translate(at) rotate(rot)`. | degrees | `[0, 0, 0]` |
| `child_at` | The same joint position, in the child's coordinates. | mm | `[0, 0, 0]` (the child's origin) |
| `child_rot` | The same joint orientation, in the child's coordinates. | degrees | `[0, 0, 0]` |
| `axis` | The direction of motion, in the joint's own frame. Any length except zero. | | `[0, 0, 1]` |
| `limits` | `[lowest, highest]` travel. A hinge with no limits turns all the way round. A slider must have limits. A fixed joint takes none. | degrees (hinge), mm (slider) | Hinge `[-180, 180]` |
| `value` | The position the model opens in. It must lie inside `limits`. | degrees or mm | 0, or the nearest limit when 0 is outside |
| `follow`, `ratio`, `offset`, `table` | Make this joint move with another one. See section 5. | | None |

**How the child is placed.** With the joint at zero, the point `child_at` of the child sits on the point `at` of the parent, and their frames line up. Then the joint moves the child: a hinge turns it about `axis` through that point, and a slider pushes it along `axis`. A positive hinge angle turns right-handed about `axis`: point your right thumb along the axis and your fingers curl the way it turns.

**A worked example: a two-link arm.** Each link is drawn with its pivot at its origin and runs along +X. The shoulder sits on the base 30 mm along and 20 mm across the top. The elbow sits at the far end of the upper link, so it is at `[link1, 0, 0]` in that link's coordinates.

```scad
base_h = 10;   link1 = 60;   link2 = 40;

part("base", color = "#8d99a6") cube([60, 40, base_h]);
part("upper", color = "#c0604c") { translate([0, -4, -4]) cube([link1, 8, 8]); }
part("fore",  color = "#6fa8a0") { translate([0, -4, -4]) cube([link2, 8, 8]); }

// Axis [0, -1, 0]: a positive angle lifts the link.
joint("shoulder", type = "hinge", parent = "base",  child = "upper",
      at = [30, 20, base_h], axis = [0, -1, 0], limits = [0, 90], value = 30);
joint("elbow",    type = "hinge", parent = "upper", child = "fore",
      at = [link1, 0, 0],    axis = [0, -1, 0], limits = [0, 120], value = 40);
```

The preview shows a slider for each joint that can move. Dragging one moves the parts and recalculates no geometry, so it stays quick. **Reset** returns every joint to the `value` in the code. Now change one thing at a time and press **Run**:

1. Change the shoulder's `value` from 30 to 60. The whole arm lifts.
2. Change `link1` to 80. The upper link is longer and the elbow moves out with it.
3. Change the shoulder's `axis` to `[0, 0, 1]`. The arm now swings sideways.
4. Change the elbow's `limits` to `[0, 60]`. The elbow slider stops at 60.
5. Change the shoulder to `type = "slider"`, `axis = [0, 0, 1]`, `limits = [0, 20]` and `value = 10`. The arm now rides straight up and down instead of turning. A slider needs `limits`, and `value` has to lie inside them.

**A slider and a fixed joint.** The carriage slides 70 mm along the rail. A cover is fixed to the carriage and travels with it:

```scad
part("rail") cube([100, 20, 6]);
part("carriage", color = "#c89d59") cube([20, 16, 8]);
part("cover", color = "#6fa8a0") cube([20, 16, 2]);

joint("slide", type = "slider", parent = "rail", child = "carriage",
      at = [5, 2, 6], axis = [1, 0, 0], limits = [0, 70], value = 20);
joint("cover_on", type = "fixed", parent = "carriage", child = "cover", at = [0, 0, 8]);
```

**Order.** Joints are read in the order they are written, and each one carries a part from a part that is already placed. Write them from the base outwards. A joint between two parts that are already connected closes a loop (section 5).

**Seeing inside.** Open **Parts** in the preview toolbar and untick a part to hide it. The part leaves the picture but still goes into **Export STEP**. A part that you want to hide on its own needs its own `part()`.

**Mistakes the build catches.** Each message names the joint:

```scad error
part("a") cube(3);
part("b") cube(3);
joint("j", type = "slider", parent = "a", child = "b");
```

```text
joint("j"): a slider needs limits in millimetres, for example limits = [0, 40].
```

```scad error
part("a") cube(3);
part("b") cube(3);
joint("j", type = "hinge", parent = "a", child = "b", limits = [0, 90], value = 120);
```

```text
joint("j"): value 120 is outside limits [0, 90].
```

```scad error
part("a") cube(3);
part("b", at = [5, 0, 0]) cube(3);
joint("j", type = "fixed", parent = "a", child = "b");
```

```text
joint("j"): "b" also has at or rot on its part() line. Place it with the joint's at and rot.
```

## 5. Linkages and driven joints

### Closed loops

A joint between two parts that are already connected closes a loop. In a four-bar linkage three hinges carry the crank, the coupler and the rocker, and the fourth hinge closes the ring. Its `child_at` says where the joint sits on the child when that is not the child's origin:

```scad
ground_length = 80;   crank_length = 25;   coupler_length = 90;   rocker_length = 60;
t = 6;                                          // link thickness

module link(length) {                           // a bar with a round boss at each pin
  translate([0, -6, 0]) cube([length, 12, t]);
  for (x = [0, length]) translate([x, 0, 0]) cylinder(d = 18, h = t);
}

part("ground", color = "#8d99a6") { translate([-22, -22, 0]) cube([ground_length + 44, 44, t]); }
part("crank", color = "#c0604c") link(crank_length);
part("coupler") link(coupler_length);
part("rocker", color = "#6fa8a0") link(rocker_length);

joint("crank",      type = "hinge", parent = "ground",  child = "crank",   at = [0, 0, t], value = 40);
joint("crank_pin",  type = "hinge", parent = "crank",   child = "coupler", at = [crank_length, 0, t]);
joint("rocker",     type = "hinge", parent = "ground",  child = "rocker",  at = [ground_length, 0, t], value = 100);
joint("rocker_pin", type = "hinge", parent = "coupler", child = "rocker",
      at = [coupler_length, 0, 0], child_at = [rocker_length, 0, t]);
```

- The three joints `crank`, `crank_pin` and `rocker` each carry a part, so each has a slider in the preview.
- `rocker_pin` joins the far end of the coupler to the far end of the rocker, which are both already placed. It closes the loop, so it has no slider of its own. The joints around the loop move together to keep it shut.
- Drag any joint of the loop, or press play on one. A hinge without `limits` keeps turning, and any other joint runs back and forth. A move stops where the loop can no longer stay shut, such as the end of the rocker's swing.
- In a loop, the first joint with a `value` is held when the model opens. The `value` on another joint is a starting guess, and it picks between the forms a linkage can assemble in, such as open and crossed. Here `value = 100` on the rocker chooses the open form.
- If the links cannot reach each other, the build output says which joint closes the loop and how far apart its two halves stay. Check the link lengths and the `at` and `child_at` positions.
- A hinge, a slider or a fixed joint can close a loop, so slider-cranks and scissor mechanisms are written the same way.

The **Crank-rocker linkage** example is this mechanism split into one file per link.

### Joints that follow another joint

A joint can take its value from another joint instead of having its own. Give it `follow` with the other joint's name. It then has no slider: the page shows it as a read-only row under the sliders.

| Argument | Meaning | Default |
| --- | --- | --- |
| `follow` | The name of the joint to follow. It must be a joint that can move. | None |
| `ratio` | A multiplier. A gear pair is a ratio. | `1` |
| `offset` | Added at the end, in degrees or mm. | `0` |
| `table` | Rows of `[input, output]`, for motion that a formula gives, such as a cam. | None |

Without a table the follower's value is `offset + ratio × driver`. With a table, the driver's value is looked up in the table first, in straight lines between rows, and the follower's value is `offset + ratio × output`.

A follower takes no `limits` and no `value`. Followers can follow followers. The joint that a follower follows can be part of a closed loop, so one crank can drive a four-bar and a gear train at once. A follower cannot be part of a loop itself.

**The gears and cam example.** This is the whole **Gears and a cam** example. A crank turns a wheel twice as fast the other way, and the wheel lifts a plunger by a formula.

```scad same-as=geared.scad
// Gears and a cam · play "crank" in the preview.
// One joint is driven by hand. The others have follow, so they take
// their value from another joint and show no slider of their own.

// The plunger's lift in mm for a wheel angle in degrees: 0 to 12 mm
// once per turn. Any formula works, because the table below is
// worked out here, when the model is built.
function lift(angle) = 6 * (1 - cos(angle));

part("frame", color = "#8d99a6") {
    cube([100, 50, 6]);
    translate([84, 20, 6]) cube([10, 10, 20]);   // guide for the plunger
}

// Big gear, 20 mm pitch radius, with a handle.
part("crank", color = "#c0604c") {
    cylinder(r = 20, h = 5);
    translate([14, 0, 5]) cylinder(r = 3, h = 8);
}

// Small gear, 10 mm pitch radius: half the size, so twice the turns.
part("wheel", color = "#6fa8a0") {
    cylinder(r = 10, h = 5);
    translate([5, -1, 5]) cube([5, 2, 3]);       // a mark that shows the angle
}

part("plunger", color = "#c89d59") cylinder(d = 5, h = 24);

// No limits: this hinge turns all the way round.
joint("crank", type = "hinge", parent = "frame", child = "crank",
      at = [30, 25, 6], value = 30);

// The pitch circles touch: 20 + 10 = 30 mm between the centres.
// Meshing gears turn opposite ways, so the ratio is -2, not 2.
joint("wheel", type = "hinge", parent = "frame", child = "wheel",
      at = [60, 25, 6], follow = "crank", ratio = -2);

// A table of [wheel angle, travel] rows, linear between rows. This one
// spans a full turn, so the wheel's angle is wrapped into 0 to 360 first.
joint("plunger", type = "slider", parent = "frame", child = "plunger",
      at = [82, 25, 6], axis = [0, 0, 1],
      follow = "wheel", table = [for (a = [0 : 5 : 360]) [a, lift(a)]]);
```

Read it from the top:

1. `function lift(angle)` is the cam's profile: how far the plunger rises, in mm, for a wheel angle in degrees. It is ordinary OpenSCAD, so any formula works. `6 * (1 - cos(angle))` is 0 at 0 degrees and 12 at 180.
2. The four `part()` blocks draw the frame, the big gear, the small gear and the plunger. Each is drawn with its pivot at its own origin. They have no `at`, because joints place them.
3. `joint("crank", ...)` is the one joint you drive by hand. It has no `limits`, so it turns all the way round, and `value = 30` is its opening angle.
4. `joint("wheel", ...)` follows the crank with `ratio = -2`. The wheel is half the size, so it turns twice for each crank turn, and meshing gears turn opposite ways, so the sign is negative. The ratio is the gear pair: gear teeth are not drawn to mesh as they turn.
5. `joint("plunger", ...)` is a slider that follows the wheel through a `table`. The `for` loop builds a row every 5 degrees from 0 to 360, each `[wheel angle, lift]`.

**Table rules.**

- A table needs at least two rows and at most 5,000, and the inputs must increase from one row to the next.
- Past the first or last row the output stays at that row's value. The exception is a hinge that turns without end, meaning one with no `limits` or one that follows another hinge. If the table's inputs run exactly 360 apart, such as 0 to 360, the driver's angle is wrapped into that range, so a cam goes round and round.
- Use a whole-number `ratio` for a hinge that turns fully. Any other ratio makes the follower jump when the driver comes round to its start.

## 6. Several files

A project can have as many as 40 files. Reach one file from another with `include`:

```scad project=shared file=main.scad entry
part("plate", "plate.scad");
part("pin", "pin.scad", color = "#c0604c");
joint("seat", type = "fixed", parent = "plate", child = "pin", at = [20, 15, 0]);
```

```scad project=shared file=params.scad
// Shared dimensions: one place to change them.
plate_t = 6;
hole_d = 8;
```

```scad project=shared file=plate.scad
include <params.scad>
difference() {
  cube([40, 30, plate_t]);
  translate([20, 15, -1]) cylinder(d = hole_d, h = plate_t + 2);
}
```

```scad project=shared file=pin.scad
include <params.scad>
cylinder(d = hole_d - 0.2, h = plate_t + 10);
```

Change `hole_d` in `params.scad`, and both the hole and the pin follow. `include <file.scad>` runs the other file as if its text were here, so keep a shared file to variables, functions and modules, because anything it draws is drawn in every file that includes it. `use <file.scad>` brings in only its modules and functions.

**Editing a part file.** Pin the assembly file's tab, so **Run** keeps building the assembly while a part file is open. An edit rebuilds only the parts whose shapes changed.

**One file per part, or one file for all.** Every part file is a separate OpenSCAD run. For a machine with many parts, writing the parts in braces in one assembly file is faster, because it runs once.

**The BOSL2 library.** Gears, threads, screws and more come from the bundled BOSL2 library. Include it at the top of the file:

```scad
include <BOSL2/std.scad>
include <BOSL2/gears.scad>

difference() {
  spur_gear(mod = 2, teeth = 20, thickness = 8);
  cylinder(d = 8, h = 20, center = true);   // your own round bore, 8 mm
}
```

The library is about 1.2 MB and downloads the first time a project includes it during a visit. Each run that includes it takes about a quarter of a second longer. Other libraries are not available, and a build that includes one says so. The gear is exact. A thread is faceted (section 11). For a round bore, cut your own cylinder as above, because the library's own shaft hole is a coarse polygon.

## 7. Importing STEP and STL files

**Open a file.** Press **Open** and choose a `.step`, `.stp` or `.stl` file, such as a motor or a bearing from GrabCAD or a supplier. It becomes a tab, kept exactly as it was opened. The tab shows the file's size and, after a build, how many solid bodies it holds and how big it is.

**Look at it.** **Show on its own** builds the file by itself, so you can look at it and measure it. **Copy the part line** copies the `part()` line for it. A STEP that holds an assembly also lists its parts, each with its own buttons (see "An assembly in one STEP file" below).

**Use it in an assembly.** Write a `part()` line with the file's name and connect it with a joint like any other part:

```scad assets
part("motor", "motor.step");
part("bracket", "bracket.stl", color = "#5b7a99");
joint("mount", type = "fixed", parent = "motor", child = "bracket", at = [0, 0, 40]);
```

If the name is not in the project, the build says so:

```scad error
part("m", "motor.step");
```

```text
part("m"): motor.step is not in this project.
```

**What to know.**

- **The file name.** An imported file keeps its name, and the name must use letters, digits, `_`, `.` and `-`. A space or a bracket is refused, so a download called `NEMA 17 (1).step` has to be renamed with the pencil on its tab. The extension is lower case.
- **STEP.** A STEP keeps its true curves, so it exports as it came, and its faces, edges and holes can be measured. Its units are converted to millimetres. A `part()` line with only the file's name joins every body in the file into one rigid part, each body where the file puts it, with its colour from `color` or the palette. To take the parts of an assembly one by one, use `component` or `body`.
- **STL.** An STL is a mesh with no units, read as millimetres. It exports with flat faces, so an STL part is always faceted. A mesh with holes in its surface still shows, but its volume is not exact and the STEP export may fail.
- **Inside a `.scad` file.** `import("bracket.stl");` reads an STL of the project by name.
- **Formats that cannot be read.** Files in a CAD program's own format (`.sldprt`, `.ipt`, `.f3d`, `.x_t`) and IGES files cannot be read. Download or export the STEP version, which most models include.
- **Size.** One file can be up to 40 MB and a project up to 120 MB of them. A STEP takes about a second a megabyte to read. A part with thousands of faces is previewed with coarser curves to stay quick. The STEP export is not affected.
- **Saving.** **Save project** includes the imported files, and **Open** reads that zip back. Imported files also stay in the browser's draft between visits.

### An assembly in one STEP file

A STEP can hold a whole assembly: a robot arm from a supplier, or an assembly that this page exported. Open it and the tab lists what is inside, one row for each part, with its colour, its size and its body numbers. The row's eye button builds that part alone, and its copy button copies a `part()` line for it.

Name a part with `component`. The example below is a fixture that was exported with two parts, `plate` and `post`:

```scad assembly
part("plate", "fixture.step", component = "plate");
part("post", "fixture.step", component = "post");
```

Each part keeps the place the file gives it, so the two lines above rebuild the fixture as it was saved. A part also takes the colour the file gives it, unless you write `color`. Then `at` and `rot` move it from there. A `component` that is not in the file lists the ones that are:

```scad assembly error
part("p", "fixture.step", component = "lid");
```

```text
part("p"): fixture.step has no component "lid". It has: plate, post.
```

A file from another program may name its parts "1" to "9", or not name them at all. Then pick a solid with `body`. The tab shows the body numbers of each part, and `body = 2` is the second solid in the file:

```scad assembly
part("post", "fixture.step", body = 2);
```

A part inside another part is named by its path. If `fixture.step` held a part `post` that has a part `cap`, it is `component = "post/cap"`.

**Joints are not in a STEP file.** The file gives each part its place, but not how the parts move, so write the joints yourself. The solid of a part is drawn at its place in the file, not at its own origin, so give `child_at` as the same point in the file's coordinates. Export an assembly with every joint at its zero if you want to articulate it again.

```scad assembly
part("plate", "fixture.step", component = "plate");
part("post", "fixture.step", component = "post");
joint("spin", type = "hinge", parent = "plate", child = "post",
      at = [30, 20, 6], child_at = [30, 20, 6], axis = [0, 0, 1], value = 45);
```

## 8. Measure

Press **Measure** in the preview toolbar and click on the model.

| You click | It reports |
| --- | --- |
| A face | Its area. |
| A hole or a shaft wall | Its diameter and its length. |
| An edge | Its length, and its diameter when it is a circle or an arc. |
| A corner | Its position. |

Click a second thing and the card also gives the distance and the angle between the two. Examples: the centre-to-centre distance of two holes (click the hole walls or their rims), the distance between two parallel faces, the angle between two faces, or the shortest distance between any two exact parts of the model. A line is drawn for a distance when the line is the distance.

- Values are in millimetres, square millimetres and degrees, to 0.001 and 0.01, each with a copy button.
- They are read in the pose shown. Move a joint and the numbers follow. Playing a joint is off while a measurement is shown.
- **Esc** clears the picks, and a second **Esc** leaves the tool. On a phone, tap empty space or **Clear** to clear the picks, and tap **Measure** again to leave the tool. Tap where the manual says click.
- A faceted part offers areas and corners only. Its edges and curves are made of triangles, so they are not measured.

## 9. Drawings

Press **Drawing**, beside **Export STEP**, to turn the parts of the model into dimensioned sheets, one for each part. The dialog shows the sheet as it will print, and downloads it as a PDF, a DXF or an SVG. Run the code first. A drawing is read from the solids of the last build, in the pose shown, so it cannot disagree with the model or the STEP file.

```scad
// One part with a counterbored hole. Run it, press Drawing, and the sheet has a section A-A through the hole.
part("stepped") {
  difference() {
    cube([40, 30, 20]);
    translate([20, 15, -1]) cylinder(d = 6, h = 22);
    translate([20, 15, 12]) cylinder(d = 11, h = 9);
  }
}
```

**What a sheet holds.**

- **Views.** A plate, which has one side under 15 % of its longest, gets two views: the face and one edge. Any other part gets the front, top and right views and an isometric. The default is third angle projection, and first angle is a choice. The views use the model's axes: the front view looks along +Y and shows x across and z up, the top view shows x and y, and the right view shows y and z. A part is drawn in its own coordinates, before `at`, `rot` or a joint place it.
- **Overall sizes** on the views that show them.
- **Holes.** Each kind of round hole is one callout, with a count when there are several: `Ø8 THRU`, `4X Ø3.4 THRU`, `Ø6 DEEP 12`, and `CBORE Ø11 DEEP 8` under the diameter of a counterbored hole. The sizes are read from the cylinders of the solid, not measured off the picture. The places of the holes are given from the lower left corner of the view, as figures along the bottom and the left.
- **A section A-A** when a hole is blind or counterbored, cut through the axis of the first such hole and hatched at 45 degrees. A cutting line with the letters A at its ends is drawn on the view it is cut from.
- **Turned parts.** A shaft, a pulley or a boss turned about one axis gets the diameter of each step and its length.
- **A title block** in the lower right corner: the part, the scale, the sheet, the projection, the units, drawn by, date, revision and material, and the note `DIMENSIONS IN MM. TOLERANCES NOT SPECIFIED.` OpenSCAD has no tolerances, so none are written.

**Sheet and scale.** Choose the sheet, the projection and whether hidden lines are drawn at the top of the dialog.

| Sheet | Size in mm |
| --- | --- |
| ANSI A (the default) | 279.4 x 215.9 |
| A4 | 297 x 210 |
| A3 | 420 x 297 |
| ANSI B | 431.8 x 279.4 |

The scale is the first of 1:1, 1:2, 1:5, 1:10, 1:20 and 1:50 at which the views and their dimensions fit above the title block. A part under 20 mm long on its longest side starts from 10:1 and goes down through 5:1, 2:1 and 1:1. The isometric view has a scale of its own, which is not the one in the title block. If a large part comes out smaller than the paper seems to need, choose the next larger sheet: the room for the views is the sheet above the title block, whose whole height is kept clear. **Hidden lines** is dashed lines for what is behind a surface. With **When there are few**, which is the default, they are drawn for exact parts that have not more than 150 hidden curves in a view. They are never drawn on an isometric view in that setting, and **Always** and **Never** override it.

**The title block** has four fields you fill in: **Drawn by**, **Date**, **Revision** and **Material**, up to 40 characters each. Revision starts as `A`. The date is empty until you type one, because nothing is filled in for you. The fields, the sheet, the projection and the hidden-lines choice are saved with the project: **Save project** and the draft in the browser both keep them, and **Open** brings them back.

**An assembly.** A model with two or more parts gets an assembly sheet first, followed by the sheets of the parts. The assembly sheet is an isometric view of the model in the pose shown, so move a joint and press **Drawing** again to draw another pose. It has a parts list (item, quantity, part and size) and a numbered balloon on each part, joined to a point of the part that can be seen. A part that is hidden behind others gets a dashed leader. Two parts with the same geometry share one sheet and one row of the list, with a quantity, and the dialog marks the sheet `(×2)`.

**What is not on the sheet.** A drawing that looks complete and leaves out a feature is worse than none, so the dialog lists what a sheet leaves out under **Not on this sheet**, and says what to change when there is something to change. The list can say:

- Rounded faces that are not a plain hole, such as fillets, slot ends and part-round holes, are drawn but not dimensioned. So are conical faces (countersinks and chamfers), cylinders on a skewed axis, and any other curved face.
- A hole that cannot be seen square-on in the views drawn is not dimensioned.
- A hole made with `$fn` is a many-sided polygon. Its diameter is read over the corners, and the note names the file and line to change.
- A section through a blind hole is not drawn when the view that would carry its cutting line is not on the sheet.
- Hole callouts are stacked in up to six rows above a view. A callout that does not fit in six is listed and left off.
- A place along a view that would crowd another is left off.
- The part or the assembly is too large for the sheet at 1:50, or the parts list or the balloons do not fit. Choose a larger sheet.

**Exact, faceted and imported parts.** An exact part (section 11) is drawn from its solid, with the hole sizes read as above. A faceted part has only flat faces to read, so it is drawn with its outline and the edges where the surface turns by more than 28 degrees, which is the rule the preview uses. It gets overall dimensions and no hole callouts, and its sheet says it is faceted. An imported STEP is drawn like an exact part, with its hidden lines off unless you choose **Always**, and a hole is dimensioned only when it is wider than Ø4. An imported STL is faceted.

**Files.** The three buttons download what the dialog shows.

| Button | File |
| --- | --- |
| **PDF** | One file with a page for each sheet. The lines are vector lines and the text is Helvetica, so no font file is embedded. |
| **DXF** | ASCII, version R12, in millimetres, which every CAD program reads. The layers are `OUTLINE`, `HIDDEN`, `DIM`, `HATCH`, `TEXT` and `BORDER`, and Ø is written as `%%c`. |
| **SVG** | A picture that opens in a browser or a drawing program. |

With the **All … sheets** box ticked, which is the default when there is more than one sheet, a PDF is one file and an SVG or a DXF is a zip with one file for each sheet. Untick it to download the sheet shown. The same drawing always gives the same file, byte for byte. A file is named after its part, or after the project for a zip or a PDF of several sheets.

On a phone, **Drawing** is behind the **⋯** button, and the dialog is one column, with the sheet at the top and the settings below it.

## 10. Collisions

The preview checks whether parts overlap, in every pose you set. Two parts collide when they share volume. Parts that only touch, on a face, along an edge or at a corner, do not collide.

- **In a pose.** A part that overlaps another turns red, yellow lines show where their surfaces cross, and a card in the preview names the pair. A moment after a joint stops, the card gives the overlap in cubic millimetres, worked out on the exact solids. If the exact solids say the parts only touch, the red goes away. Parts you have hidden with **Parts** are still checked.
- **A part inside another.** A part that sits wholly inside a solid part is a collision too, even though no surface crosses. A part that sits in a hollow of another is not.
- **Faceted parts.** A faceted part has no exact solid to measure (section 11), so a pair that includes one is found from the preview mesh alone, and the card says so. It shows no volume.

**Switching it off.** The **Collisions** button in the preview toolbar turns collision detection off and on. It appears when the model has two or more parts, and it starts on. When it is off the page does no collision work: nothing turns red, and the card, **Check motion** and **Stop at collision** are hidden. The setting belongs to the page and is kept in this browser between visits. The code does not hold it, and `allow_overlap` does not change it.

**Check motion.** Press the magnifier button on a joint's row. The joint turns through its whole travel with the other joints where they are, and the card lists each stretch of the travel where two parts overlap:

```text
crank and frame overlap from 112.4° to 118.9° of crank
6.2 mm³ in the worst of 5 poses checked
```

Each stretch is measured exactly at up to five poses spread through it, and the card gives the largest, so the true worst overlap can be a little more. Press a line to set the joint to the start of that stretch and see the collision. A stretch that starts at the first value of the travel, or lasts to the last, says "the start of the travel" or "the end of the travel". When nothing overlaps, the card says "No overlap in 360 poses of crank". In a loop, the other joints follow, as they do when you move the joint. Press the button again to stop the check.

- The sweep takes a pose every 0.5 mm that any point of any part moves, and every 1° at most for a hinge. It finds the start and the end of each stretch to 0.01° or 0.001 mm.
- Places where the exact solids say the parts only touch are left out, and the card says how many.
- A big model takes a while, and the card shows how far the check has got. A model with many parts and curved shapes can take half a minute for a full turn.
- Check motion tests one joint. The other joints stay where they are, so check again after you move them.

**Stop at collision.** Tick this under the joints. A joint that you drag, type into or play then stops at the last pose before it runs into a part it was clear of, and the card says what stopped it. A pair that already overlaps does not stop it, so a machine that starts in contact can be moved out of it. It is a setting of the page, and the code does not hold it. **Reset** clears the note.

**Overlaps that are meant.** A shaft pressed into a plate, or a gear that is drawn into its shaft, overlaps by design. Name the pair in your code and it is skipped in every check:

```text
allow_overlap(a, b)
```

```scad
part("plate") difference() { cube([40, 40, 8]); translate([20, 20, -1]) cylinder(h = 10, d = 8); }
part("shaft") translate([20, 20, -6]) cylinder(h = 30, d = 8.2);
allow_overlap("plate", "shaft");
```

The toolbar then shows how many pairs are allowed. The order of the two names does not matter. Mistakes the build catches name the call:

```scad error
part("a") cube(3);
part("b", at = [5, 0, 0]) cube(3);
allow_overlap("a", "plate");
```

```text
allow_overlap("a", "plate"): "plate" is not a part. Declare it with part(), or check the name.
```

```scad error
part("a") cube(3);
part("b", at = [5, 0, 0]) cube(3);
allow_overlap("a");
```

```text
allow_overlap(): give two part names in quotes, for example allow_overlap("shaft", "plate").
```

**What it does not do.**

- It does not warn about parts that are close but clear.
- An overlap shallower than 0.001 mm, or smaller than 0.01 mm³ on the exact solids, counts as touching.
- It checks parts against each other, and not a part against itself.
- The preview of a round surface lies up to a thousandth of its radius inside the true surface, so a very tight fit is judged on the exact solids and not on the preview.

## 11. Exact and faceted

The build output says whether each part is **exact** or **faceted**. It matters for the STEP file you export.

**Exact.** The part is built from true planes, cylinders, cones and spheres, and the STEP file holds them. A hole is round in your CAD program. These are exact:

- `cube`, `sphere` and `cylinder` (a cone too), with `translate`, `rotate`, `mirror`, `union`, `difference`, `intersection`, `color` and `render`. Curves stay smooth at any `$fa` and `$fs`.
- `scale`. One factor on all axes keeps flat faces flat. Different factors on the axes are exact in size, but the faces become spline surfaces. A shear, a zero factor or a negative factor is faceted.
- `linear_extrude` of a flat shape, with no `twist` or `scale`. The flat shape can use `circle`, `square`, `polygon` (with holes, not crossing itself), `union`, `difference`, `intersection`, `hull` of convex shapes, `offset`, and `translate`, `rotate`, `mirror` and a single-factor `scale`. An extrusion takes up to 400 pieces and a polygon up to 1,500 points per outline.

**Faceted.** Any other part is meshed by OpenSCAD and shown as it is. Its STEP file has flat faces and no true curves, and it is large, about 4 KiB per face. The common causes are `hull` of 3D shapes, `rotate_extrude`, `minkowski`, `polyhedron`, a twisted or tapered `linear_extrude`, and an imported STL. A thread is a `polyhedron`, so it is faceted and its STEP file is large. The build output names each faceted part and what caused it:

```scad says
hull() { cube(10); translate([0, 0, 14]) sphere(5); }
```

```text
This solid is faceted because it uses hull, so STEP has flat faces.
```

For a faceted part the only fix is to build it from the exact shapes above.

**A safety check.** When a part uses an extrusion, a prism or a scale, the build also compares it with OpenSCAD's own fine mesh of the same shapes. The volume must agree within 0.3% and each side of the bounding box within 0.05 mm. If it does not, the part is made faceted instead and the output says so, so a mistake in the exact builder costs you smooth curves but never a wrong shape.

### The `$fn` trap

A `cylinder` with `$fn` above zero and equal radii is a prism with that many flat sides. It is still exact, so the build says so, but its STEP holds a polygon where you meant a round hole. A face plate built with `$fn` on every cylinder had 343 flat faces. With `$fn` removed it had 25 faces, 8 of them true cylinders.

The build output reports it. From 16 sides up it is an error (the output turns red, and the part still builds and exports). It names the file and the line where `$fn` is set:

```scad says
difference() {
  cube([40, 30, 5]);
  translate([20, 15, -1]) cylinder(d = 8, h = 7, $fn = 48);
}
```

```text
design.scad: 1 cylinder or circle is a 48-sided polygon in STEP, not true round (set on line 3). Delete $fn for true cylinders and round holes.
```

Delete `$fn` and the hole is a true cylinder:

```scad
difference() {
  cube([40, 30, 5]);
  translate([20, 15, -1]) cylinder(d = 8, h = 7);
}
```

Below 16 sides a polygon is often what you meant, such as a hexagonal nut pocket, so the build only logs one line:

```scad says
difference() { cube([30, 30, 8]); translate([15, 15, 2]) cylinder(d = 13, h = 10, $fn = 6); }
```

```text
design.scad: 1 cylinder or circle is a 6-sided polygon in STEP, not true round (set on line 1).
```

A circle with `$fn` inside a `linear_extrude` counts the same way. Set `$fn` only where you want flat sides.

## 12. When something goes wrong

A build that fails shows a red message in the Build output, with the file and line beside it when they are known. Click the file and line to jump there. Here are the common ones.

**OpenSCAD's own messages.** Most come from a typing mistake in the code.

A missing semicolon makes OpenSCAD read the next shape as a child of the line before it. The message names the shape before the gap. Add the `;` at the end of that line:

```scad error
cube([10, 10, 10])
cube(5);
```

```text
module cube() does not support child modules
```

A name that is not defined, or misspelt:

```scad error
cube(size);
```

```text
The variable size is not defined. Fix its spelling, or give it a value above this line, for example size = 1;. If it should come from a file you include, that file does not define it: check that you are including the right version of it.
```

```scad error
gearr(10);
```

```text
There is no module named gearr. Fix its spelling, or include the file that defines it. Libraries other than BOSL2 are unavailable.
```

A file that is not in the project. Add it with **+** or **Open**, or correct the name:

```scad error
include <params.scad>
cube(5);
```

```text
params.scad is not in this project. Add the file or correct the name.
```

**Messages about parts.**

```scad error
part("a") cube(3);
part("a") cube(4);
```

```text
part("a"): this name is used twice. Give every part its own name.
```

```scad error
part("1a") cube(3);
```

```text
part("1a"): names use letters, digits, _ . and -, and start with a letter.
```

```scad error
part("a", "a.scad") cube(3);
```

```text
part("a"): it has both a file and shapes in braces. Use one.
```

```scad error
part("a", "arm.scad");
```

```text
part("a"): arm.scad is not in this project.
```

```scad error
part("a", color = "red") cube(3);
```

```text
part("a"): color must be [r, g, b] with values from 0 to 1, or a string such as "#c89d59".
```

**Messages about joints.** Section 4 shows three more.

```scad error
part("a") cube(3);
joint("j", type = "hinge", parent = "a", child = "b");
```

```text
joint("j"): child "b" is not a part. Declare it with part().
```

```scad error
part("a") cube(3);
part("b") cube(3);
joint("j", type = "hinge", parent = "a", child = "b", limits = [90, 0]);
```

```text
joint("j"): limits must be [lowest, highest].
```

```scad error
part("a") cube(3);
part("b") cube(3);
joint("j", type = "hinge", parent = "a", child = "b", axis = [0, 0, 0]);
```

```text
joint("j"): axis needs a direction such as [0, 0, 1].
```

```scad error
part("a") cube(3);
part("b") cube(3);
joint("k", type = "hinge", parent = "a", child = "b", follow = "nope");
```

```text
joint("k"): follows "nope", which is not a joint. Check the name.
```

```scad error
part("a") cube(3);
part("b") cube(3);
joint("j", type = "hinge", parent = "a", child = "b");
joint("k", type = "slider", parent = "a", child = "b", follow = "j", table = [[0, 0]]);
```

```text
joint("k"): table needs at least two rows, each [input, output], for example table = [[0, 0], [90, 10]].
```

**A loop that cannot close.** The model still builds, and the output says: `The loop at joint "name" cannot close: its two halves stay N mm apart. Check the link lengths and the at and child_at positions.` Check the lengths against the sketch of your mechanism. Links that are too short to reach each other never close. Change the starting guess `value` of another joint in the loop to try another form.

**No solid.** A model with nothing left says so:

```scad error
difference() { cube(5); cube(20, center = true); }
```

```text
This model has no solid volume. Check the dimensions and Boolean operations.
```

`text()` draws nothing here, because no fonts are bundled, and a file that draws only text gives the same message.

**Too slow or too big.** A build that reaches 60 seconds stops with "The job reached 60 seconds. Try a simpler part." A solid with too many triangles to show says "The solid is too complex to preview. Reduce the number of features." Press **Cancel** to stop a build yourself.

**A file that Open refuses.** Open takes only `.scad`, `.step`, `.stp`, `.stl` and project zips. OpenSCAD code in a `.txt` file has to be renamed to end in `.scad`.

## 13. Limits

| What | Limit |
| --- | --- |
| Files in a project | 40 |
| One text file | 256 KiB |
| All text files together | 1 MiB |
| Parts in an assembly | 200 |
| Rows in a `table` | 5,000 |
| One imported file | 40 MB |
| All imported files together | 120 MB |
| Pieces in one extrusion | 400 |
| Points in one polygon outline | 1,500 |
| Time for one build | 60 seconds |
| Coordinates and values in `part()` and `joint()` | Within ±1,000,000 |

**Not available in this version.**

- `text()` (no fonts are bundled).
- Libraries other than BOSL2.
- Native CAD files and IGES files for import.
- Mates solved from faces, and a warning for parts that come close without touching.
- The joints themselves in the STEP file. STEP carries the parts in the pose shown, and not the joints.

## 14. Cheat sheet

**Shapes.**

```text
cube([x, y, z]) / cube([x, y, z], center = true)
cylinder(h = h, d = d)  /  cylinder(h = h, r1 = r1, r2 = r2)
sphere(d = d)
linear_extrude(height = h) square([x, y]) / circle(d = d) / polygon(points)
translate([x, y, z])   rotate([a, b, c])   mirror([x, y, z])   scale(k)
union() {}   difference() {}   intersection() {}   color("#rrggbb")
```

**Rules of thumb.** Millimetres and degrees. A line ends with `;`. `rotate` turns about X, then Y, then Z. Leave `$fn` out for round holes. A name uses letters, digits, `_`, `.` and `-`, and starts with a letter.

**Parts.**

```text
part("name") shape;
part("name", color = "#c0604c") { shapes }
part("name", "file.scad", at = [x, y, z], rot = [a, b, c], color = ...);
part("name", "motor.step");   part("name", "bracket.stl");
part("name", "robot.step", component = "arm");   // one part of an assembly STEP
part("name", "robot.step", component = "arm/link");   // nested: its path
part("name", "robot.step", body = 2);   // the second solid in the file
```

**Joints.**

```text
joint("name", type = "hinge", parent = "a", child = "b",
      at = [x, y, z], rot = [a, b, c],            // the joint, in the parent
      child_at = [x, y, z], child_rot = [a, b, c], // the same joint, in the child
      axis = [0, 0, 1], limits = [low, high], value = v);
```

| `type` | Moves | `limits` | Default `limits` |
| --- | --- | --- | --- |
| `"fixed"` | Does not move. | None allowed. | None |
| `"hinge"` | Turns about `axis`, in degrees. | Optional. | `[-180, 180]`, which turns all the way round |
| `"slider"` | Slides along `axis`, in mm. | Required. | None |

**Following another joint.**

```text
follow = "other"                       value = offset + ratio * other
follow = "other", ratio = -2           a gear pair
follow = "other", table = [[in, out], [in, out], ...]
                                       value = offset + ratio * table(other)
```

**Collisions.**

```text
allow_overlap("a", "b");     // these two parts may overlap, by design
```

Parts that overlap turn red. **Check motion** (the magnifier on a joint) lists where in its travel they overlap, and **Stop at collision** holds a joint at the last clear pose.

**Drawings.** **Drawing** (beside Export STEP) makes one dimensioned sheet for each part, and an assembly sheet with a parts list and balloons. PDF, DXF and SVG downloads. The sheet, the projection and the title block fields are saved with the project. What a sheet leaves out is listed under **Not on this sheet**.

**Working order.** Write joints from the base outwards. A joint between parts that are already connected closes a loop. In a loop, the first joint with a `value` is held, and the others' values are starting guesses.

**Keys.** Ctrl or Cmd + Enter runs. Ctrl or Cmd + S saves the project. Esc clears Measure picks, and a second Esc leaves Measure.
