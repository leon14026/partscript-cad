import type { ProjectFiles } from './engine/protocol.ts';

/** A gear pair and a cam: one crank drives a wheel by a ratio, and the wheel drives a plunger by a table. */
export const gearedMechanism: ProjectFiles = {
  'geared.scad': `// Gears and a cam · play "crank" in the preview.
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
`,
};
