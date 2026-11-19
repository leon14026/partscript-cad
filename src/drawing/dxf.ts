import { arrowPoints, layerOrder } from './layers.ts';
import type { Entity, Layer, Sheet, Vec2 } from './types.ts';

/** AutoCAD colour numbers. Line weights are left to the CAD program, because the R12 format holds none. */
const layerColours: Record<Layer, number> = { OUTLINE: 7, HIDDEN: 7, DIM: 3, HATCH: 8, TEXT: 7, BORDER: 7 };

const num = (value: number) => {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** The special codes a DXF text uses for the symbols a drawing needs. Anything else that is not plain ASCII becomes a question mark. */
function dxfText(text: string) {
  let out = '';
  for (const character of text) {
    if (character === 'Ø') out += '%%c';
    else if (character === '°') out += '%%d';
    else if (character === '±') out += '%%p';
    else if (character === '×') out += 'x';
    else if (character === '%') out += '%%%';
    else out += character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) < 0x7f ? character : '?';
  }
  return out;
}

const degrees = (radians: number) => {
  const turn = ((radians * 180) / Math.PI) % 360;
  return turn < 0 ? turn + 360 : turn;
};

/** The drawing as a DXF of the oldest common version, R12, which every CAD program reads. Units are millimetres, at the size on paper. */
export function sheetToDxf(sheet: Sheet): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? num(value) : value);
  const point = (code: number, p: Vec2) => {
    pair(code, p[0]);
    pair(code + 10, p[1]);
    pair(code + 20, 0);
  };
  const entity = (kind: string, layer: Layer) => {
    pair(0, kind);
    pair(8, layer);
  };

  const draw = (item: Entity) => {
    switch (item.kind) {
      case 'line':
        entity('LINE', item.layer);
        point(10, item.a);
        point(11, item.b);
        break;
      case 'poly':
        entity('POLYLINE', item.layer);
        pair(66, 1);
        point(10, [0, 0]);
        pair(70, item.closed ? 1 : 0);
        for (const p of item.points) {
          entity('VERTEX', item.layer);
          point(10, p);
        }
        entity('SEQEND', item.layer);
        break;
      case 'circle':
        entity('CIRCLE', item.layer);
        point(10, item.c);
        pair(40, item.r);
        break;
      case 'arc':
        entity('ARC', item.layer);
        point(10, item.c);
        pair(40, item.r);
        pair(50, degrees(item.from));
        pair(51, degrees(item.to));
        break;
      case 'arrow': {
        // A filled triangle is a SOLID, whose last corner repeats the third and whose corners go in a bow-tie order.
        const [a, b, c] = arrowPoints(item.tip, item.angle);
        entity('SOLID', item.layer);
        point(10, a);
        point(11, b);
        point(12, c);
        point(13, c);
        break;
      }
      case 'text': {
        entity('TEXT', item.layer);
        point(10, item.at);
        pair(40, item.height);
        pair(1, dxfText(item.text));
        if (item.angle) pair(50, degrees(item.angle));
        if (item.anchor !== 'start') {
          pair(72, item.anchor === 'middle' ? 1 : 2);
          point(11, item.at);
        }
        break;
      }
    }
  };

  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1009');
  pair(9, '$EXTMIN'); point(10, [0, 0]);
  pair(9, '$EXTMAX'); point(10, [sheet.width, sheet.height]);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'TABLES');
  pair(0, 'TABLE'); pair(2, 'LTYPE'); pair(70, 2);
  pair(0, 'LTYPE'); pair(2, 'CONTINUOUS'); pair(70, 0); pair(3, 'Solid line'); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, 'LTYPE'); pair(2, 'DASHED'); pair(70, 0); pair(3, 'Dashed'); pair(72, 65); pair(73, 2); pair(40, 4.5); pair(49, 3); pair(49, -1.5);
  pair(0, 'ENDTAB');
  pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, layerOrder.length);
  for (const layer of layerOrder) {
    pair(0, 'LAYER'); pair(2, layer); pair(70, 0); pair(62, layerColours[layer]); pair(6, layer === 'HIDDEN' ? 'DASHED' : 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'ENTITIES');
  for (const layer of layerOrder) for (const item of sheet.entities) if (item.layer === layer) draw(item);
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return `${out.join('\n')}\n`;
}
