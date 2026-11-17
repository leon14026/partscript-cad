"""Verify the STEP fixtures with FreeCAD Part. Run with a Python that can import FreeCAD and Part."""
import math
import sys
from pathlib import Path

import FreeCAD
import Part


output = Path(sys.argv[1] if len(sys.argv) > 1 else '.test-output')
fixtures = {
    'mounting_plate': ((80, 40, 6), 80 * 40 * 6 - 4 * math.pi * 2.5**2 * 6, 'Cylinder'),
    'mounting_plate_revised': ((100, 40, 6), 100 * 40 * 6 - 4 * math.pi * 4**2 * 6, 'Cylinder'),
    'open_enclosure': ((64, 42, 26), 64 * 42 * 26 - 58 * 36 * 22, 'Plane'),
    'tapered_spacer': ((28, 28, 12), math.pi * 12 * (14**2 + 14 * 10 + 10**2) / 3 - math.pi * 4**2 * 12, 'Cone'),
    'ball_seat': ((35, 35, 12), 35**2 * 12 - math.pi * 8**2 * (11 - 8 / 3), 'Sphere'),
    'transformed_intersection': (None, 780, 'Plane'),
}

for name, (dimensions, volume, surface_type) in fixtures.items():
    shape = Part.read(str(output / f'{name}.step'))
    assert shape.isValid() and len(shape.Solids) == 1, name
    assert abs(shape.Volume - volume) < 0.01, (name, shape.Volume)
    box = shape.BoundBox
    actual = (box.XLength, box.YLength, box.ZLength)
    if dimensions:
        assert all(abs(a - b) < 0.01 for a, b in zip(actual, dimensions)), (name, actual)
    surfaces = [face.Surface for face in shape.Faces]
    assert surface_type in {type(surface).__name__ for surface in surfaces}, name
    if name.startswith('mounting_plate'):
        width, _, _ = dimensions
        cylinders = [surface for surface in surfaces if isinstance(surface, Part.Cylinder)]
        radius = 2.5 if name == 'mounting_plate' else 4
        hole_centres = {(round(surface.Center.x, 3), round(surface.Center.y, 3)) for surface in cylinders}
        assert len(cylinders) == 4 and all(abs(surface.Radius - radius) < 1e-6 for surface in cylinders), name
        assert hole_centres == {(8, 8), (8, 32), (width - 8, 8), (width - 8, 32)}, (name, hole_centres)
    print(f'{name}: valid solid, {tuple(round(x, 3) for x in actual)} mm, {shape.Volume:.3f} mm³')

print(f'Validated {len(fixtures)} files using FreeCAD {".".join(FreeCAD.Version()[:3])}.')
