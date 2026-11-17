import { Matrix4, type GridHelper, type AxesHelper, type OrthographicCamera } from 'three';
import type { PartMesh } from '../engine/protocol.ts';

export interface SoftwarePart {
  mesh: PartMesh;
  /** World transform, including the offset that centres the model. */
  matrix: Matrix4;
  color: [number, number, number];
  /** A hidden part is left out of the picture, including its edges and what they would hide. */
  hidden?: boolean;
}

interface Frame {
  camera: OrthographicCamera;
  parts: SoftwarePart[];
  grid?: GridHelper;
  axes?: AxesHelper;
  edgesVisible: boolean;
  /** Draw at half size without edges while a joint is being dragged. */
  draft: boolean;
}

// Directions the two lights shine from, in world coordinates.
const lightA = [-0.24, -0.43, 0.87];
const lightB = [0.63, 0.72, 0.3];

export function createSoftwarePreview(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { alpha: false });
  const layer = document.createElement('canvas');
  const layerContext = layer.getContext('2d');
  if (!context || !layerContext) throw new Error('Canvas rendering unavailable');

  let pixels: ImageData;
  let depth: Float32Array;
  let width = 0;
  let height = 0;
  const view = new Matrix4();
  const matrix = new Matrix4();
  let displaySize: [number, number] = [0, 0];
  let limit = 1024;

  function resize(displayWidth: number, displayHeight: number) {
    displaySize = [displayWidth, displayHeight];
    const scale = Math.min(1, limit / Math.max(displayWidth, displayHeight));
    const w = Math.max(1, Math.round(displayWidth * scale));
    const h = Math.max(1, Math.round(displayHeight * scale));
    if (width === w && height === h) return;
    width = canvas.width = layer.width = w;
    height = canvas.height = layer.height = h;
    pixels = new ImageData(w, h);
    depth = new Float32Array(w * h);
  }

  function project(points: ArrayLike<number>, transform: Matrix4) {
    const projected = new Float32Array(points.length);
    const e = transform.elements;
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i];
      const y = points[i + 1];
      const z = points[i + 2];
      projected[i] = (e[0] * x + e[4] * y + e[8] * z + e[12] + 1) * width / 2;
      projected[i + 1] = (1 - e[1] * x - e[5] * y - e[9] * z - e[13]) * height / 2;
      projected[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return projected;
  }

  function drawGuide(guide: GridHelper | AxesHelper, colors: string[]) {
    guide.updateMatrixWorld();
    const points = project(guide.geometry.attributes.position.array, matrix.multiplyMatrices(view, guide.matrixWorld));
    context!.lineWidth = 1;
    context!.beginPath();
    context!.strokeStyle = colors[0];
    for (let i = 0; i < points.length; i += 6) {
      if (colors.length > 1) {
        context!.beginPath();
        context!.strokeStyle = colors[i / 6];
      }
      context!.moveTo(points[i], points[i + 1]);
      context!.lineTo(points[i + 3], points[i + 4]);
      if (colors.length > 1) context!.stroke();
    }
    if (colors.length === 1) context!.stroke();
  }

  function drawTriangles({ mesh: model, matrix: world, color: tint }: SoftwarePart, points: Float32Array) {
    // A part can be turned by its joints. Turn the lights into its own frame instead of turning every normal.
    const w = world.elements;
    const local = (light: number[]) => [0, 4, 8].map((c) => w[c] * light[0] + w[c + 1] * light[1] + w[c + 2] * light[2]);
    const [ax0, ay0, az0] = local(lightA);
    const [bx0, by0, bz0] = local(lightB);
    const red = Math.min(255, tint[0] * 314);
    const green = Math.min(255, tint[1] * 314);
    const blue = Math.min(255, tint[2] * 314);
    const lights = new Float32Array(model.normals.length / 3);
    for (let n = 0; n < model.normals.length; n += 3) {
      const [x, y, z] = [model.normals[n], model.normals[n + 1], model.normals[n + 2]];
      lights[n / 3] = 0.53 + 0.4 * Math.max(0, ax0 * x + ay0 * y + az0 * z)
        + 0.14 * Math.max(0, bx0 * x + by0 * y + bz0 * z);
    }
    const { data } = pixels;
    const triangles = model.indices;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * 3;
      const b = triangles[i + 1] * 3;
      const c = triangles[i + 2] * 3;
      const ax = points[a];
      const ay = points[a + 1];
      const bx = points[b];
      const by = points[b + 1];
      const cx = points[c];
      const cy = points[c + 1];
      const abx = bx - ax;
      const aby = by - ay;
      const acx = cx - ax;
      const acy = cy - ay;
      const area = abx * acy - aby * acx;
      if (Math.abs(area) < 0.00001) continue;
      const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const top = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      const az = points[a + 2];
      const dzB = points[b + 2] - az;
      const dzC = points[c + 2] - az;
      const ambient = lights[a / 3];
      const dlB = lights[b / 3] - ambient;
      const dlC = lights[c / 3] - ambient;
      for (let y = top; y <= bottom; y++) {
        const dy = y + 0.5 - ay;
        for (let x = left; x <= right; x++) {
          const dx = x + 0.5 - ax;
          const u = (acy * dx - acx * dy) / area;
          const v = (abx * dy - aby * dx) / area;
          if (u < 0 || v < 0 || u + v > 1) continue;
          const z = az + u * dzB + v * dzC;
          const pixel = y * width + x;
          if (z > depth[pixel]) continue;
          depth[pixel] = z;
          const light = ambient + u * dlB + v * dlC;
          const color = pixel * 4;
          data[color] = red * light;
          data[color + 1] = green * light;
          data[color + 2] = blue * light;
          data[color + 3] = 255;
        }
      }
    }
  }

  function drawEdges(points: Float32Array) {
    const { data } = pixels;
    for (let i = 0; i < points.length; i += 6) {
      const ax = points[i];
      const ay = points[i + 1];
      const az = points[i + 2];
      const bx = points[i + 3];
      const by = points[i + 4];
      if (Math.max(ax, bx) < 0 || Math.min(ax, bx) >= width || Math.max(ay, by) < 0 || Math.min(ay, by) >= height) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = points[i + 5] - az;
      const steps = Math.min(2 * Math.max(width, height), Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))));
      for (let j = 0; j <= steps; j++) {
        const fraction = j / steps;
        const x = Math.floor(ax + fraction * dx);
        const y = Math.floor(ay + fraction * dy);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const pixel = y * width + x;
        // Compare near the triangle sample so hidden edges stay behind its surface.
        if (depth[pixel] === Infinity || az + fraction * dz > depth[pixel] + 0.00018) continue;
        const color = pixel * 4;
        data[color] = data[color] * 0.63 + 51 * 0.37;
        data[color + 1] = data[color + 1] * 0.63 + 37 * 0.37;
        data[color + 2] = data[color + 2] * 0.63 + 27 * 0.37;
      }
    }
  }

  function draw({ camera, parts, grid, axes, edgesVisible, draft }: Frame) {
    const wanted = draft ? 512 : 1024;
    if (wanted !== limit) {
      limit = wanted;
      resize(...displaySize);
    }
    if (!width || !height) return;
    camera.updateMatrixWorld();
    view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    context!.fillStyle = '#17222e';
    context!.fillRect(0, 0, width, height);
    if (grid?.visible) drawGuide(grid, ['#2b3947']);
    if (axes?.visible) drawGuide(axes, ['#bd7771', '#7caa87', '#7ca7cf']);
    if (!parts.length) return;

    pixels.data.fill(0);
    depth.fill(Infinity);
    // Every part goes into the depth buffer before any edge is drawn, so parts hide each other's edges.
    const drawn = parts.filter((part) => !part.hidden);
    for (const part of drawn) drawTriangles(part, project(part.mesh.positions, matrix.multiplyMatrices(view, part.matrix)));
    if (edgesVisible && !draft) {
      for (const part of drawn) drawEdges(project(part.mesh.edgeSegments, matrix.multiplyMatrices(view, part.matrix)));
    }
    layerContext!.putImageData(pixels, 0, 0);
    context!.drawImage(layer, 0, 0);
  }

  return { resize, draw };
}
