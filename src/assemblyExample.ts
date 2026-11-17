import type { ProjectFiles } from './engine/protocol.ts';

/** A four-part arm with two hinges and a slider. Every part includes params.scad. */
export const swivelArm: ProjectFiles = {
  'swivel_arm.scad': `// Swivel arm · run this file to build the assembly
// Parts are separate files. Joints say how each part
// hangs from its parent and how it may move.
include <params.scad>

part("base", "base.scad");
part("turret", "turret.scad");
part("arm", "arm.scad");
part("carriage", "carriage.scad", color = "#c0604c");

// at  = joint position in the parent's coordinates
// axis = direction the child turns about or slides along
joint("swivel", type = "hinge",
      parent = "base", child = "turret",
      at = [0, 0, base_thickness + post_height],
      axis = [0, 0, 1],
      limits = [-170, 170], value = 25);

joint("lift", type = "hinge",
      parent = "turret", child = "arm",
      at = [0, 0, pivot_height],
      axis = [0, -1, 0],
      limits = [-10, 75], value = 30);

joint("reach", type = "slider",
      parent = "arm", child = "carriage",
      at = [reach_start, 0, 0],
      axis = [1, 0, 0],
      limits = [0, reach_travel], value = 20);
`,
  'params.scad': `// Shared dimensions in mm. Change one here and
// every part and joint that uses it follows.
base_size = 80;
base_thickness = 8;
post_diameter = 34;
post_height = 14;

turret_diameter = 44;
turret_height = 10;
cheek_thickness = 6;
cheek_width = 20;
pivot_height = 30;
pin_diameter = 6;

arm_length = 110;
arm_width = 12;
arm_height = 12;
stop_thickness = 4;

carriage_length = 26;
carriage_wall = 5;
clearance = 0.4;

reach_start = 30;
reach_travel = arm_length - stop_thickness
    - carriage_length / 2 - reach_start - 3;
`,
  'base.scad': `// Base plate with a centre post
include <params.scad>

bolt_inset = 9;

difference() {
    union() {
        translate([-base_size / 2, -base_size / 2, 0])
            cube([base_size, base_size, base_thickness]);
        cylinder(h = base_thickness + post_height,
                 d = post_diameter);
    }

    for (x = [-1, 1])
        for (y = [-1, 1])
            translate([x * (base_size / 2 - bolt_inset),
                       y * (base_size / 2 - bolt_inset), -1])
                cylinder(h = base_thickness + 2, d = 5);
}
`,
  'turret.scad': `// Turret · origin at the centre of its underside
include <params.scad>

cheek_y = arm_width / 2 + clearance;
cheek_top = pivot_height + cheek_width / 2;

difference() {
    union() {
        cylinder(h = turret_height, d = turret_diameter);

        for (side = [0, 1])
            translate([-cheek_width / 2,
                       side ? cheek_y
                            : -cheek_y - cheek_thickness,
                       turret_height - 1])
                cube([cheek_width, cheek_thickness,
                      cheek_top - turret_height + 1]);
    }

    // Pin hole through both cheeks
    translate([0, -turret_diameter / 2, pivot_height])
        rotate([-90, 0, 0])
            cylinder(h = turret_diameter, d = pin_diameter);
}
`,
  'arm.scad': `// Arm · origin on the pivot pin axis
include <params.scad>

hub_diameter = arm_height + 4;

difference() {
    union() {
        translate([0, -arm_width / 2, -arm_height / 2])
            cube([arm_length, arm_width, arm_height]);

        rotate([90, 0, 0])
            cylinder(h = arm_width, d = hub_diameter,
                     center = true);

        // End stop for the carriage
        translate([arm_length - stop_thickness,
                   -arm_width / 2 - 3, -arm_height / 2 - 3])
            cube([stop_thickness, arm_width + 6,
                  arm_height + 6]);
    }

    rotate([90, 0, 0])
        cylinder(h = arm_width + 2, d = pin_diameter,
                 center = true);
}
`,
  'carriage.scad': `// Carriage · origin at the centre of its slot
include <params.scad>

outer_y = arm_width + 2 * carriage_wall;
outer_z = arm_height + 2 * carriage_wall;

difference() {
    union() {
        translate([-carriage_length / 2,
                   -outer_y / 2, -outer_z / 2])
            cube([carriage_length, outer_y, outer_z]);

        // Tool post under the carriage
        translate([0, 0, -outer_z / 2 - 14])
            cylinder(h = 15, d = 10);
    }

    translate([-carriage_length / 2 - 1,
               -arm_width / 2 - clearance,
               -arm_height / 2 - clearance])
        cube([carriage_length + 2,
              arm_width + 2 * clearance,
              arm_height + 2 * clearance]);
}
`,
};
