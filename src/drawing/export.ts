import { strToU8, zipSync } from 'fflate';
import { sheetToDxf } from './dxf.ts';
import { sheetsToPdf } from './pdf.ts';
import { sheetToSvg } from './svg.ts';
import type { Sheet } from './types.ts';

export type DrawingFormat = 'pdf' | 'svg' | 'dxf';

export interface DrawingFile {
  name: string;
  data: Uint8Array;
  type: string;
}

const types: Record<DrawingFormat, string> = { pdf: 'application/pdf', svg: 'image/svg+xml', dxf: 'image/vnd.dxf' };

/** A name that is safe in a file name on any system. */
export function fileStem(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'drawing';
}

/** Names for the sheets, each different, so two parts with the same name do not overwrite one another in a zip. */
function uniqueStems(sheets: Sheet[]) {
  const taken = new Set<string>();
  return sheets.map((sheet) => {
    let stem = fileStem(sheet.name);
    for (let n = 2; taken.has(stem.toLowerCase()); n++) stem = `${fileStem(sheet.name)}_${n}`;
    taken.add(stem.toLowerCase());
    return stem;
  });
}

/**
 * The file to download for some sheets. A PDF is one file with a page for each sheet. An SVG or a DXF is one file when there is one
 * sheet, and a zip of one file for each sheet when there are several. The same sheets always give the same bytes.
 */
export function exportDrawings(sheets: Sheet[], format: DrawingFormat, project: string): DrawingFile {
  const stems = uniqueStems(sheets);
  if (format === 'pdf') {
    const title = sheets.length === 1 ? stems[0] : project;
    return { name: `${sheets.length === 1 ? stems[0] : `${fileStem(project)}-drawings`}.pdf`, data: sheetsToPdf(sheets, title), type: types.pdf };
  }
  const bodies = sheets.map((sheet) => strToU8(format === 'svg' ? sheetToSvg(sheet) : sheetToDxf(sheet)));
  if (sheets.length === 1) return { name: `${stems[0]}.${format}`, data: bodies[0], type: types[format] };
  const files: Record<string, Uint8Array> = {};
  stems.forEach((stem, i) => { files[`${stem}.${format}`] = bodies[i]; });
  // A fixed modification time, so the same sheets make the same zip.
  return { name: `${fileStem(project)}-drawings.zip`, data: zipSync(files, { mtime: new Date(2026, 0, 1) }), type: 'application/zip' };
}
