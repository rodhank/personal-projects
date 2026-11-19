// 3D view (three.js): live point cloud, accumulated world map, ARKit scene mesh, planes, camera path.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { MESH_CLASS_COLORS, PLANE_COLORS, COLORMAPS } from './colormap.js';
import { isValid } from './geometry.js';

const MAX_ACC = 2_000_000;

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d10);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 200);
    this.camera.position.set(2.5, 2, 2.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, -1);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(2, 5, 3);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(20, 40, 0x2a3340, 0x1a2028);
    this.grid.position.y = -1.5;
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(0.3));

    // live cloud (current frame)
    this.liveGeom = new THREE.BufferGeometry();
    this.livePos = new Float32Array(256 * 192 * 3);
    this.liveCol = new Float32Array(256 * 192 * 3);
    this.liveGeom.setAttribute('position', new THREE.BufferAttribute(this.livePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.liveGeom.setAttribute('color', new THREE.BufferAttribute(this.liveCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.liveMat = new THREE.PointsMaterial({ size: 0.012, vertexColors: true, sizeAttenuation: true });
    this.live = new THREE.Points(this.liveGeom, this.liveMat);
    this.live.frustumCulled = false;
    this.scene.add(this.live);

    // accumulated world map with voxel de-duplication
    this.accGeom = new THREE.BufferGeometry();
    this.accPos = new Float32Array(MAX_ACC * 3);
    this.accCol = new Float32Array(MAX_ACC * 3);
    this.accGeom.setAttribute('position', new THREE.BufferAttribute(this.accPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.accGeom.setAttribute('color', new THREE.BufferAttribute(this.accCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.accGeom.setDrawRange(0, 0);
    this.accMat = new THREE.PointsMaterial({ size: 0.012, vertexColors: true });
    this.acc = new THREE.Points(this.accGeom, this.accMat);
    this.acc.frustumCulled = false;
    this.scene.add(this.acc);
    this.accCount = 0;
    this.voxels = new Map();
    this.accDirty = false;

    // scene mesh
    this.meshGroup = new THREE.Group();
    this.scene.add(this.meshGroup);
    this.meshes = new Map();
    this.meshMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });
    this.meshWire = new THREE.MeshBasicMaterial({ color: 0x7fd1ff, wireframe: true, transparent: true, opacity: 0.35 });
    this.meshRaw = new Map();

    // planes
    this.planeGroup = new THREE.Group();
    this.scene.add(this.planeGroup);
    this.planes = new Map();

    // device camera marker + path
    this.device = makeFrustum();
    this.scene.add(this.device);
    this.trailPts = [];
    this.trailGeom = new THREE.BufferGeometry();
    this.trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(30000 * 3), 3));
    this.trailGeom.setDrawRange(0, 0);
    this.trail = new THREE.Line(this.trailGeom, new THREE.LineBasicMaterial({ color: 0xffd34d }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);

    this.opts = {};
    this.visible = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.visible) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = r.width + 'px';
    this.renderer.domElement.style.height = r.height + 'px';
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  setOptions(o) {
    this.opts = o;
    this.live.visible = o.showLive;
    this.acc.visible = o.showAccumulated;
    this.meshGroup.visible = o.showMesh;
    this.planeGroup.visible = o.showPlanes;
    this.device.visible = this.trail.visible = o.showCamera;
    this.liveMat.size = this.accMat.size = o.pointSize;
    this.meshGroup.children.forEach(m => { m.material = o.meshWireframe ? this.meshWire : this.meshMat; });
  }

  /** Called for every new frame. `rgb` is an ImageData at depth resolution or null. */
  updateFrame(frame, rgb, o) {
    const T = frame.T;
    const m = new THREE.Matrix4().fromArray(T);
    this.device.matrixAutoUpdate = false;
    this.device.matrix.copy(m);

    // camera path
    const p = [T[12], T[13], T[14]];
    const last = this.trailPts[this.trailPts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.02) {
      if (this.trailPts.length < 30000) {
        const arr = this.trailGeom.attributes.position.array;
        arr.set(p, this.trailPts.length * 3);
        this.trailPts.push(p);
        this.trailGeom.setDrawRange(0, this.trailPts.length);
        this.trailGeom.attributes.position.needsUpdate = true;
      }
    }

    if (o.followDevice) {
      const fwd = new THREE.Vector3(-T[8], -T[9], -T[10]);
      const pos = new THREE.Vector3(p[0], p[1], p[2]);
      this.camera.position.copy(pos).addScaledVector(fwd, -0.6).add(new THREE.Vector3(0, 0.25, 0));
      this.controls.target.copy(pos).addScaledVector(fwd, 1.5);
    }

    const needLive = o.showLive && this.visible;
    const needAcc = o.accumulate && frame.tracking === 'normal';
    if (!needLive && !needAcc) return;

    const { w, h, depth, K } = frame;
    const step = o.liveStep;
    const lut = COLORMAPS[o.colormap] || COLORMAPS.turbo;
    const span = Math.max(1e-6, o.max - o.min);
    let n = 0;
    const voxel = o.voxelSize;
    const inv = 1 / voxel;
    let added = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (!isValid(frame, i, o.confMin)) continue;
        const d = depth[i];
        if (d > o.maxRange) continue;
        const cx = (x - K.cx) * d / K.fx, cy = -(y - K.cy) * d / K.fy, cz = -d;
        const wx = T[0] * cx + T[4] * cy + T[8] * cz + T[12];
        const wy = T[1] * cx + T[5] * cy + T[9] * cz + T[13];
        const wz = T[2] * cx + T[6] * cy + T[10] * cz + T[14];
        let r, g, b;
        if (rgb && o.colorBy === 'rgb') {
          r = rgb.data[i * 4] / 255; g = rgb.data[i * 4 + 1] / 255; b = rgb.data[i * 4 + 2] / 255;
        } else {
          let t = (d - o.min) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const k = Math.round(t * 255) * 3;
          r = lut[k] / 255; g = lut[k + 1] / 255; b = lut[k + 2] / 255;
        }
        if (needLive) {
          this.livePos[n * 3] = wx; this.livePos[n * 3 + 1] = wy; this.livePos[n * 3 + 2] = wz;
          this.liveCol[n * 3] = r; this.liveCol[n * 3 + 1] = g; this.liveCol[n * 3 + 2] = b;
          n++;
        }
        if (needAcc && this.accCount < MAX_ACC) {
          const key = (Math.floor(wx * inv) + 32768) * 4294967296 + (Math.floor(wy * inv) + 32768) * 65536 + (Math.floor(wz * inv) + 32768);
          if (!this.voxels.has(key)) {
            this.voxels.set(key, this.accCount);
            const j = this.accCount * 3;
            this.accPos[j] = wx; this.accPos[j + 1] = wy; this.accPos[j + 2] = wz;
            this.accCol[j] = r; this.accCol[j + 1] = g; this.accCol[j + 2] = b;
            this.accCount++;
            added++;
          }
        }
      }
    }
    if (needLive) {
      this.liveGeom.setDrawRange(0, n);
      this.liveGeom.attributes.position.needsUpdate = true;
      this.liveGeom.attributes.color.needsUpdate = true;
    }
    if (added) {
      this.accGeom.setDrawRange(0, this.accCount);
      this.accGeom.attributes.position.needsUpdate = true;
      this.accGeom.attributes.color.needsUpdate = true;
    }
  }

  clearAccumulated() {
    this.voxels.clear();
    this.accCount = 0;
    this.accGeom.setDrawRange(0, 0);
    this.trailPts = [];
    this.trailGeom.setDrawRange(0, 0);
  }

  /** Accumulated cloud as plain arrays for export. */
  accumulatedCloud() {
    return { positions: this.accPos.subarray(0, this.accCount * 3), colors: this.accCol.subarray(0, this.accCount * 3), count: this.accCount };
  }

  updateMesh(update, colorBy) {
    if (update.full) {
      for (const id of [...this.meshes.keys()]) if (!update.anchors.find(a => a.id === id)) this.removeMesh(id);
    }
    for (const id of update.removed) this.removeMesh(id);
    for (const a of update.anchors) {
      this.meshRaw.set(a.id, a);
      this.buildMesh(a, colorBy);
    }
  }

  rebuildMeshColors(colorBy) {
    for (const a of this.meshRaw.values()) this.buildMesh(a, colorBy);
  }

  buildMesh(a, colorBy) {
    const faces = a.indices.length / 3;
    const pos = new Float32Array(faces * 9);
    const col = new Float32Array(faces * 9);
    const v = a.vertices, idx = a.indices;
    for (let f = 0; f < faces; f++) {
      const cls = a.classes ? a.classes[f] : 0;
      const c = MESH_CLASS_COLORS[cls] || MESH_CLASS_COLORS[0];
      for (let k = 0; k < 3; k++) {
        const vi = idx[f * 3 + k] * 3;
        const o = f * 9 + k * 3;
        pos[o] = v[vi]; pos[o + 1] = v[vi + 1]; pos[o + 2] = v[vi + 2];
        if (colorBy === 'class') { col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2]; }
        else { col[o] = col[o + 1] = col[o + 2] = 0.8; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    let mesh = this.meshes.get(a.id);
    if (mesh) { mesh.geometry.dispose(); mesh.geometry = g; }
    else {
      mesh = new THREE.Mesh(g, this.opts.meshWireframe ? this.meshWire : this.meshMat);
      mesh.matrixAutoUpdate = false;
      this.meshes.set(a.id, mesh);
      this.meshGroup.add(mesh);
    }
    mesh.matrix.fromArray(a.transform);
  }

  removeMesh(id) {
    const m = this.meshes.get(id);
    if (m) { this.meshGroup.remove(m); m.geometry.dispose(); }
    this.meshes.delete(id);
    this.meshRaw.delete(id);
  }

  clearMesh() {
    for (const id of [...this.meshes.keys()]) this.removeMesh(id);
  }

  meshStats() {
    let tris = 0, verts = 0;
    for (const a of this.meshRaw.values()) { tris += a.indices.length / 3; verts += a.vertices.length / 3; }
    return { anchors: this.meshRaw.size, tris, verts };
  }

  updatePlanes(planes) {
    const seen = new Set();
    let lowest = Infinity;
    for (const p of planes) {
      seen.add(p.id);
      let m = this.planes.get(p.id);
      const color = PLANE_COLORS[p.classification] ?? PLANE_COLORS.none;
      if (!m) {
        m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
        m.matrixAutoUpdate = false;
        this.planes.set(p.id, m);
        this.planeGroup.add(m);
      }
      m.material.color.setHex(color);
      // ARKit plane: extent along anchor-space x/z, centred at `center`, rotated by rotationY.
      const local = new THREE.Matrix4()
        .makeTranslation(p.center[0], p.center[1], p.center[2])
        .multiply(new THREE.Matrix4().makeRotationY(p.rotationY || 0))
        .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
        .multiply(new THREE.Matrix4().makeScale(p.extent[0], p.extent[1], 1));
      m.matrix.fromArray(p.transform).multiply(local);
      if (p.alignment === 'horizontal' && p.classification === 'floor') lowest = Math.min(lowest, p.transform[13] + p.center[1]);
    }
    for (const [id, m] of this.planes) {
      if (!seen.has(id)) { this.planeGroup.remove(m); m.geometry.dispose(); this.planes.delete(id); }
    }
    if (Number.isFinite(lowest)) this.grid.position.y = lowest;
  }

  setMeasure(points) {
    this.measureGroup.clear();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd34d });
    for (const p of points) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), mat);
      s.position.fromArray(p.world);
      this.measureGroup.add(s);
    }
    if (points.length === 2) {
      const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3().fromArray(p.world)));
      this.measureGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd34d })));
    }
  }

  resetView() {
    this.camera.position.set(2.5, 2, 2.5);
    this.controls.target.set(0, 0, -1);
  }

  snapshotPNG() {
    this.renderer.render(this.scene, this.camera);
    return new Promise(res => this.renderer.domElement.toBlob(res, 'image/png'));
  }
}

function makeFrustum() {
  const s = 0.08, d = 0.12;
  const pts = [
    [0, 0, 0], [-s, s * 0.75, -d], [0, 0, 0], [s, s * 0.75, -d], [0, 0, 0], [s, -s * 0.75, -d], [0, 0, 0], [-s, -s * 0.75, -d],
    [-s, s * 0.75, -d], [s, s * 0.75, -d], [s, s * 0.75, -d], [s, -s * 0.75, -d], [s, -s * 0.75, -d], [-s, -s * 0.75, -d], [-s, -s * 0.75, -d], [-s, s * 0.75, -d],
  ];
  const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p)));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff }));
}
