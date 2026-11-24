import { swivelArm } from './assemblyExample.ts';
import { gearedMechanism } from './gearedExample.ts';
import { labelFanFolder } from './fanFolderExample.ts';
import { crankRocker } from './linkageExample.ts';
import type { ProjectFiles } from './engine/protocol.ts';

export interface Example {
  name: string;
  description: string;
  filename: string;
  source: string;
}

export const examples: Example[] = [
  {
    name: 'Mounting plate',
    description: 'Four through holes driven by the plate dimensions.',
    filename: 'mounting_plate.scad',
    source: `// Mounting plate · dimensions in mm
width = 80;
depth = 40;
thickness = 6;
hole_diameter = 5;
edge_distance = 8;

module through_hole(x, y) {
    translate([x, y, -1])
        cylinder(
            h = thickness + 2,
            d = hole_diameter
        );
}

difference() {
    cube([width, depth, thickness]);

    for (x = [edge_distance, width - edge_distance])
        for (y = [edge_distance, depth - edge_distance])
            through_hole(x, y);
}
`,
  },
  {
    name: 'Open enclosure',
    description: 'A box with editable wall and floor thickness.',
    filename: 'open_enclosure.scad',
    source: `// Open enclosure · dimensions in mm
width = 64;
depth = 42;
height = 26;
wall = 3;
floor = 4;

assert(width > 2 * wall && depth > 2 * wall);
assert(floor > 0 && floor < height);

difference() {
    cube([width, depth, height]);

    translate([wall, wall, floor])
        cube([
            width - 2 * wall,
            depth - 2 * wall,
            height - floor + 1
        ]);
}
`,
  },
  {
    name: 'Tapered spacer',
    description: 'A cone with a cylindrical bore.',
    filename: 'tapered_spacer.scad',
    source: `// Tapered spacer · dimensions in mm
base_diameter = 28;
top_diameter = 20;
height = 12;
bore = 8;

difference() {
    cylinder(h = height,
             d1 = base_diameter,
             d2 = top_diameter);

    translate([0, 0, -1])
        cylinder(h = height + 2, d = bore);
}
`,
  },
  {
    name: 'Ball seat',
    description: 'A spherical recess cut into a centred block.',
    filename: 'ball_seat.scad',
    source: `// Ball seat · dimensions in mm
width = 35;
height = 12;
seat_radius = 11;

difference() {
    cube([width, width, height], center = true);
    translate([0, 0, height / 2 + 3])
        sphere(r = seat_radius);
}
`,
  },
];

export interface ExampleProject {
  name: string;
  description: string;
  files: ProjectFiles;
  /** The file to show and build first. */
  open: string;
}

export const exampleProjects: ExampleProject[] = [
  {
    name: 'Swivel arm assembly',
    description: 'Four parts, two hinges and a slider you can move.',
    files: swivelArm,
    open: 'swivel_arm.scad',
  },
  {
    name: 'Crank-rocker linkage',
    description: 'A four-bar loop. Play the crank and watch the rocker swing.',
    files: crankRocker,
    open: 'four_bar.scad',
  },
  {
    name: 'Gears and a cam',
    description: 'A crank turns a wheel twice as fast the other way, and the wheel lifts a plunger by a formula.',
    files: gearedMechanism,
    open: 'geared.scad',
  },
  {
    name: 'Label fan folder',
    description: 'A real machine: a crank drives a pentagon drum, and a four-bar linkage swings the chute. The page loads BOSL2 for it, so the first build takes longer.',
    files: labelFanFolder,
    open: 'assembly.scad',
  },
  ...examples.map((example) => ({
    name: example.name,
    description: example.description,
    files: { [example.filename]: example.source },
    open: example.filename,
  })),
];
