import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { poseBounds, solvePose, type Matrix } from '../engine/assembly.ts';
import type { MeasurePickType, ModelPreview, PartMesh, Pose, Vec3 } from '../engine/protocol.ts';
import { transformPoint } from '../engine/measure.ts';
import { pickAt, preparePicking, type Hit, type PickPart, type PickView } from '../picking.ts';
import { createSoftwarePreview, type SoftwareGuides, type SoftwarePart } from './softwarePreview.ts';

const directions = {
  iso: new THREE.Vector3(1, -1.45, 1.22),
  top: new THREE.Vector3(0, -0.000001, 1),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
};
export type ViewAngle = keyof typeof directions;

/** A face, edge or corner the measure tool marks. */
export interface Mark {
  part: number;
  type: MeasurePickType;
  index: number;
}

export interface MeasureHooks {
  /** A click without a drag. Undefined when the click was over nothing. */
  onPick(hit: Hit | undefined): void;
}

// Colours of the marks: the first pick, the second pick, what the pointer is over, and the line between picks.
const markColors = { first: '#ffc933', second: '#4cc9ff', hover: '#ffffff', line: '#f4f7fa' };
const rgb255 = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
};

function sameMark(a?: Mark, b?: Mark) {
  return a === b || (!!a && !!b && a.part === b.part && a.type === b.type && a.index === b.index);
}

/** The triangles of one face of a mesh, as an index list. */
function faceIndices(mesh: PartMesh, face: number) {
  const out: number[] = [];
  for (let t = 0; t < mesh.faceOf.length; t++) {
    if (mesh.faceOf[t] === face) out.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  return Uint32Array.from(out);
}

/** The drawn segments of one edge of a mesh. */
function edgeSegmentsOf(mesh: PartMesh, edge: number) {
  const out: number[] = [];
  for (let s = 0; s < mesh.edgeOf.length; s++) {
    if (mesh.edgeOf[s] === edge) out.push(...mesh.edgeSegments.subarray(s * 6, s * 6 + 6));
  }
  return Float32Array.from(out);
}

function gridSpacing(span: number) {
  const ideal = span / 10;
  const scale = 10 ** Math.floor(Math.log10(ideal));
  const range = ideal / scale;
  return (range >= 5 ? 5 : range >= 2 ? 2 : 1) * scale;
}

export function createViewer(host: HTMLElement, onOrbit: () => void, onGraphicsError: (failed: boolean) => void) {
  let canvas = document.createElement('canvas');
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    const context = canvas.getContext('webgl2', { antialias: true, powerPreference: 'low-power' });
    if (context) renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  } catch {
    canvas = document.createElement('canvas');
  }
  const software = renderer ? undefined : createSoftwarePreview(canvas);
  if (renderer) {
    renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.28;
  }
  canvas.setAttribute('aria-label', 'Interactive 3D part preview');
  host.append(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#17222e');
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  camera.position.copy(directions.iso).multiplyScalar(60);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minZoom = 0.12;
  controls.maxZoom = 70;

  const sky = new THREE.HemisphereLight(0xe8f0ff, 0x554334, 2.25);
  const key = new THREE.DirectionalLight(0xfff1d5, 2.25);
  key.position.set(-1, -2, 4);
  const fill = new THREE.DirectionalLight(0xd3e7ff, 1.15);
  fill.position.set(3, 4, 2);
  scene.add(sky, key, fill);

  const edgeMaterial = new THREE.LineBasicMaterial({ color: '#3b291b', transparent: true, opacity: 0.66, depthWrite: false });
  const objects = new THREE.Group();
  scene.add(objects);
  // One group per part. A joint move only rewrites these matrices.
  let partGroups: THREE.Group[] = [];
  let partEdges: THREE.LineSegments[] = [];
  let softwareParts: SoftwarePart[] = [];
  let disposables: { dispose(): void }[] = [];
  let draft = false;
  let grid: THREE.GridHelper | undefined;
  let axes: THREE.AxesHelper | undefined;
  let radius = 45;
  let gridVisible = true;
  let edgesVisible = true;
  let lost = false;
  let frameRequest = 0;
  let currentModel: ModelPreview | undefined;
  // Parts left out of the picture, by name, so a rebuild keeps them hidden. Only the preview changes.
  let hiddenNames: ReadonlySet<string> = new Set();
  // The measure tool: what is under the pointer, what is picked, and the line between two picks.
  let measureHooks: MeasureHooks | undefined;
  let hover: Mark | undefined;
  let picked: Mark[] = [];
  let measureLine: [Vec3, Vec3] | undefined;
  let poseMatrices: Matrix[] = [];
  let overlay: THREE.Object3D[] = [];
  let overlayDisposables: { dispose(): void }[] = [];
  let fatMaterials: LineMaterial[] = [];

  function draw() {
    if (lost || frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (lost) return;
      if (renderer) renderer.render(scene, camera);
      else software?.draw({ camera, parts: softwareParts, grid, axes, edgesVisible, draft, guides: softwareGuides() });
    });
  }

  function frame() {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const aspect = width / height;
    const vertical = radius * 1.19 / Math.min(aspect, 1);
    camera.top = vertical;
    camera.bottom = -vertical;
    camera.left = -vertical * aspect;
    camera.right = vertical * aspect;
    camera.near = radius * 0.001;
    camera.far = radius * 120;
    camera.updateProjectionMatrix();
    renderer?.setSize(width, height, false);
    for (const material of fatMaterials) material.resolution.set(width, height);
    software?.resize(width, height);
    draw();
  }

  function fit(angle?: ViewAngle) {
    const direction = angle ? directions[angle] : camera.position.clone().sub(controls.target);
    camera.position.copy(direction).normalize().multiplyScalar(radius * 3.5);
    camera.zoom = 1;
    controls.target.set(0, 0, 0);
    controls.update();
    frame();
  }

  function setGrid(span: number, z: number) {
    if (grid) {
      scene.remove(grid);
      grid.dispose();
    }
    if (axes) {
      scene.remove(axes);
      axes.dispose();
    }
    const step = gridSpacing(span);
    const divisions = Math.min(150, Math.ceil(span * 5 / step));
    grid = new THREE.GridHelper(divisions * step, divisions, '#354957', '#253340');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = z - step * 0.002;
    grid.visible = gridVisible;
    const gridMaterial = grid.material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.92;
    scene.add(grid);

    axes = new THREE.AxesHelper(step * 1.8);
    axes.setColors('#bd7771', '#7caa87', '#7ca7cf');
    axes.position.set(-span * 0.58, -span * 0.34, z);
    axes.visible = gridVisible;
    scene.add(axes);
  }

  function applyPose(pose: Pose) {
    if (!currentModel) return;
    poseMatrices = solvePose(currentModel.assembly, pose);
    poseMatrices.forEach((m, i) => {
      // Parts are drawn in a group that is moved to centre the model on the origin.
      const matrix = partGroups[i]?.matrix ?? softwareParts[i].matrix;
      matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
      if (partGroups[i]) partGroups[i].matrixWorldNeedsUpdate = true;
      else matrix.premultiply(offsetMatrix.makeTranslation(objects.position));
    });
  }

  function applyHidden() {
    currentModel?.assembly.parts.forEach((part, i) => {
      const hidden = hiddenNames.has(part.name);
      if (partGroups[i]) partGroups[i].visible = !hidden;
      if (softwareParts[i]) softwareParts[i].hidden = hidden;
    });
  }

  const offsetMatrix = new THREE.Matrix4();

  function setModel(model: ModelPreview | undefined, pose: Pose) {
    currentModel = model;
    objects.clear();
    for (const item of disposables) item.dispose();
    disposables = [];
    partGroups = [];
    partEdges = [];
    softwareParts = [];
    poseMatrices = [];
    hover = undefined;
    picked = [];
    measureLine = undefined;
    clearOverlay();
    if (!model) {
      radius = 45;
      setGrid(80, -3);
      fit();
      return;
    }

    const { assembly, meshes, partMesh } = model;
    const bounds = poseBounds(assembly, partMesh.map((i) => meshes[i].bounds), pose);
    const min = new THREE.Vector3(...bounds.min);
    const max = new THREE.Vector3(...bounds.max);
    const centre = min.clone().add(max).multiplyScalar(0.5);
    const size = max.clone().sub(min);
    objects.position.copy(centre).negate();

    if (renderer) {
      const geometries = meshes.map((mesh) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        const lines = new THREE.BufferGeometry();
        lines.setAttribute('position', new THREE.BufferAttribute(mesh.edgeSegments, 3));
        disposables.push(geometry, lines);
        return { geometry, lines };
      });
      assembly.parts.forEach((part, i) => {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(...part.color, THREE.SRGBColorSpace), metalness: 0.17, roughness: 0.6,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        disposables.push(material);
        const { geometry, lines } = geometries[partMesh[i]];
        const edges = new THREE.LineSegments(lines, edgeMaterial);
        edges.visible = edgesVisible;
        edges.renderOrder = 1;
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.add(new THREE.Mesh(geometry, material), edges);
        objects.add(group);
        partGroups.push(group);
        partEdges.push(edges);
      });
    } else {
      softwareParts = assembly.parts.map((part, i) => ({ mesh: meshes[partMesh[i]], matrix: new THREE.Matrix4(), color: part.color }));
    }

    applyPose(pose);
    applyHidden();
    if (measureHooks) prepare();
    radius = Math.max(size.length() / 2, 0.001);
    setGrid(Math.max(size.x, size.y, size.z), min.z - centre.z);
    fit();
  }

  // ---- Measure tool ------------------------------------------------------------------------------

  function pickParts(): PickPart[] {
    if (!currentModel) return [];
    const { assembly, meshes, partMesh } = currentModel;
    return assembly.parts.map((part, i) => ({ mesh: meshes[partMesh[i]], matrix: poseMatrices[i], visible: !hiddenNames.has(part.name) }));
  }

  /** The camera in the model's own coordinates. The scene is the model moved by objects.position. */
  function pickView(): PickView {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const width = Math.max(1, host.clientWidth);
    const o = objects.position;
    return {
      origin: [camera.position.x - o.x, camera.position.y - o.y, camera.position.z - o.z],
      right: [e[0], e[1], e[2]],
      up: [e[4], e[5], e[6]],
      forward: [-e[8], -e[9], -e[10]],
      scale: width / ((camera.right - camera.left) / camera.zoom),
      cx: width / 2,
      cy: Math.max(1, host.clientHeight) / 2,
    };
  }

  /** Build the hierarchies the first pick needs, after the frame that turned the tool on. */
  function prepare() {
    const meshes = currentModel?.meshes;
    if (meshes) setTimeout(() => meshes.forEach(preparePicking), 0);
  }

  function marksList() {
    const list = picked.map((mark, i) => ({ mark, color: i ? markColors.second : markColors.first, strong: true }));
    if (hover && !picked.some((mark) => sameMark(mark, hover))) list.push({ mark: hover, color: markColors.hover, strong: false });
    return list;
  }

  function clearOverlay() {
    for (const object of overlay) object.removeFromParent();
    overlay = [];
    for (const item of overlayDisposables) item.dispose();
    overlayDisposables = [];
    fatMaterials = [];
  }

  let dotTexture: THREE.CanvasTexture | undefined;
  function dot() {
    if (!dotTexture) {
      const face = document.createElement('canvas');
      face.width = face.height = 32;
      const g = face.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(16, 16, 14, 0, Math.PI * 2);
      g.fill();
      dotTexture = new THREE.CanvasTexture(face);
    }
    return dotTexture;
  }

  /** The marks as three.js objects: they live in the part's group, so a joint carries them along. */
  function buildOverlay() {
    clearOverlay();
    if (!currentModel) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const fat = (segments: Float32Array, color: string, depthTest: boolean, pixels: number) => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(segments);
      const material = new LineMaterial({ color: new THREE.Color(color), linewidth: pixels, depthTest, transparent: true });
      material.resolution.set(width, height);
      fatMaterials.push(material);
      overlayDisposables.push(geometry, material);
      const line = new LineSegments2(geometry, material);
      line.renderOrder = 3;
      return line;
    };
    for (const { mark, color, strong } of marksList()) {
      const group = partGroups[mark.part];
      const mesh = currentModel.meshes[currentModel.partMesh[mark.part]];
      if (!group || !mesh) continue;
      let object: THREE.Object3D;
      if (mark.type === 'face') {
        // The face's own triangles, copied, so that the overlay owns its buffers.
        const picked = faceIndices(mesh, mark.index);
        const positions = new Float32Array(picked.length * 3);
        picked.forEach((vertex, k) => positions.set(mesh.positions.subarray(vertex * 3, vertex * 3 + 3), k * 3));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: strong ? 0.5 : 0.28, depthWrite: false, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        overlayDisposables.push(geometry, material);
        object = new THREE.Mesh(geometry, material);
        object.renderOrder = 2;
      } else if (mark.type === 'edge') {
        object = fat(edgeSegmentsOf(mesh, mark.index), color, true, strong ? 4 : 3);
      } else {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.corners.subarray(mark.index * 3, mark.index * 3 + 3)), 3));
        const material = new THREE.PointsMaterial({ color, size: strong ? 13 : 11, sizeAttenuation: false, depthTest: false, map: dot(), alphaTest: 0.4, transparent: true });
        overlayDisposables.push(geometry, material);
        object = new THREE.Points(geometry, material);
        object.renderOrder = 4;
      }
      group.add(object);
      overlay.push(object);
    }
    if (measureLine) {
      // In the model's coordinates, so it goes in the group that centres the model.
      const line = fat(Float32Array.from([...measureLine[0], ...measureLine[1]]), markColors.line, false, 2);
      line.renderOrder = 5;
      objects.add(line);
      overlay.push(line);
    }
  }

  function applySoftwareMarks() {
    for (const part of softwareParts) {
      part.faceTints = undefined;
      part.edgeMarks = undefined;
    }
    for (const { mark, color, strong } of marksList()) {
      const part = softwareParts[mark.part];
      if (!part) continue;
      const rgb = rgb255(color);
      if (mark.type === 'face') (part.faceTints ??= []).push({ face: mark.index, color: rgb, amount: strong ? 0.62 : 0.4 });
      else if (mark.type === 'edge') (part.edgeMarks ??= []).push({ segments: edgeSegmentsOf(part.mesh, mark.index), color: rgb });
    }
  }

  function softwareGuides(): SoftwareGuides | undefined {
    if (!software || !currentModel || (!picked.length && !hover && !measureLine)) return undefined;
    const o = objects.position;
    const scene = (p: Vec3): [number, number, number] => [p[0] + o.x, p[1] + o.y, p[2] + o.z];
    const dots: SoftwareGuides['dots'] = [];
    for (const { mark, color } of marksList()) {
      const part = softwareParts[mark.part];
      if (mark.type !== 'vertex' || !part || !poseMatrices[mark.part]) continue;
      dots.push({ at: scene(transformPoint(poseMatrices[mark.part], part.mesh.corners, mark.index * 3)), color });
    }
    return { dots, line: measureLine && { from: scene(measureLine[0]), to: scene(measureLine[1]), color: markColors.line } };
  }

  function refreshMarks() {
    if (renderer) buildOverlay();
    else applySoftwareMarks();
    draw();
  }

  function hitAt(x: number, y: number) {
    return currentModel ? pickAt(pickParts(), pickView(), x, y) : undefined;
  }

  const pointerAt = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  let hoverFrame = 0;
  let hoverPoint: [number, number] | undefined;
  let pressed: { x: number; y: number } | undefined;
  // Every finger or button that is down. A second finger makes the gesture a pinch or a pan, which never picks.
  const down = new Set<number>();
  let gesture = false;
  const onHover = (event: PointerEvent) => {
    if (!measureHooks || event.buttons) return;
    hoverPoint = pointerAt(event);
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (!measureHooks || !hoverPoint) return;
      const hit = hitAt(...hoverPoint);
      const next = hit && { part: hit.part, type: hit.type, index: hit.index };
      if (sameMark(next, hover)) return;
      hover = next;
      refreshMarks();
    });
  };
  const onLeave = () => {
    hoverPoint = undefined;
    if (!hover) return;
    hover = undefined;
    refreshMarks();
  };
  const onPress = (event: PointerEvent) => {
    down.add(event.pointerId);
    if (down.size > 1) gesture = true;
    pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  };
  const onRelease = (event: PointerEvent) => {
    down.delete(event.pointerId);
    const start = pressed;
    const multi = gesture;
    pressed = undefined;
    if (!down.size) gesture = false;
    // A drag orbits and two fingers zoom. Only a click or a tap that stayed put picks.
    if (!measureHooks || multi || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    measureHooks.onPick(hitAt(...pointerAt(event)));
  };
  const onCancel = (event: PointerEvent) => {
    down.delete(event.pointerId);
    pressed = undefined;
    if (!down.size) gesture = false;
  };
  canvas.addEventListener('pointermove', onHover);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onPress);
  canvas.addEventListener('pointerup', onRelease);
  canvas.addEventListener('pointercancel', onCancel);

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    onGraphicsError(true);
  };
  const onRestored = () => {
    lost = false;
    onGraphicsError(false);
    draw();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  controls.addEventListener('change', draw);
  controls.addEventListener('start', onOrbit);
  const resize = new ResizeObserver(frame);
  resize.observe(host);
  setGrid(80, -3);
  fit('iso');

  return {
    software: !!software,
    setModel,
    /** Move the parts to a new pose. `dragging` lets the software view draw a quicker frame. */
    setPose(pose: Pose, dragging: boolean) {
      draft = dragging;
      applyPose(pose);
      draw();
    },
    fit,
    /** Turn the measure tool on (with its hooks) or off (undefined). */
    setMeasure(hooks: MeasureHooks | undefined) {
      measureHooks = hooks;
      canvas.style.cursor = hooks ? 'crosshair' : '';
      if (hooks) prepare();
      else {
        hover = undefined;
        refreshMarks();
      }
    },
    /** What is picked, and the line between two picks in the model's coordinates. */
    setPicks(marks: Mark[], line?: [Vec3, Vec3]) {
      picked = marks;
      measureLine = line;
      refreshMarks();
    },
    /** Leave these parts out of the picture. A name that is not in the model is ignored. */
    setHidden(names: ReadonlySet<string>) {
      hiddenNames = names;
      applyHidden();
      draw();
    },
    showGrid(value: boolean) {
      gridVisible = value;
      if (grid) grid.visible = value;
      if (axes) axes.visible = value;
      draw();
    },
    showEdges(value: boolean) {
      edgesVisible = value;
      for (const edges of partEdges) edges.visible = value;
      draw();
    },
    dispose() {
      cancelAnimationFrame(frameRequest);
      cancelAnimationFrame(hoverFrame);
      canvas.removeEventListener('pointermove', onHover);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onPress);
      canvas.removeEventListener('pointerup', onRelease);
      canvas.removeEventListener('pointercancel', onCancel);
      clearOverlay();
      dotTexture?.dispose();
      resize.disconnect();
      controls.dispose();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const item of disposables) item.dispose();
      axes?.dispose();
      grid?.dispose();
      edgeMaterial.dispose();
      renderer?.dispose();
      canvas.remove();
    },
  };
}
