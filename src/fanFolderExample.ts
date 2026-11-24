import type { ProjectFiles } from './engine/protocol.ts';

/**
 * The owner's hand-cranked label fan folder, version 3.3.1: a pentagon drum turned by a crank through a gear pair, with a
 * crank-rocker linkage that swings the chute. The design file is his, kept here word for word. It includes BOSL2 for its gears.
 */
export const labelFanFolder: ProjectFiles = {
  'label_fan_folder.scad': `// =====================================================================
//  Label fan folder v3: hand-cranked pentagon drum + crank-rocker chute
//  v3 adds print-saving options and a built-in exploded view (part = "exploded")
//  v3.3.1: brackets hidden by default, "plates" view, note on changing settings
//  v3.3: new label stock (50 mm stickers, 3 mm gap, 104.5 mm strip); entry bar clears the flange
//  v3.2: chute top hub printable without supports
//  v3.1: tolerance audit fixes (slip-fit drum, gear backlash, crank bearing, clamp and knob hardware)
//  Requires OpenSCAD 2021.01+ and BOSL2 (github.com/BelfrySCAD/BOSL2)
//
//  Units: mm and degrees.
//  Sheet frame: origin = drum axis, +x toward the gear side, +y up,
//  +z outward from the drive-side plate (z = 0 is its outer face).
//
//  Usage: set \`part\` below (or in the Customizer) and press F6 / export.
//  Animate the linkage: View > Animate, FPS 10, Steps 72.
// =====================================================================
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
include <BOSL2/threading.scad>

/* [Print-saving options] */
// Change these here or with the Customizer checkboxes. A second copy added higher up in the
// file is ignored, because OpenSCAD keeps the last value it reads. Note the spellings (lite_plates).
lite_drum       = true;   // 1.2 mm drum walls and spokes (v1: 2 / 1.6 mm)
lite_plates     = true;   // lightening windows in the side plates (none under the gear guard)
lite_chute      = true;   // 1.2 mm chute walls; cheeks solid only around the pivot
lite_roller     = true;   // thin-wall printed roller (add washers to the axle ends for weight)
tray_open_floor = true;   // tray floor becomes a perimeter frame; the shelf is the floor
roller_pvc      = false;  // stock part: 1-1/4 in. Sch 40 PVC pipe (42.2 mm OD) + two printed hubs

/* [Output] */
show_guard    = true;
show_brackets = false;  // printed table brackets (replaced by steel brackets and clamps)
// Exploded view (part = "exploded")
explode      = 1;      // [0:0.05:1]
explode_anim = false;  // true: $t explodes and reassembles in a loop
show_labels  = true;   // part names in the exploded view
label_size   = 9;      // [4:1:16]
// Crank angle for posing (-1 = follow desktop animation $t)
crank_manual  = -1; // [-1:5:360]
part = "assembly"; // [assembly, exploded, plates, fit_test, drum_test, plate_drive, plate_idle, drum_body, drum_cap, spacer, gear_drum, gear_crank, crank_disk, coupler, rocker, chute, tie, entry_bar, roller, drum_shaft, crank_shaft, stub_drive, stub_idle, roller_axle, pin, collar, guard, handle, knob, detent_wheel, detent_arm, bracket, thumbscrew, tray_half, tray_key, tray_riser]

// ---------- 1. Measure before CAD ----------
liner_w          = 104.5; // measured: strip width, edge to edge
table_lip_t      = 38;   // thickness of the table's front edge
table_above_drum = 150;  // table top height above the drum axis
bed_xy           = 245;  // QIDI Q1 Pro bed

// ---------- 2. Web ----------
label_len        = 50;   // measured: sticker length along the strip
label_gap        = 3;    // measured: bare liner between stickers
label_w          = liner_w; // across the strip: not used by any part
labels_per_panel = 5;
pitch            = label_len + label_gap;
panel_len        = labels_per_panel * pitch;

// ---------- 3. Drum ----------
drum_sides   = labels_per_panel;   // 1 revolution = 1 panel
drum_R       = pitch / (2 * sin(180 / drum_sides));
drum_apothem = pitch / (2 * tan(180 / drum_sides));
rib_h        = 0.8;    // small corner rib: must sit inside the 3 mm gap
rib_w        = 1.6;
drum_guide_w = liner_w + 2;
flange_t     = 3;
flange_R     = drum_R + rib_h + 5;
drum_len     = drum_guide_w + 2 * flange_t;
drum_test_w  = 42;     // guide width of the short registration-test drum
drum_wall    = lite_drum ? 1.2 : 2;
spoke_t      = lite_drum ? 1.2 : 1.6;
shaft_d      = 8;
d_flat       = 0.8;                // depth of the D-flat on printed shafts

// ---------- 4. Gears ----------
gear_mod       = 2;
z_drum         = 20;
z_crank        = 40;
pressure_angle = 20;
gear_thk       = 8;
gear_backlash  = 0.3;    // audit: 0.2 left too little margin for printed teeth
gear_cd        = gear_mod * (z_drum + z_crank) / 2;
gear_ratio     = z_crank / z_drum;
drum_gear_OR   = gear_mod * (z_drum + 2) / 2;
crank_gear_OR  = gear_mod * (z_crank + 2) / 2;

// ---------- 5. Linkage (crank-rocker) ----------
crank_r         = 20;
coupler_len     = 90;
rocker_len      = 40;
ground_len      = sqrt(rocker_len*rocker_len - crank_r*crank_r + coupler_len*coupler_len);  // 96.44: symmetric swing (time ratio 1)
crank_phase_deg = 0;    // tune: crank pin angle vs drum (slotted disk, +/-15)
crank_slot_deg  = 15;
link_w          = 10;
link_t          = 5;
pin_d           = 6;
pin_len         = 12;
crank_disk_r    = 36;
crank_disk_t    = 6;
crank_screw_r   = 30;
rocker_hub_d    = 22;
rocker_branch   = -1;   // assembly branch of the four-bar (-1 = rocker below pivot)

// ---------- 6. Layout (sheet XY) ----------
chute_drop = 75;
O4  = [0, -chute_drop];                                    // chute pivot
G_y = (ground_len*ground_len - gear_cd*gear_cd - chute_drop*chute_drop) / (2*chute_drop);
G   = [sqrt(gear_cd*gear_cd - G_y*G_y), G_y];              // crank axis

// ---------- 7. Axial stack, drive side (z from plate outer face) ----------
z_gear      = [1, 9];
z_disk      = [9, 15];
z_rocker    = [10, 15];
z_coupler   = [16, 21];
guard_depth = 28;

// ---------- 8. Chute ----------
chute_len   = 120;
chute_gap   = 6;
chute_mouth = 36;     // 40 in the sheet; 36 keeps 3+ mm clear of the flange
mouth_h     = 8;
chute_wall  = lite_chute ? 1.2 : 2;

// ---------- 9. Hold-down roller and detent ----------
roller_d       = roller_pvc ? 42.2 : 42;   // big enough for its axle to pass over the flanges
roller_wall    = lite_roller ? 1.2 : 2.5;
pvc_id         = 35.05;  // 1-1/4 in. Sch 40 PVC inside diameter
roller_len     = drum_guide_w - 2;
axle_d         = shaft_d;
detent_wheel_r = 20;
detent_t       = 5;
detent_depth   = 1.5;
detent_flex_l  = 25;
detent_flex_t  = 1.6;
detent_preload = 0.8;

// ---------- 10. Casing ----------
plate_t     = 5;
plate_x     = [-75, 110];   // widened so the entry bar clears the drum flange
plate_y     = [-130, 80];
corner_r    = 10;
channel_w   = 130;      // between plates (room for drum spacers and chute cheeks)
tie_d       = 12;
entry_d     = 16;
tie_hole    = 5.5;      // M5 threaded rod
ties        = [[95, 50], [95, -110], [-55, -110]];
entry_pos   = [-62, 5];
guard_wall  = 2;
guard_clear = 3;
guard_lugs  = [[-42, -30], [100, 36], [75, -78]];
clamp_holes = [[-50, 40], [-50, 70]];
clamp_slot_travel = 60;
loop_space  = 120;      // table front face to bracket riser (room for the slack loop)
bracket_t   = 10;
jaw_depth   = 30;
thumb_d     = 16;
thumb_pitch = 2;
handle_len  = 50;
handle_gap  = 3;        // guard face to handle (audit: was 1 mm)

// ---------- 11. Tray ----------
tray_inner_len = panel_len + 6;
tray_inner_w   = liner_w + 10;
tray_wall_h    = 60;
tray_wall_t    = 3;
tray_floor_t   = 3;
tray_rail_h    = 20;
riser_h        = 15;
tray_frame     = 18;     // frame width when tray_open_floor is on
start_drop     = 60;    // chute exit to tray floor

// ---------- 12. Tolerances ----------
run_clear   = 0.3;
press_clear = 0.1;      // press fits: pins, gears, collars, chute ends, detent wheel, handle
slip_clear  = 0.25;     // slip fit: drum and spacers slide along the shaft (D-flat carries the torque)
$slop = 0.12;           // BOSL2 thread clearance
$fa = 4;
$fs = 0.5;

// =====================================================================
//  Derived values
// =====================================================================
chute_w      = channel_w - 2;
chute_slot_w = drum_guide_w;
cheek_t      = (chute_w - chute_slot_w) / 2;
mouth_reach  = norm([chute_mouth/2 + chute_wall, mouth_h]);

roller_y_min = drum_apothem + roller_d/2;
roller_y_max = drum_R + rib_h + roller_d/2;

z_drive_in = -plate_t;
z_idle_in  = -plate_t - channel_w;
z_idle_out = z_idle_in - plate_t;
z_c        = -plate_t - channel_w/2;

spacer_len = (channel_w - drum_len)/2 - 0.5;

drum_shaft_z  = [z_idle_out - detent_t - 2, z_gear[1] + 1];
crank_shaft_z = [z_drive_in - 6, guard_depth + handle_gap + 12];
stub_drive_z  = [z_drive_in - 1 - cheek_t, z_rocker[1]];
stub_idle_z   = [z_idle_out - 6, z_idle_in + 1 + cheek_t];
axle_z        = [z_idle_out - 6, 6];

detent_bump_y = -(detent_wheel_r + 3 - detent_preload);
detent_base   = [-detent_flex_l - 6, detent_bump_y];
detent_holes  = [detent_base + [0, 5], detent_base + [0, -5]];

rail_t     = tray_wall_t;
half_len   = tray_inner_len/2 + tray_wall_t;
tray_w_out = tray_inner_w + 2*rail_t;

// ---------- Four-bar kinematics ----------
function ff_ang(v) = atan2(v[1], v[0]);
function ff_int(c1, r1, c2, r2, s) =
    let(d = norm(c2 - c1),
        a = (r1*r1 - r2*r2 + d*d) / (2*d),
        h = sqrt(max(r1*r1 - a*a, 0)),
        u = (c2 - c1) / d)
    c1 + a*u + s*h*[-u[1], u[0]];
function ff_A(th) = G + crank_r * [cos(th), sin(th)];
function ff_B(th) = ff_int(O4, rocker_len, ff_A(th), coupler_len, rocker_branch);
function ff_mu(th) = let(A = ff_A(th), B = ff_B(th), v1 = A - B, v2 = O4 - B)
    acos((v1*v2) / (norm(v1)*norm(v2)));

B_ext      = ff_int(O4, rocker_len, G, coupler_len + crank_r, rocker_branch);
B_fold     = ff_int(O4, rocker_len, G, coupler_len - crank_r, rocker_branch);
psi_ext    = ff_ang(B_ext - O4);
psi_fold   = ff_ang(B_fold - O4);
psi_mid    = (psi_ext + psi_fold) / 2;
swing      = abs(psi_ext - psi_fold);
th_ext     = ff_ang(B_ext - G);
th_fold    = ff_ang(G - B_fold);
stroke_a   = (th_fold - th_ext + 720) % 360;
time_ratio = max(stroke_a, 360 - stroke_a) / min(stroke_a, 360 - stroke_a);
mus        = [for (th = [0:5:355]) ff_mu(th)];

// Roller height resting on the rotating pentagon (for the assembly view)
function ff_roller_y(dd) = let(
    r  = roller_d/2,
    vy = [for (i = [0:drum_sides-1])
            let(a = 90 + dd + i*360/drum_sides, v = (drum_R + rib_h)*[cos(a), sin(a)])
            if (abs(v[0]) < r) v[1] + sqrt(r*r - v[0]*v[0])],
    fy = [for (i = [0:drum_sides-1])
            let(a = 90 + dd + (i + 0.5)*360/drum_sides, n = [cos(a), sin(a)])
            if (n[1] > 0.01) let(y = (drum_apothem + r)/n[1])
            if (abs(n[0]*y) <= pitch/2) y])
    max(concat(vy, fy));

// ---------- Animation state ----------
crank_deg = crank_manual >= 0 ? crank_manual : $t * 360;
th_pin    = crank_deg + crank_phase_deg;
drum_deg  = -gear_ratio * crank_deg;
B_now     = ff_B(th_pin);
psi_now   = ff_ang(B_now - O4);
chute_deg = psi_now - psi_mid;
beta      = ff_ang(G);                                  // gear line angle
spin_drum_gear  = -90 + beta;                           // BOSL2 meshing convention
spin_crank_gear = 90 - 180/z_crank + beta;

// =====================================================================
//  Design checks
// =====================================================================
links = [crank_r, coupler_len, rocker_len, ground_len];
assert(min(links) == crank_r, "Crank must be the shortest link");
assert(crank_r + max(links) <= coupler_len + rocker_len + ground_len - max(links),
       "Grashof condition fails: crank will not rotate fully");
assert(rib_w <= label_gap - 1, "Ribs too wide for the label gap");
assert(norm(entry_pos) - entry_d/2 - flange_R >= 3, "Entry bar hits the drum flange");
assert(min([for (p = ties) norm(p) - tie_d/2 - flange_R]) >= 3, "A tie hits the drum flange");
assert(abs(ground_len - gear_cd) <= chute_drop && chute_drop <= ground_len + gear_cd,
       "No crank axis position satisfies gear_cd and ground_len");
assert(chute_drop - flange_R - mouth_reach >= 3, "Chute mouth hits the drum flange");
assert(panel_len < tray_inner_len && tray_inner_len < panel_len + pitch,
       "Tray length must hold 5 labels but not 6");
assert(roller_y_min - axle_d/2 - flange_R >= 1, "Roller axle hits the drum flanges");
assert(ground_len - crank_disk_r - (rocker_len + link_w/2 + 2) >= 3, "Rocker hits the crank disk");
assert(gear_cd - crank_disk_r - drum_gear_OR >= 1.5, "Crank disk hits the drum gear");
assert(channel_w - drum_len >= 4, "Channel too narrow for drum spacers");
assert(abs(psi_ext - psi_fold) < 180, "Rocker angles wrap; flip rocker_branch");
assert(max(plate_x[1] - plate_x[0], plate_y[1] - plate_y[0]) <= bed_xy, "Side plate exceeds bed");
assert(max(half_len, tray_w_out) <= bed_xy, "Tray half exceeds bed");
assert(max(loop_space + jaw_depth + 34, table_above_drum + 10 - (clamp_holes[0][1] - clamp_slot_travel/2 - 8)) <= bed_xy,
       "Bracket exceeds bed: reduce loop_space or table_above_drum");

echo(str("\\n==== FAN FOLDER SUMMARY ====",
    "\\n drum_R = ", drum_R, "   apothem = ", drum_apothem, "   flange_R = ", flange_R,
    "\\n gear_cd = ", gear_cd, "   (BOSL2 gear_dist = ",
        gear_dist(mod=gear_mod, teeth1=z_drum, teeth2=z_crank, profile_shift1=0, profile_shift2=0), ")",
    "\\n crank axis G = ", G, "   chute pivot O4 = ", O4,
    "\\n chute swing = ", swing, " deg   exit travel = +/-", chute_len*sin(swing/2), " mm",
    "\\n transmission angle = ", min(mus), " to ", max(mus), " deg",
    "\\n time ratio = ", time_ratio,
    "\\n channel_w = ", channel_w, "   chute cheek_t = ", cheek_t,
    "\\n shaft lengths: drum ", drum_shaft_z[1]-drum_shaft_z[0], ", crank ", crank_shaft_z[1]-crank_shaft_z[0],
        ", stub drive ", stub_drive_z[1]-stub_drive_z[0], ", stub idle ", stub_idle_z[1]-stub_idle_z[0],
        ", roller axle ", axle_z[1]-axle_z[0],
    "\\n============================"));

// =====================================================================
//  Helpers
// =====================================================================
module ff_rrect(x0, x1, y0, y1, r)
    translate([x0, y0]) offset(r=r) offset(delta=-r) square([x1 - x0, y1 - y0]);

// D-shaped profile: flat on the +y side
module ff_dshaft_2d(d = shaft_d, c = 0)
    intersection() {
        circle(d = d + c);
        translate([-d, -d]) square([2*d, d + d/2 - d_flat + c/2]);
    }

module ff_arc_slot(r, a0, a1, w)
    for (a = [a0 : 2 : a1 - 2]) hull() {
        rotate(a)     translate([r, 0]) circle(d = w);
        rotate(a + 2) translate([r, 0]) circle(d = w);
    }

// Lay a z-axis part on its +y flat for printing
module ff_print_lying(off)
    translate([0, 0, off]) rotate([-90, 0, 0]) rotate([0, 90, 0]) children();

// =====================================================================
//  Drum
// =====================================================================
module ff_drum_2d() {
    rotate(90) circle(r = drum_R, $fn = drum_sides);
    for (i = [0 : drum_sides - 1]) rotate(90 + i*360/drum_sides)
        translate([drum_R - 3, -rib_w/2])
            offset(r = rib_w/4) offset(delta = -rib_w/4) square([3 + rib_h, rib_w]);
}

// Body with integral base flange; prints standing on the flange.
// guide = width between flanges (the drum_test part uses a short one).
module ff_drum_body(guide = drum_guide_w) {
    L = guide + 2*flange_t;
    difference() {
        union() {
            cylinder(r = flange_R, h = flange_t);
            linear_extrude(L) ff_drum_2d();
        }
        translate([0, 0, flange_t]) linear_extrude(L)
            difference() {
                offset(delta = -drum_wall) rotate(90) circle(r = drum_R, $fn = drum_sides);
                circle(d = shaft_d + 6);
                for (i = [0 : drum_sides - 1])
                    rotate(90 + 180/drum_sides + i*360/drum_sides)
                        translate([0, -spoke_t/2]) square([drum_R, spoke_t]);
            }
        translate([0, 0, -1]) linear_extrude(L + 2) ff_dshaft_2d(shaft_d, slip_clear);
        translate([0, 0, 10]) cylinder(d = shaft_d + 1, h = L - 20);   // relief: bore engages only 10 mm at each end
        // home mark under vertex 0
        rotate(90) translate([flange_R - 6, 0, -0.01])
            linear_extrude(0.6) polygon([[-3, -3], [3, 0], [-3, 3]]);
    }
}

// Second flange, press-fits over the far end of the body
module ff_drum_cap()
    difference() {
        cylinder(r = flange_R, h = flange_t);
        translate([0, 0, -1]) linear_extrude(flange_t + 2) offset(delta = press_clear) ff_drum_2d();
    }

module ff_spacer()
    linear_extrude(spacer_len) difference() { circle(d = 16); ff_dshaft_2d(shaft_d, slip_clear); }

module ff_collar()
    linear_extrude(5) difference() { circle(d = 16); ff_dshaft_2d(shaft_d, press_clear); }

// =====================================================================
//  Gears and crank
// =====================================================================
module ff_gear(teeth, spin)
    spur_gear(mod = gear_mod, teeth = teeth, thickness = gear_thk,
              pressure_angle = pressure_angle, backlash = gear_backlash,
              profile_shift = 0, gear_spin = spin, anchor = BOTTOM);

module ff_gear_drum()
    difference() {
        union() {
            ff_gear(z_drum, spin_drum_gear);
            translate([0, 0, -1]) cylinder(d = shaft_d + 8, h = 1.01);   // 1 mm spacer to plate
        }
        translate([0, 0, -2]) linear_extrude(gear_thk + 4) ff_dshaft_2d(shaft_d, press_clear);
    }

module ff_gear_crank()
    difference() {
        union() {
            ff_gear(z_crank, spin_crank_gear);
            translate([0, 0, -1]) cylinder(d = shaft_d + 8, h = 1.01);
        }
        translate([0, 0, -2]) linear_extrude(gear_thk + 4) ff_dshaft_2d(shaft_d, press_clear);
        for (a = [60, 180, 300]) rotate(a)
            translate([crank_screw_r, 0, 1]) cylinder(d = 2.6, h = gear_thk);   // M3 self-tap
    }

// Crank disk: bolts to the 40T gear through arc slots (continuous phase adjust)
module ff_crank_disk()
    linear_extrude(crank_disk_t) difference() {
        circle(r = crank_disk_r);
        circle(d = shaft_d + run_clear + 0.2);
        translate([crank_r, 0]) circle(d = pin_d + press_clear);
        for (a = [60, 180, 300]) ff_arc_slot(crank_screw_r, a - crank_slot_deg, a + crank_slot_deg, 3.4);
        for (a = [-15 : 5 : 15]) rotate(a) translate([crank_disk_r - 3, -0.4]) square([4, 0.8]); // phase ticks
    }

module ff_handle() {
    hub_h = 12;
    difference() {
        union() {
            cylinder(d = 20, h = hub_h);
            linear_extrude(6) hull() { circle(d = 20); translate([handle_len, 0]) circle(d = 14); }
        }
        translate([0, 0, -1]) linear_extrude(hub_h + 2) ff_dshaft_2d(shaft_d, press_clear);
        translate([handle_len, 0, -1]) cylinder(d = 5.4, h = 8);                  // M5 knob axle
        translate([handle_len, 0, -1]) cylinder(d = 9.6, h = 5.2, $fn = 6);      // M5 nut pocket, underside
        translate([0, 0, hub_h - 3]) rotate([0, -90, 0]) cylinder(d = 2.6, h = 12); // M3 set screw
    }
}

module ff_knob()
    linear_extrude(30) difference() { circle(d = 20, $fn = 16); circle(d = 5.6); }

// =====================================================================
//  Linkage
// =====================================================================
module ff_link_2d(len)
    difference() {
        union() {
            hull() { circle(d = link_w); translate([len, 0]) circle(d = link_w); }
            circle(d = link_w + 4);
            translate([len, 0]) circle(d = link_w + 4);
        }
        circle(d = pin_d + run_clear);
        translate([len, 0]) circle(d = pin_d + run_clear);
    }

module ff_coupler() linear_extrude(link_t) ff_link_2d(coupler_len);

// Rocker: clamp hub on the chute stub (sets chute centring), arm on top.
module ff_rocker() {
    hub_h = z_rocker[1] - z_gear[0];
    arm_z = z_rocker[0] - z_gear[0];
    difference() {
        union() {
            cylinder(d = rocker_hub_d, h = hub_h);
            translate([0, 0, arm_z]) linear_extrude(link_t)
                hull() { circle(d = rocker_hub_d); translate([rocker_len, 0]) circle(d = link_w + 4); }
        }
        translate([0, 0, -1]) cylinder(d = shaft_d + run_clear, h = hub_h + 2);
        translate([rocker_len, 0, -1]) cylinder(d = pin_d + press_clear, h = hub_h + 2);
        translate([-rocker_hub_d/2 - 1, -0.75, -1])
            cube([rocker_hub_d/2 + 1 - shaft_d/2 + 0.5, 1.5, hub_h + 2]);           // clamp slit
        translate([-(shaft_d/2 + 3.5), 0, (arm_z)/2])
            rotate([90, 0, 0]) { cylinder(d = 3.4, h = rocker_hub_d/2 + 1);                 // M3 clearance side
                                 mirror([0, 0, 1]) cylinder(d = 2.6, h = rocker_hub_d/2 + 1); } // M3 pilot side
    }
}

// Pin with head; flat on +y so it prints lying down
module ff_pin(len = pin_len)
    intersection() {
        union() {
            cylinder(d = pin_d, h = len);
            translate([0, 0, len]) cylinder(d = pin_d + 4, h = 2);
        }
        translate([-10, -10, -1]) cube([20, 10 + pin_d/2 - 0.6, len + 4]);
    }

module ff_dshaft(len) linear_extrude(len) ff_dshaft_2d(shaft_d, 0);

// =====================================================================
//  Chute (pivot at origin, hangs along -y, width along +z)
// =====================================================================
chute_ribs_y = [-35, -75, -115];   // outer stiffening ribs (keep the tall walls from wobbling while printing)

module ff_chute_wall_2d()
    for (s = [-1, 1]) {
        for (y = chute_ribs_y)
            translate([s > 0 ? chute_gap/2 + chute_wall - 0.01 : -(chute_gap/2 + chute_wall) - 2.49, y - 1.5])
                square([2.5, 3]);
        polygon([
        [s*chute_gap/2, -chute_len], [s*(chute_gap/2 + chute_wall), -chute_len],
        [s*(chute_gap/2 + chute_wall), 0], [s*(chute_mouth/2 + chute_wall), mouth_h],
        [s*chute_mouth/2, mouth_h], [s*chute_gap/2, 0]]);
    }

module ff_chute()
    difference() {
        union() {
            linear_extrude(chute_w) ff_chute_wall_2d();
            for (z0 = [0, chute_w - cheek_t]) translate([0, 0, z0]) {
                // pivot block (full cheek thickness)
                linear_extrude(cheek_t) {
                    intersection() { ff_chute_wall_2d(); translate([-50, lite_chute ? -30 : -chute_len - 1]) square([100, 60 + chute_len]); }
                    translate([-chute_gap/2 - 0.01, lite_chute ? -30 : -chute_len]) square([chute_gap + 0.02, lite_chute ? 30 : chute_len]);
                    circle(r = 9);
                    // fill the flared mouth at the cheek ends (bridges between the flare walls)
                    polygon([[-chute_gap/2, 0], [chute_gap/2, 0], [chute_mouth/2, mouth_h], [-chute_mouth/2, mouth_h]]);
                }
                // 45-degree wedges under the top-end hub (as printed), so it grows out of the walls
                if (z0 > 0) for (s = [-1, 1]) hull() {
                    linear_extrude(0.01) intersection() {
                        circle(r = 9);
                        translate([s > 0 ? chute_gap/2 + chute_wall : -9, -9]) square([9 - chute_gap/2 - chute_wall, 9]);
                    }
                    translate([0, 0, -6]) linear_extrude(0.01)
                        translate([s > 0 ? chute_gap/2 + chute_wall - 0.01 : -(chute_gap/2 + chute_wall), -9]) square([0.01, 9]);
                }
                // slim 3 mm end wall along the rest of the chute, on the web side of the cheek
                if (lite_chute) translate([0, 0, z0 == 0 ? cheek_t - 3 : 0]) linear_extrude(3) {
                    ff_chute_wall_2d();
                    translate([-chute_gap/2 - 0.01, -chute_len]) square([chute_gap + 0.02, chute_len]);
                }
            }
        }
        for (z0 = [-1, chute_w - cheek_t]) translate([0, 0, z0])
            linear_extrude(cheek_t + 1) ff_dshaft_2d(shaft_d, press_clear);
    }

// =====================================================================
//  Hold-down roller (gravity, axle rides in vertical plate slots)
// =====================================================================
module ff_roller()
    linear_extrude(roller_len) difference() {
        union() {
            difference() { circle(d = roller_d); circle(d = roller_d - 2*roller_wall); }
            circle(d = axle_d + run_clear + 0.4 + 2*roller_wall + 2);
            for (a = [0, 120, 240]) rotate(a) translate([0, -roller_wall/2]) square([roller_d/2 - 1, roller_wall]);
        }
        circle(d = axle_d + run_clear + 0.4);
    }

// PVC option: press-fit hub for each end of a 1-1/4 in. Sch 40 pipe cut to roller_len
module ff_roller_hub()
    difference() {
        union() {
            cylinder(d = roller_d, h = 2);
            cylinder(d = pvc_id - 0.15, h = 14);
        }
        translate([0, 0, -1]) cylinder(d = axle_d + run_clear + 0.4, h = 20);
        translate([0, 0, 2]) difference() { cylinder(d = pvc_id - 4, h = 13); cylinder(d = axle_d + 6, h = 13); }
    }

// =====================================================================
//  Detent (one click per panel, idle-side plate)
// =====================================================================
module ff_detent_wheel()
    linear_extrude(detent_t) difference() {
        circle(r = detent_wheel_r);
        ff_dshaft_2d(shaft_d, press_clear);
        rotate(90) translate([detent_wheel_r, 0])
            rotate(45) square(detent_depth*sqrt(2), center = true);   // notch at vertex 0
    }

module ff_detent_arm()
    linear_extrude(detent_t) difference() {
        union() {
            translate(detent_base) square([12, 18], center = true);
            translate([detent_base[0], detent_bump_y - detent_flex_t/2])
                square([-detent_base[0], detent_flex_t]);
            translate([0, detent_bump_y]) circle(r = 3);
        }
        for (p = detent_holes) translate(p) circle(d = 3.4);
    }

// =====================================================================
//  Casing
// =====================================================================
module ff_plate_2d(side)
    difference() {
        ff_rrect(plate_x[0], plate_x[1], plate_y[0], plate_y[1], corner_r);
        circle(d = shaft_d + run_clear);                                  // drum shaft
        translate(O4) circle(d = shaft_d + run_clear);                    // chute stub
        for (p = ties) translate(p) circle(d = tie_hole);
        translate(entry_pos) circle(d = tie_hole);
        hull() {                                                          // roller axle slot
            translate([0, roller_y_min - 1]) circle(d = axle_d + run_clear + 0.4);
            translate([0, roller_y_max + 1]) circle(d = axle_d + run_clear + 0.4);
        }
        for (p = clamp_holes) translate(p) circle(d = 5.5);
        if (side == "drive") {
            translate(G) circle(d = shaft_d + run_clear);
            for (p = guard_lugs) translate(p) circle(d = 2.6);
        }
        if (side == "idle")
            for (p = detent_holes) translate(p) circle(d = 2.6);
    }

win_pitch = 30;   // lightening-window grid
win_web   = 7;    // web between windows

module ff_plate_windows_2d(side)
    offset(r = 3) offset(delta = -3)
    difference() {
        intersection() {
            ff_rrect(plate_x[0] + 8, plate_x[1] - 8, plate_y[0] + 8, plate_y[1] - 8, 4);
            for (gx = [plate_x[0] : win_pitch : plate_x[1]], gy = [plate_y[0] : win_pitch : plate_y[1]])
                translate([gx + win_web/2, gy + win_web/2]) square(win_pitch - win_web);
        }
        circle(r = 13);
        translate(O4) circle(r = 13);
        for (p = concat(ties, [entry_pos])) translate(p) circle(r = 12);
        hull() { translate([0, roller_y_min - 1]) circle(r = 11); translate([0, roller_y_max + 1]) circle(r = 11); }
        for (p = clamp_holes) translate(p) circle(r = 10);
        if (side == "drive") {
            offset(r = guard_wall + 7) ff_guard_2d();   // never open the plate behind the gears
            for (p = guard_lugs) translate(p) circle(r = 10);
        }
        if (side == "idle") {
            for (p = detent_holes) translate(p) circle(r = 10);
            circle(r = detent_wheel_r + 4);
        }
    }

module ff_plate(side)
    linear_extrude(plate_t) difference() {
        ff_plate_2d(side);
        if (lite_plates) ff_plate_windows_2d(side);
    }

module ff_tube(d, l, hole) linear_extrude(l) difference() { circle(d = d); circle(d = hole); }

// Gear guard: covers gears, crank disk and linkage on the drive side
module ff_guard_2d()
    hull() {
        circle(r = drum_gear_OR + guard_clear);
        translate(G) circle(r = max(crank_gear_OR, crank_disk_r) + guard_clear);
        translate(O4) circle(r = rocker_len + (link_w + 4)/2 + guard_clear);
    }

module ff_guard() {
    cen = (G + O4) / 3;
    difference() {
        union() {
            linear_extrude(guard_depth) offset(r = guard_wall) ff_guard_2d();
            for (p = guard_lugs) linear_extrude(guard_depth) hull() {    // full-height lug columns
                translate(p) circle(r = 5);
                translate(p + 14*(cen - p)/norm(cen - p)) circle(r = 5);
            }
        }
        translate([0, 0, -1]) linear_extrude(guard_depth - guard_wall + 1) ff_guard_2d();
        translate([G[0], G[1], -1]) cylinder(d = shaft_d + run_clear, h = guard_depth + 2);   // second crank-shaft bearing
        for (p = guard_lugs) {
            translate([p[0], p[1], -1]) cylinder(d = 3.4, h = guard_depth + 2);
            translate([p[0], p[1], 4]) cylinder(d = 6.5, h = guard_depth);   // counterbore from the face side
        }
    }
}

// Table-edge bracket: riser (height slot) + standoff arm + C-jaw.
// Prints flat. One per side plate (mirror for the idle side).
module ff_bracket() {
    xr      = clamp_holes[0][0];
    x_face  = xr - 12 - loop_space;
    T       = table_above_drum;
    lip_bot = T - table_lip_t - 2;
    slot_y0 = min(clamp_holes[0][1], clamp_holes[1][1]) - clamp_slot_travel/2;
    slot_y1 = max(clamp_holes[0][1], clamp_holes[1][1]) + clamp_slot_travel/2;
    jaw_t   = thumb_d + 10;
    difference() {
        union() {
            linear_extrude(bracket_t) union() {
                ff_rrect(xr - 12, xr + 12, slot_y0 - 8, T + 10, 3);        // riser
                ff_rrect(x_face - jaw_depth, xr + 12, T, T + 10, 3);       // arm + upper jaw
                ff_rrect(x_face, x_face + 10, lip_bot - 12, T + 10, 3);    // spine
            }
            linear_extrude(jaw_t)
                ff_rrect(x_face - jaw_depth, x_face + 10, lip_bot - 12, lip_bot, 3); // lower jaw
        }
        translate([0, 0, -1]) linear_extrude(bracket_t + 2) hull() {
            translate([xr, slot_y0]) circle(d = 5.5);
            translate([xr, slot_y1]) circle(d = 5.5);
        }
        translate([x_face - jaw_depth/2, lip_bot - 13, jaw_t/2]) rotate([-90, 0, 0])
            threaded_rod(d = thumb_d, l = 14, pitch = thumb_pitch, internal = true, anchor = BOTTOM);
    }
}

module ff_thumbscrew() {
    cylinder(d = 30, h = 10, $fn = 12);
    translate([0, 0, 10]) threaded_rod(d = thumb_d, l = 30, pitch = thumb_pitch, bevel = true, anchor = BOTTOM);
}

// =====================================================================
//  Tray (two identical halves joined by bowtie keys)
// =====================================================================
module ff_bowtie_2d(c = 0)
    offset(delta = c) polygon([[-8, -6], [0, -3], [8, -6], [8, 6], [0, 3], [-8, 6]]);

module ff_tray_half()
    difference() {
        union() {
            difference() {
                translate([0, -tray_w_out/2, 0]) cube([half_len, tray_w_out, tray_floor_t]);
                if (tray_open_floor)
                    translate([-1, -(tray_inner_w/2 - tray_frame), -1])
                        cube([tray_inner_len/2 - tray_frame + 1, tray_inner_w - 2*tray_frame, tray_floor_t + 2]);
            }
            translate([tray_inner_len/2, -tray_w_out/2, 0]) cube([tray_wall_t, tray_w_out, tray_wall_h]);
            translate([0, tray_inner_w/2, 0]) cube([half_len, rail_t, tray_rail_h]);
            translate([0, -tray_w_out/2, 0])  cube([half_len, rail_t, tray_rail_h]);
        }
        for (y = tray_key_y)
            translate([0, y, -1]) linear_extrude(tray_floor_t + 2) ff_bowtie_2d(0.15);
    }

tray_key_y = tray_open_floor ? [-(tray_inner_w/2 - tray_frame/2), tray_inner_w/2 - tray_frame/2]
                             : [-tray_inner_w/4, tray_inner_w/4];
module ff_tray_key()   linear_extrude(tray_floor_t) ff_bowtie_2d(0);
module ff_tray_riser() cube([40, 40, riser_h]);

// =====================================================================
//  Fit test: print first, then set the clearances (columns 1-4 = 1-4 edge notches)
//  Row 1 (front): 6 mm pin holes   +0.1 / +0.2 / +0.3 / +0.4  -> press_clear (tight) and run_clear (free turn)
//  Row 2:         8 mm D-bores     +0.1 / +0.2 / +0.25 / +0.3 -> press_clear (push-fit) and slip_clear (slides)
//  Row 3 (back):  8 mm round holes +0.2 / +0.3 / +0.4 / +0.5  -> run_clear for the shaft bearings
// =====================================================================
module ff_fit_test() {
    dcl = [0.1, 0.2, 0.25, 0.3];
    difference() {
        cube([64, 50, 5]);
        for (i = [0:3]) translate([10 + i*15, 10, -1]) cylinder(d = pin_d + 0.1 + i*0.1, h = 7);
        for (i = [0:3]) translate([10 + i*15, 25, -1]) linear_extrude(7) ff_dshaft_2d(shaft_d, dcl[i]);
        for (i = [0:3]) translate([10 + i*15, 40, -1]) cylinder(d = shaft_d + 0.2 + i*0.1, h = 7);
        for (i = [0:3], k = [0:i]) translate([10 + i*15 - 3 + k*2, -0.01, 3.5]) cube([1, 1.5, 2]);
    }
    translate([0, 60, 0]) ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(30);
    translate([40, 60, 0]) ff_print_lying(pin_d/2 - 0.6) ff_pin();
}

// =====================================================================
//  Assembly (sheet frame)
// =====================================================================
module ff_assembly() {
    A = ff_A(th_pin);

    // casing
    color("silver", 0.55) translate([0, 0, z_drive_in]) ff_plate("drive");
    color("silver", 0.55) translate([0, 0, z_idle_out]) ff_plate("idle");
    color("gray") for (p = ties) translate([p[0], p[1], z_idle_in]) ff_tube(tie_d, channel_w, tie_hole);
    color("gray") translate([entry_pos[0], entry_pos[1], z_idle_in]) ff_tube(entry_d, channel_w, tie_hole);
    if (show_guard) color("white", 0.25) ff_guard();
    if (show_brackets) {
        color("lightgray") ff_bracket();
        color("lightgray") translate([0, 0, z_idle_out]) mirror([0, 0, 1]) ff_bracket();
    }

    // drum train
    color("orchid") translate([0, 0, z_c - drum_len/2]) rotate(drum_deg) {
        ff_drum_body();
        translate([0, 0, drum_len - flange_t]) ff_drum_cap();
    }
    color("dimgray") rotate(drum_deg) {
        translate([0, 0, z_idle_in + 0.25]) ff_spacer();
        translate([0, 0, z_drive_in - 0.25 - spacer_len]) ff_spacer();
    }
    color("khaki") translate([0, 0, drum_shaft_z[0]]) rotate(drum_deg)
        ff_dshaft(drum_shaft_z[1] - drum_shaft_z[0]);
    color("teal") translate([0, 0, z_gear[0]]) rotate(drum_deg) ff_gear_drum();
    color("gold") translate([0, 0, z_idle_out - 1 - detent_t]) rotate(drum_deg) ff_detent_wheel();
    color("gold") translate([0, 0, z_idle_out - detent_t]) ff_detent_arm();

    // crank train
    color("teal") translate([G[0], G[1], z_gear[0]]) rotate(crank_deg) ff_gear_crank();
    color("coral") translate([G[0], G[1], z_disk[0]]) rotate(th_pin) ff_crank_disk();
    color("khaki") translate([G[0], G[1], crank_shaft_z[0]]) rotate(crank_deg)
        ff_dshaft(crank_shaft_z[1] - crank_shaft_z[0]);
    color("dimgray") translate([G[0], G[1], guard_depth + handle_gap]) rotate(crank_deg) {
        ff_handle();
        color("black") translate([handle_len, 0, 6]) ff_knob();
    }

    // linkage
    color("tomato") translate([A[0], A[1], z_coupler[0]]) rotate(ff_ang(B_now - A)) ff_coupler();
    color("tomato") translate([O4[0], O4[1], z_gear[0]]) rotate(psi_now) ff_rocker();
    color("khaki") for (p = [A, B_now]) translate([p[0], p[1], z_coupler[1] - pin_len]) ff_pin();

    // chute and stubs
    color("salmon") translate([O4[0], O4[1], z_c - chute_w/2]) rotate(chute_deg) ff_chute();
    color("khaki") translate([O4[0], O4[1], stub_drive_z[0]]) rotate(chute_deg)
        ff_dshaft(stub_drive_z[1] - stub_drive_z[0]);
    color("khaki") translate([O4[0], O4[1], stub_idle_z[0]]) rotate(chute_deg)
        ff_dshaft(stub_idle_z[1] - stub_idle_z[0]);

    // hold-down roller
    ry = ff_roller_y(drum_deg);
    color("lightblue") translate([0, ry, z_c - roller_len/2]) {
        if (roller_pvc) { ff_tube(roller_d, roller_len, pvc_id); for (z = [0, roller_len]) translate([0, 0, z]) mirror([0, 0, z > 0 ? 1 : 0]) translate([0, 0, -2]) ff_roller_hub(); }
        else ff_roller();
    }
    color("khaki") translate([0, ry, axle_z[0]]) ff_dshaft(axle_z[1] - axle_z[0]);

    // tray
    floor_y = O4[1] - chute_len - start_drop;
    color("wheat") translate([0, floor_y - tray_floor_t, z_c]) rotate([-90, 0, 0]) {
        ff_tray_half();
        mirror([1, 0, 0]) ff_tray_half();
        for (y = tray_key_y) translate([0, y, 0]) ff_tray_key();
    }
}

// =====================================================================
//  Exploded view (part = "exploded")
// =====================================================================
// --- explode offsets (sheet frame: +x gear side, +y up, +z out of the drive plate)
ex_plate = 80;    // side plates slide off axially
ex_gear = 130;    // 20T / 40T gears
ex_disk = 160;   // crank disk
ex_rocker = 160;   // rocker
ex_coupler = 195;   // coupler
ex_pin = 225;   // pins
ex_guard = 280;   // gear guard
ex_handle = 330;   // crank handle and knob
ex_shaft = 360;   // shafts slide out past everything else
ex_cap = 40;    // drum cap
ex_spacer = 30;    // drum spacers
ex_detent = 130;    // detent wheel and arm (idle side)
ex_chute   = 70;    // chute drops
ex_roller  = 70;    // roller lifts
ex_tray    = 130;   // tray drops
ex_trayx   = 40;    // tray halves separate
ex_bracket = 90;    // brackets lift

module ff_label(p, t, e)
    if (show_labels && e > 0.35)
        color("black") translate(p) linear_extrude(1)
            text(t, size = label_size, halign = "center", valign = "center");

module ff_exploded(e) {
    A  = ff_A(th_pin);
    ry = ff_roller_y(drum_deg);
    floor_y = O4[1] - chute_len - start_drop;

    // ---------- casing ----------
    color("silver", 0.6) translate([0, 0, z_drive_in + ex_plate*e]) ff_plate("drive");
    color("silver", 0.6) translate([0, 0, z_idle_out - ex_plate*e]) ff_plate("idle");
    color("gray") for (p = ties) translate([p[0], p[1], z_idle_in]) ff_tube(tie_d, channel_w, tie_hole);
    color("gray") translate([entry_pos[0], entry_pos[1], z_idle_in]) ff_tube(entry_d, channel_w, tie_hole);
    if (show_guard) color("white", 0.35) translate([0, 0, ex_guard*e]) ff_guard();
    if (show_brackets) {
        color("lightgray") translate([0, ex_bracket*e, ex_plate*e]) ff_bracket();
        color("lightgray") translate([0, ex_bracket*e, z_idle_out - ex_plate*e]) mirror([0, 0, 1]) ff_bracket();
    }

    // ---------- drum train ----------
    color("orchid") translate([0, 0, z_c - drum_len/2]) rotate(drum_deg) {
        ff_drum_body();
        translate([0, 0, drum_len - flange_t + ex_cap*e]) ff_drum_cap();
    }
    color("dimgray") rotate(drum_deg) {
        translate([0, 0, z_idle_in + 0.25 - ex_spacer*e]) ff_spacer();
        translate([0, 0, z_drive_in - 0.25 - spacer_len + ex_spacer*e]) ff_spacer();
    }
    color("khaki") translate([0, 0, drum_shaft_z[0] - ex_shaft*e]) rotate(drum_deg)
        ff_dshaft(drum_shaft_z[1] - drum_shaft_z[0]);
    color("teal") translate([0, 0, z_gear[0] + ex_gear*e]) rotate(drum_deg) ff_gear_drum();
    color("gold") translate([0, 0, z_idle_out - 1 - detent_t - ex_detent*e]) rotate(drum_deg) ff_detent_wheel();
    color("gold") translate([0, 0, z_idle_out - detent_t - (ex_detent + 20)*e]) ff_detent_arm();

    // ---------- crank train ----------
    color("teal") translate([G[0], G[1], z_gear[0] + ex_gear*e]) rotate(crank_deg) ff_gear_crank();
    color("coral") translate([G[0], G[1], z_disk[0] + ex_disk*e]) rotate(th_pin) ff_crank_disk();
    color("khaki") translate([G[0], G[1], crank_shaft_z[0] + ex_shaft*e]) rotate(crank_deg)
        ff_dshaft(crank_shaft_z[1] - crank_shaft_z[0]);
    color("dimgray") translate([G[0], G[1], guard_depth + handle_gap + ex_handle*e]) rotate(crank_deg) {
        ff_handle();
        color("black") translate([handle_len, 0, 6 + 20*e]) ff_knob();
    }

    // ---------- linkage ----------
    color("tomato") translate([A[0], A[1], z_coupler[0] + ex_coupler*e]) rotate(ff_ang(B_now - A)) ff_coupler();
    color("tomato") translate([O4[0], O4[1], z_gear[0] + ex_rocker*e]) rotate(psi_now) ff_rocker();
    color("khaki") for (p = [A, B_now]) translate([p[0], p[1], z_coupler[1] - pin_len + ex_pin*e]) ff_pin();

    // ---------- chute and stubs ----------
    color("salmon") translate([O4[0], O4[1] - ex_chute*e, z_c - chute_w/2]) rotate(chute_deg) ff_chute();
    color("khaki") translate([O4[0], O4[1], stub_drive_z[0] + (ex_rocker + 15)*e]) rotate(chute_deg)
        ff_dshaft(stub_drive_z[1] - stub_drive_z[0]);
    color("khaki") translate([O4[0], O4[1], stub_idle_z[0] - (ex_plate + 40)*e]) rotate(chute_deg)
        ff_dshaft(stub_idle_z[1] - stub_idle_z[0]);

    // ---------- hold-down roller ----------
    color("lightblue") translate([0, ry + ex_roller*e, z_c - roller_len/2]) {
        if (roller_pvc) { ff_tube(roller_d, roller_len, pvc_id); for (z = [0, roller_len]) translate([0, 0, z]) mirror([0, 0, z > 0 ? 1 : 0]) translate([0, 0, -2 - 15*e]) ff_roller_hub(); }
        else ff_roller();
    }
    color("khaki") translate([0, ry + ex_roller*e, axle_z[0] - ex_shaft*e]) ff_dshaft(axle_z[1] - axle_z[0]);

    // ---------- tray ----------
    color("wheat") translate([0, floor_y - tray_floor_t - ex_tray*e, z_c]) rotate([-90, 0, 0]) {
        translate([ex_trayx*e, 0, 0]) ff_tray_half();
        translate([-ex_trayx*e, 0, 0]) mirror([1, 0, 0]) ff_tray_half();
        for (y = tray_key_y) translate([0, y, 25*e]) ff_tray_key();
    }

    // ---------- labels (drawn in the side-plate plane, facing the viewer) ----------
    zl = guard_depth + 60;   // labels float in front of the drive side
    ff_label([0, ry + ex_roller*e + roller_d/2 + 14, z_c],                "Gravity roller", e);
    ff_label([-95, 62, z_drive_in + ex_plate*e + 8],                     "Pentagon drum (inside)", e);
    ff_label([0, O4[1] - ex_chute*e - chute_len - 8, z_c + chute_w/2 + 10], "Swing chute", e);
    ff_label([0, floor_y - ex_tray*e - 14, z_c + tray_inner_w/2 + 20],   "Tray (2 halves + keys)", e);
    ff_label([plate_x[1] + 30, plate_y[0] + 20, z_drive_in + ex_plate*e], "Drive plate", e);
    ff_label([plate_x[0] - 40, plate_y[0] + 20, z_idle_out - ex_plate*e], "Idle plate", e);
    ff_label([G[0] + 75, G[1], z_gear[1] + ex_gear*e],                    "20T / 40T gears", e);
    ff_label([G[0] + 75, G[1] - 22, z_disk[1] + ex_disk*e],               "Crank disk", e);
    ff_label([O4[0] - 60, O4[1] - 20, z_rocker[1] + ex_rocker*e],         "Rocker", e);
    ff_label([A[0] + 55, (A[1] + B_now[1])/2, z_coupler[1] + ex_coupler*e], "Coupler + pins", e);
    ff_label([plate_x[1] + 20, 60, ex_guard*e + guard_depth],             "Gear guard", e);
    ff_label([G[0] + handle_len + 50, G[1] + 30, guard_depth + 13 + ex_handle*e], "Crank handle", e);
    ff_label([-60, -45, z_idle_out - detent_t - ex_detent*e],             "Detent wheel + arm", e);
    ff_label([-115, -128, z_c],                                         "Ties + entry bar", e);
    ff_label([clamp_holes[0][0] - 60, table_above_drum + 30 + ex_bracket*e, ex_plate*e], "Table brackets", e);
}


// =====================================================================
//  Output
// =====================================================================
echo(str("Label fan folder v3.3.1 | print-saving options: drum ", lite_drum, ", plates ", lite_plates,
          ", chute ", lite_chute, ", roller ", lite_roller, ", open tray floor ", tray_open_floor, ", PVC roller ", roller_pvc));

if      (part == "assembly")     rotate([90, 0, 0]) ff_assembly();
else if (part == "plates")       { ff_plate("drive"); translate([plate_x[1] - plate_x[0] + 25, 0, 0]) ff_plate("idle"); }   // both side plates, face-on
else if (part == "exploded")     rotate([90, 0, 0]) ff_exploded(explode_anim ? (1 - cos($t * 360)) / 2 : explode);
else if (part == "plate_drive")  ff_plate("drive");
else if (part == "plate_idle")   ff_plate("idle");
else if (part == "drum_body")    ff_drum_body();
else if (part == "drum_cap")     ff_drum_cap();
else if (part == "drum_test")    ff_drum_body(guide = drum_test_w);   // Batch 1 shortcut: test with a slit 40 mm strip of labels + drum_cap
else if (part == "spacer")       ff_spacer();        // print 2
else if (part == "gear_drum")    translate([0, 0, gear_thk]) rotate([180, 0, 0]) ff_gear_drum();
else if (part == "gear_crank")   translate([0, 0, gear_thk]) rotate([180, 0, 0]) ff_gear_crank();
else if (part == "fit_test")     ff_fit_test();
else if (part == "crank_disk")   ff_crank_disk();
else if (part == "coupler")      ff_coupler();
else if (part == "rocker")       translate([0, 0, z_rocker[1] - z_gear[0]]) rotate([180, 0, 0]) ff_rocker();
else if (part == "chute")        ff_chute();
else if (part == "tie")          ff_tube(tie_d, channel_w, tie_hole);   // print 3
else if (part == "entry_bar")    ff_tube(entry_d, channel_w, tie_hole);
else if (part == "roller")       { if (roller_pvc) ff_roller_hub(); else ff_roller(); }   // PVC: print 2 hubs
else if (part == "drum_shaft")   ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(drum_shaft_z[1] - drum_shaft_z[0]);
else if (part == "crank_shaft")  ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(crank_shaft_z[1] - crank_shaft_z[0]);
else if (part == "stub_drive")   ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(stub_drive_z[1] - stub_drive_z[0]);
else if (part == "stub_idle")    ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(stub_idle_z[1] - stub_idle_z[0]);
else if (part == "roller_axle")  ff_print_lying(shaft_d/2 - d_flat) ff_dshaft(axle_z[1] - axle_z[0]);
else if (part == "pin")          ff_print_lying(pin_d/2 - 0.6) ff_pin();  // print 2
else if (part == "collar")       ff_collar();        // print 4 (crank inner, stub idle, axle x2)
else if (part == "guard")        translate([0, 0, guard_depth]) rotate([180, 0, 0]) ff_guard();
else if (part == "handle")       ff_handle();
else if (part == "knob")         ff_knob();
else if (part == "detent_wheel") ff_detent_wheel();
else if (part == "detent_arm")   ff_detent_arm();
else if (part == "bracket")      ff_bracket();       // print 2
else if (part == "thumbscrew")   ff_thumbscrew();    // print 2
else if (part == "tray_half")    ff_tray_half();     // print 2
else if (part == "tray_key")     ff_tray_key();      // print 2
else if (part == "tray_riser")   ff_tray_riser();
`,
  'assembly.scad': `// Label fan folder v3.3.1 · play "crank" in the preview.
// This file lists the parts of label_fan_folder.scad and the joints between them. Every placement is copied from ff_assembly()
// in that file. The design file only supplies modules and numbers, and BOSL2 for its gears, which the page loads when you build.
// One turn of the crank turns the drum twice, the other way (follow and ratio), and the coupler swings the rocker and chute.
include <label_fan_folder.scad>
part = "none";          // the design file draws nothing by itself
crank_manual = 0;       // the design's own pose: every formula is evaluated at crank = 0

tray_floor_y = O4[1] - chute_len - start_drop;
A0 = [crank_r * cos(crank_phase_deg), crank_r * sin(crank_phase_deg)];   // crank pin, in the crank's frame

// ----- parts: each is drawn in the design's own coordinates, about its own pivot -----

// Does not move. The design stands the whole machine up with rotate([90, 0, 0]); that turn lives here.
part("frame", rot = [90, 0, 0]) {
    translate([0, 0, z_drive_in]) ff_plate("drive");
    translate([0, 0, z_idle_out]) ff_plate("idle");
    for (p = ties) translate([p[0], p[1], z_idle_in]) ff_tube(tie_d, channel_w, tie_hole);
    translate([entry_pos[0], entry_pos[1], z_idle_in]) ff_tube(entry_d, channel_w, tie_hole);
    if (show_guard) ff_guard();
    translate([0, 0, z_idle_out - detent_t]) ff_detent_arm();
}

part("tray") translate([0, tray_floor_y - tray_floor_t, z_c]) rotate([-90, 0, 0]) {
    ff_tray_half();
    mirror([1, 0, 0]) ff_tray_half();
    for (y = tray_key_y) translate([0, y, 0]) ff_tray_key();
}

// Pivot: the drum axis, which is the file's origin.
part("drum") {
    translate([0, 0, z_c - drum_len/2]) {
        ff_drum_body();
        translate([0, 0, drum_len - flange_t]) ff_drum_cap();
    }
    translate([0, 0, z_idle_in + 0.25]) ff_spacer();
    translate([0, 0, z_drive_in - 0.25 - spacer_len]) ff_spacer();
    translate([0, 0, drum_shaft_z[0]]) ff_dshaft(drum_shaft_z[1] - drum_shaft_z[0]);
    translate([0, 0, z_gear[0]]) ff_gear_drum();
    translate([0, 0, z_idle_out - 1 - detent_t]) ff_detent_wheel();
}

// Pivot: the crank axis G, moved to the origin. Turns with crank_deg; the disk and pin sit at th_pin.
// The design's ff_knob() is a 16-sided circle, which the page reports as not round in STEP. This knob is the same size, drawn round.
module knob() linear_extrude(30) difference() { circle(d = 20); circle(d = 5.6); }

part("crank") {
    translate([0, 0, z_gear[0]]) ff_gear_crank();
    translate([0, 0, z_disk[0]]) rotate(crank_phase_deg) ff_crank_disk();
    translate([0, 0, crank_shaft_z[0]]) ff_dshaft(crank_shaft_z[1] - crank_shaft_z[0]);
    translate([0, 0, guard_depth + handle_gap]) {
        ff_handle();
        translate([handle_len, 0, 6]) knob();
    }
    translate([A0[0], A0[1], z_coupler[1] - pin_len]) ff_pin();
}

// Pivot: its first hole, at the crank pin, with the coupler's own z as the origin.
part("coupler") ff_coupler();

// Pivot: the chute axis O4. The rocker and chute share a shaft, so they turn together.
part("rocker") {
    translate([0, 0, z_gear[0]]) ff_rocker();
    translate([rocker_len, 0, z_coupler[1] - pin_len]) ff_pin();
    rotate(-psi_mid) {
        translate([0, 0, z_c - chute_w/2]) ff_chute();
        translate([0, 0, stub_drive_z[0]]) ff_dshaft(stub_drive_z[1] - stub_drive_z[0]);
        translate([0, 0, stub_idle_z[0]]) ff_dshaft(stub_idle_z[1] - stub_idle_z[0]);
    }
}

// Pivot: the roller's own axis, which the design moves up and down the y axis.
part("roller") {
    translate([0, 0, z_c - roller_len/2]) {
        if (roller_pvc) {
            ff_tube(roller_d, roller_len, pvc_id);
            for (z = [0, roller_len]) translate([0, 0, z]) mirror([0, 0, z > 0 ? 1 : 0]) translate([0, 0, -2]) ff_roller_hub();
        } else ff_roller();
    }
    translate([0, 0, axle_z[0]]) ff_dshaft(axle_z[1] - axle_z[0]);
}

// ----- joints -----
joint("crank", type = "hinge", parent = "frame", child = "crank", at = [G[0], G[1], 0], value = 0);

// The 20 tooth drum gear turns the opposite way at twice the crank's angle: drum_deg = -gear_ratio * crank_deg.
joint("drum", type = "hinge", parent = "frame", child = "drum", follow = "crank", ratio = -gear_ratio);

joint("tray", type = "fixed", parent = "frame", child = "tray");

joint("crank_pin", type = "hinge", parent = "crank", child = "coupler",
      at = [A0[0], A0[1], z_coupler[0]], value = ff_ang(B_now - ff_A(th_pin)));

joint("chute", type = "hinge", parent = "frame", child = "rocker", at = [O4[0], O4[1], 0], value = psi_now);

// Closes the four-bar: the coupler's far hole meets the rocker's end.
joint("rocker_pin", type = "hinge", parent = "coupler", child = "rocker",
      at = [coupler_len, 0, 0], child_at = [rocker_len, 0, z_coupler[0]]);

// The roller rests on the pentagon: its height is the design's own ff_roller_y(), read from a table of the drum angle.
joint("roller", type = "slider", parent = "frame", child = "roller", axis = [0, 1, 0],
      follow = "drum", table = [for (a = [0 : 1 : 360]) [a, ff_roller_y(a)]]);
`,
};
