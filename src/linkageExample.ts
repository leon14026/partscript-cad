import type { ProjectFiles } from './engine/protocol.ts';

/** A crank-rocker four-bar: the crank turns fully and the rocker swings. */
export const crankRocker: ProjectFiles = {
  'four_bar.scad': `// Crank-rocker four-bar · run this file, then press
// play on "crank" in the preview.
// Four hinges form a ring. Three carry a part. The last,
// between two parts that are already placed, closes the loop.
include <params.scad>

t = link_thickness;

part("ground", "ground.scad", color = "#8d99a6");
part("crank", "crank.scad", color = "#c0604c");
part("coupler", "coupler.scad");
part("rocker", "rocker.scad", color = "#6fa8a0");

// No limits: this hinge can turn all the way round.
joint("crank", type = "hinge",
      parent = "ground", child = "crank",
      at = [0, 0, t], value = 40);

joint("crank_pin", type = "hinge",
      parent = "crank", child = "coupler",
      at = [crank_length, 0, t]);

// This value is a starting guess. It picks the open
// form of the linkage instead of the crossed one.
joint("rocker", type = "hinge",
      parent = "ground", child = "rocker",
      at = [ground_length, 0, t], value = 100);

// Closing joint: the far hole of the coupler meets the
// far hole of the rocker. child_at is where the joint
// sits on the child when that is not the child's origin.
joint("rocker_pin", type = "hinge",
      parent = "coupler", child = "rocker",
      at = [coupler_length, 0, 0],
      child_at = [rocker_length, 0, t]);
`,
  'params.scad': `// Link lengths in mm, pin centre to pin centre.
// The crank turns fully while the shortest link plus the
// longest is no more than the other two added together.
ground_length = 80;
crank_length = 25;
coupler_length = 90;
rocker_length = 60;

link_width = 12;
link_thickness = 6;
boss_diameter = 18;
pin_diameter = 5;
`,
  'link.scad': `// A flat link with a pin hole at each end.
// The first hole is at the origin, the second along +X.
include <params.scad>

module link(length) {
    difference() {
        union() {
            translate([0, -link_width / 2, 0])
                cube([length, link_width, link_thickness]);
            for (x = [0, length])
                translate([x, 0, 0])
                    cylinder(h = link_thickness,
                             d = boss_diameter);
        }
        for (x = [0, length])
            translate([x, 0, -1])
                cylinder(h = link_thickness + 2,
                         d = pin_diameter);
    }
}
`,
  'ground.scad': `// Ground plate with the two fixed pivots
include <params.scad>

margin = 22;

difference() {
    translate([-margin, -margin, 0])
        cube([ground_length + 2 * margin, 2 * margin,
              link_thickness]);
    for (x = [0, ground_length])
        translate([x, 0, -1])
            cylinder(h = link_thickness + 2,
                     d = pin_diameter);
}
`,
  'crank.scad': `include <link.scad>
link(crank_length);
`,
  'coupler.scad': `include <link.scad>
link(coupler_length);
`,
  'rocker.scad': `include <link.scad>
link(rocker_length);
`,
};
