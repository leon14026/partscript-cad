import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { poseBounds, solvePose } from '../engine/assembly.ts';
import type { ModelPreview, Pose } from '../engine/protocol.ts';
import { createSoftwarePreview, type SoftwarePart } from './softwarePreview.ts';

const directions = {
  iso: new THREE.Vector3(1, -1.45, 1.22),
  top: new THREE.Vector3(0, -0.000001, 1),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
};
export type ViewAngle = keyof typeof directions;

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

  function draw() {
    if (lost || frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (lost) return;
      if (renderer) renderer.render(scene, camera);
      else software?.draw({ camera, parts: softwareParts, grid, axes, edgesVisible, draft });
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
    solvePose(currentModel.assembly, pose).forEach((m, i) => {
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
    radius = Math.max(size.length() / 2, 0.001);
    setGrid(Math.max(size.x, size.y, size.z), min.z - centre.z);
    fit();
  }

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
