/**
 * Files that are not OpenSCAD text: a STEP or STL a project imports. A project holds
 * them next to its .scad files, under the same flat names, and calls them assets.
 */

export type AssetFormat = 'step' | 'stl';

/** The names an asset may have. The extension is lower case. */
export const assetNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}\.(?:step|stp|stl)$/;

export function assetFormat(name: string): AssetFormat | undefined {
  if (!assetNamePattern.test(name)) return undefined;
  return name.endsWith('.stl') ? 'stl' : 'step';
}

/** The name without its extension, for a part's default name. */
export function stemOf(name: string) {
  return name.replace(/\.(?:scad|step|stp|stl)$/i, '');
}

const nativeFormats = /\.(sldprt|sldasm|ipt|iam|f3d|f3z|x_t|x_b|prt|par|psm|catpart|catproduct|3dm|skp|dwg|dxf|igs|iges|obj|3mf|ply|off|amf|fbx|blend)$/i;

/**
 * A plain sentence for a file the site cannot read, or undefined when its format is one it can.
 * A STEP version is usually offered next to the native file on GrabCAD and supplier sites.
 */
export function unreadableFormat(name: string): string | undefined {
  const extension = nativeFormats.exec(name)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  if (extension === 'igs' || extension === 'iges') {
    return `${name} is an IGES file, which this site cannot read. Download or export the STEP version (.step or .stp) instead.`;
  }
  if (['obj', '3mf', 'ply', 'off', 'amf', 'fbx', 'blend'].includes(extension)) {
    return `${name} is a mesh format other than STL, which this site cannot read. Export it as STL, or download the STEP version.`;
  }
  return `${name} is a .${extension} file, which is a program's own format and cannot be read here. Download or export the STEP version (.step or .stp) from the CAD program or the download page. Most GrabCAD models include one.`;
}

const hashes = new WeakMap<Uint8Array, string>();

/** SHA-256 of the bytes, in hex. Kept for the same array, so a large file is hashed once. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const known = hashes.get(bytes);
  if (known) return known;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  hashes.set(bytes, hex);
  return hex;
}

export function formatBytes(count: number) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KB`;
  return `${(count / (1024 * 1024)).toFixed(count < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
