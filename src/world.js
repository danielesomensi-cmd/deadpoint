// DEADPOINT — gym, adjustable board, sculpted holds, Kilter-style LED rims, chalk, post-processing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BOARD_W, BOARD_H, KICK_TOP, MAT_TOP, mulberry32, clamp } from './logic.js';

const V3 = THREE.Vector3;
const deg = (d) => (d * Math.PI) / 180;
const easeOutBack = (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const ROLE_HEX = { start: '#36e27a', hand: '#2ad4e0', finish: '#ff3fb0', foot: '#ffc629' };
const HOLD_PALETTE = ['#c39a45', '#a9563f', '#3f638e', '#2b2d33', '#d9d2c2', '#5a7d55', '#6a5891'];

// half extents (m) of each hold family, and noise amount
const HOLD_SHAPE = {
  jug: { sx: 0.085, sy: 0.062, sz: 0.06, n: 0.07 },
  edge: { sx: 0.1, sy: 0.032, sz: 0.042, n: 0.05 },
  crimp: { sx: 0.07, sy: 0.02, sz: 0.028, n: 0.05 },
  sloper: { sx: 0.1, sy: 0.085, sz: 0.042, n: 0.06 },
  pinch: { sx: 0.036, sy: 0.08, sz: 0.052, n: 0.06 },
  chip: { sx: 0.03, sy: 0.024, sz: 0.02, n: 0.12 },
};
export const HOLD_DEPTH = { jug: 0.066, edge: 0.046, crimp: 0.031, sloper: 0.046, pinch: 0.057, chip: 0.022 };
const VARIANTS = 3;

export const QUALITY = {
  high: { dpr: 2, shadow: 2048, bloom: true, msaa: 4 },
  mid: { dpr: 1.5, shadow: 1024, bloom: true, msaa: 2 },
  low: { dpr: 1, shadow: 0, bloom: false, msaa: 0 },
};

function sculptHold(type, variant) {
  const sh = HOLD_SHAPE[type];
  const rnd = mulberry32(9001 + variant * 131 + type.charCodeAt(0) * 17 + type.length * 7);
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const pos = geo.attributes.position;
  const ax = 1 + (rnd() - 0.5) * 0.3, ay = 1 + (rnd() - 0.5) * 0.3;
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const v = new V3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nz = Math.sin(2.3 * v.x + ph[0]) * Math.sin(2.9 * v.y + ph[1]) * 0.6 + Math.sin(3.7 * v.z + 1.7 * v.x + ph[2]) * 0.4 + Math.sin(5.1 * v.y + 2.3 * v.z + ph[3]) * 0.25;
    const r = 1 + sh.n * nz;
    let X = v.x * r, Y = v.y * r, Z = v.z * r;
    if (type === 'jug') {
      // pocket behind a raised front lip: fingers go in from the top
      if (Y > 0) { const backness = 1 - smooth(-0.2, 0.85, Z); Y -= 0.6 * Y * backness * smooth(0.0, 0.5, Y); }
      if (Y < 0) Y *= 0.85;
    } else if (type === 'edge' || type === 'crimp') {
      if (Y > 0.35) Y = 0.35 + (Y - 0.35) * 0.18; // flat top ledge
      Z *= 1 - 0.18 * Math.max(0, -Y);
    } else if (type === 'pinch') {
      X *= 1 - 0.35 * Math.max(0, Z);
    } else if (type === 'sloper') {
      Z *= 0.95;
    }
    if (Z < 0) Z *= 0.1; // flat back against the panel
    pos.setXYZ(i, X * sh.sx * ax, Y * sh.sy * ay, (Z + 0.1) * sh.sz);
  }
  geo.computeVertexNormals();
  return { geo, rx: sh.sx * ax, ry: sh.sy * ay };
}

function canvasTex(renderer, w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

export function createWorld({ canvas, holds, quality = 'mid', test = {} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('no webgl');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0c11');
  scene.fog = new THREE.Fog('#0a0c11', 9, 22);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);
  camera.position.set(0, 1.6, 6);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight('#c9d8ff', '#3a2b1c', 0.32);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight('#ffe2c2', 0.55);
  fill.position.set(2.5, 7, 6);
  scene.add(fill);
  const key = new THREE.DirectionalLight('#fff1dd', 1.75);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2.7, right: 2.7, top: 2.7, bottom: -2.7, near: 0.5, far: 14 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key); scene.add(key.target);
  const rim = new THREE.DirectionalLight('#86a8ff', 0.7);
  rim.position.set(-4, 3.5, -1.5);
  scene.add(rim);

  // ---------- textures ----------
  const woodTex = canvasTex(renderer, 1024, 1024, (g, w, h) => {
    const rnd = mulberry32(7);
    g.fillStyle = '#ad8a5d'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 340; i++) {
      const y0 = rnd() * h, a = 2 + rnd() * 7, f = 0.003 + rnd() * 0.01, ph = rnd() * 6;
      g.strokeStyle = rnd() < 0.5 ? `rgba(98,66,36,${0.05 + rnd() * 0.08})` : `rgba(222,196,150,${0.04 + rnd() * 0.07})`;
      g.lineWidth = 0.6 + rnd() * 2;
      g.beginPath();
      for (let x = 0; x <= w; x += 16) { const y = y0 + Math.sin(x * f + ph) * a; if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }
    // panel seams (4x4 ft plywood sheets)
    for (let k = 1; k < 3; k++) {
      for (const [x0, y0, x1, y1] of [[(k * w) / 3, 0, (k * w) / 3, h], [0, (k * h) / 3, w, (k * h) / 3]]) {
        g.strokeStyle = 'rgba(40,28,16,0.75)'; g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        g.strokeStyle = 'rgba(255,236,200,0.18)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0 + 2, y0 + 2); g.lineTo(x1 + 2, y1 + 2); g.stroke();
      }
    }
    // t-nut grid
    const pxm = w / BOARD_W, pym = h / BOARD_H;
    for (let j = 0; ; j++) {
      const y = 0.14 + j * 0.2; if (y > BOARD_H - 0.1) break;
      for (let i = 0; ; i++) {
        const x = -BOARD_W / 2 + 0.13 + i * 0.2 + (j % 2 ? 0.1 : 0); if (x > BOARD_W / 2 - 0.1) break;
        const px = (x + BOARD_W / 2) * pxm, py = h - y * pym;
        g.fillStyle = 'rgba(24,18,12,0.85)'; g.beginPath(); g.arc(px, py, 3.4, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,240,210,0.12)'; g.beginPath(); g.arc(px + 0.8, py + 0.8, 3.8, 0, 7); g.fill();
        g.fillStyle = 'rgba(24,18,12,0.5)'; g.beginPath(); g.arc(px, py + 15, 2.2, 0, 7); g.fill();
      }
    }
    // chalk smudges above the holds, rubber marks low down
    for (let i = 0; i < 90; i++) {
      const x = rnd() * w, y = rnd() * h * 0.9, r = 6 + rnd() * 26;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${0.08 + rnd() * 0.14})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w, y = h * 0.55 + rnd() * h * 0.45, r = 3 + rnd() * 9;
      g.fillStyle = `rgba(20,18,16,${0.06 + rnd() * 0.1})`;
      g.beginPath(); g.ellipse(x, y, r * 1.6, r * 0.7, rnd() * 3, 0, 7); g.fill();
    }
  });
  const haloTex = canvasTex(renderer, 128, 128, (g, w) => {
    const r = w / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.75)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.32)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  const softTex = canvasTex(renderer, 64, 64, (g, w) => {
    const r = w / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  const padTex = canvasTex(renderer, 256, 256, (g, w, h) => {
    g.fillStyle = '#2b3549'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(3);
    for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.035})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    for (let i = 0; i < 18; i++) {
      const x = rnd() * w, y = rnd() * h, r = 10 + rnd() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  });
  const concreteTex = canvasTex(renderer, 256, 256, (g, w, h) => {
    g.fillStyle = '#16181d'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(11);
    for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.03})`; g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
  });
  concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping; concreteTex.repeat.set(8, 8);

  // ---------- gym ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.95, envMapIntensity: 0.2 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  const pads = [];
  const padMat = new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.92, envMapIntensity: 0.12 });
  const padGeo = new RoundedBoxGeometry(1.78, MAT_TOP, 2.43, 3, 0.07);
  for (let i = -1; i <= 1; i++) for (let j = 0; j < 2; j++) {
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(i * 1.8, MAT_TOP / 2, 0.05 + 1.22 + j * 2.45);
    pad.receiveShadow = true;
    scene.add(pad); pads.push(pad);
  }
  const kick = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, KICK_TOP, 0.06), new THREE.MeshStandardMaterial({ color: '#3a322a', roughness: 0.85, envMapIntensity: 0.2 }));
  kick.position.set(0, KICK_TOP / 2, -0.03); kick.receiveShadow = true;
  scene.add(kick);
  const steel = new THREE.MeshStandardMaterial({ color: '#1d2027', roughness: 0.45, metalness: 0.6, envMapIntensity: 0.6 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, KICK_TOP + 0.12, 0.12), steel);
    post.position.set(sx * (BOARD_W / 2 + 0.07), (KICK_TOP + 0.12) / 2, -0.08);
    scene.add(post);
  }
  const struts = [];
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 10), steel);
    scene.add(s); struts.push({ mesh: s, sx });
  }
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), new THREE.MeshStandardMaterial({ color: '#10131a', roughness: 1 }));
  backWall.position.set(0, 6, -3.2);
  scene.add(backWall);
  // other walls in the gym: dim silhouettes with holds for depth
  const sideHoldGeo = new THREE.IcosahedronGeometry(1, 1);
  const sideMat = new THREE.MeshStandardMaterial({ roughness: 0.8, envMapIntensity: 0.25 });
  const panelMat = new THREE.MeshStandardMaterial({ color: '#2a2f3a', roughness: 0.95, envMapIntensity: 0.15 });
  const addSideWall = (x, rotY, lean, w, h, seed) => {
    const grp = new THREE.Group();
    grp.position.set(x, 0, -1.0); grp.rotation.set(0, rotY, 0);
    const inner = new THREE.Group(); inner.rotation.x = lean; grp.add(inner);
    const p = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), panelMat);
    p.position.set(0, h / 2, -0.04); inner.add(p);
    const rnd = mulberry32(seed);
    const n = 70, m = new THREE.InstancedMesh(sideHoldGeo, sideMat, n);
    const q = new THREE.Quaternion(), c = new THREE.Color(), s = new V3(), pp = new V3(), e = new THREE.Euler();
    for (let i = 0; i < n; i++) {
      const r = 0.03 + rnd() * 0.06;
      pp.set((rnd() - 0.5) * (w - 0.3), 0.3 + rnd() * (h - 0.5), r * 0.3);
      s.set(r * (1 + rnd() * 0.6), r, r * 0.6);
      q.setFromEuler(e.set(0, 0, rnd() * 3));
      m.setMatrixAt(i, new THREE.Matrix4().compose(pp, q, s));
      m.setColorAt(i, c.set(HOLD_PALETTE[Math.floor(rnd() * HOLD_PALETTE.length)]).multiplyScalar(0.7));
    }
    inner.add(m);
    scene.add(grp);
  };
  addSideWall(-4.6, 0.55, 0.2, 3.2, 4.2, 21);
  addSideWall(4.7, -0.6, -0.12, 3.0, 4.0, 22);

  // ---------- board ----------
  const wall = new THREE.Group();
  wall.position.set(0, KICK_TOP, 0);
  scene.add(wall);
  const panelWood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.82, envMapIntensity: 0.12 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#3a3027', roughness: 0.9 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.05), [edgeMat, edgeMat, edgeMat, edgeMat, panelWood, edgeMat]);
  panel.position.set(0, BOARD_H / 2, -0.025); panel.receiveShadow = true;
  wall.add(panel);
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.09, BOARD_H + 0.1, 0.16), steel);
    r.position.set(sx * (BOARD_W / 2 + 0.045), BOARD_H / 2, -0.07);
    wall.add(r);
  }
  const topRail = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.18, 0.1, 0.16), steel);
  topRail.position.set(0, BOARD_H + 0.05, -0.07);
  wall.add(topRail);

  // ---------- holds ----------
  const shapes = {};
  for (const type of Object.keys(HOLD_SHAPE)) { shapes[type] = []; for (let v = 0; v < VARIANTS; v++) shapes[type].push(sculptHold(type, v)); }
  const holdMat = new THREE.MeshStandardMaterial({ roughness: 0.66, metalness: 0, envMapIntensity: 0.28 });
  const byId = {};
  for (const h of holds) { byId[h.id] = h; h.variant = (h.id * 7 + 3) % VARIANTS; }
  const _m4 = new THREE.Matrix4(), _qz = new THREE.Quaternion(), _sc = new V3(), _ps = new V3(), _z = new V3(0, 0, 1);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const holdMatrix = (h, out) => { _qz.setFromAxisAngle(_z, h.rot); _sc.setScalar(h.size); _ps.set(h.x, h.y, 0.002); return out.compose(_ps, _qz, _sc); };
  const inst = {}, instIndex = {};
  for (const type of Object.keys(HOLD_SHAPE)) for (let v = 0; v < VARIANTS; v++) {
    const list = holds.filter((h) => h.type === type && h.variant === v);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(shapes[type][v].geo, holdMat, list.length);
    const col = new THREE.Color();
    list.forEach((h, i) => {
      mesh.setMatrixAt(i, holdMatrix(h, _m4));
      mesh.setColorAt(i, col.set(HOLD_PALETTE[h.color]));
      instIndex[h.id] = { key: type + v, i };
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    wall.add(mesh);
    inst[type + v] = mesh;
  }
  const chipMat = holdMat.clone();
  for (let k = 0; k < 9; k++) {
    const chip = new THREE.Mesh(shapes.chip[k % VARIANTS].geo, chipMat.clone());
    chip.material.color.set(HOLD_PALETTE[(k * 3) % 7]);
    chip.position.set(-1.5 + k * 0.38, 0.38 + (k % 3) * 0.12, 0.012);
    scene.add(chip);
  }

  // ---------- lit problem: LED rim at the base of each hold + soft glow on the wood ----------
  const rimGeo = new THREE.TorusGeometry(1, 0.062, 8, 44);
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  let ledGain = 1, haloK = 1;
  // LED colours are scaled to the same luminance so every colour blooms the same amount
  const ledColor = (hex, out) => { out.set(hex); const l = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b; return out.multiplyScalar(ledGain / Math.max(0.05, l)); };
  let lit = [];
  const litById = {};
  function clearLit() {
    for (const L of lit) {
      wall.remove(L.mesh, L.halo, L.rim);
      L.mesh.material.dispose(); L.halo.material.dispose(); L.rim.material.dispose();
      const ix = instIndex[L.id];
      inst[ix.key].setMatrixAt(ix.i, holdMatrix(byId[L.id], _m4));
      inst[ix.key].instanceMatrix.needsUpdate = true;
    }
    lit = [];
    for (const k in litById) delete litById[k];
  }
  function lightProblem(pr, instant) {
    clearLit();
    const entries = Object.entries(pr.roles).map(([id, role]) => ({ id: +id, role }));
    entries.sort((a, b) => byId[a.id].y - byId[b.id].y || byId[a.id].x - byId[b.id].x);
    entries.forEach((e, k) => {
      const h = byId[e.id];
      const shape = shapes[h.type][h.variant];
      const col = new THREE.Color(ROLE_HEX[e.role]);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(HOLD_PALETTE[h.color]).lerp(col, 0.2), emissive: col, emissiveIntensity: 0, roughness: 0.6, envMapIntensity: 0.5 });
      const mesh = new THREE.Mesh(shape.geo, mat);
      holdMatrix(h, _m4).decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = true;
      wall.add(mesh);
      const ix = instIndex[e.id];
      inst[ix.key].setMatrixAt(ix.i, ZERO);
      inst[ix.key].instanceMatrix.needsUpdate = true;
      const rimMesh = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: ledColor(ROLE_HEX[e.role], new THREE.Color()), transparent: true, opacity: 0, depthWrite: false }));
      rimMesh.position.set(h.x, h.y, 0.006);
      rimMesh.rotation.z = h.rot;
      const rx = shape.rx * h.size * 1.08 + 0.006, ry = shape.ry * h.size * 1.08 + 0.006;
      rimMesh.userData.base = new V3(rx, ry, 1);
      rimMesh.scale.set(0.001, 0.001, 1);
      rimMesh.renderOrder = 3;
      wall.add(rimMesh);
      const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ map: haloTex, color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      const hs = Math.max(rx, ry) * 3.2 + 0.06;
      halo.position.set(h.x, h.y, 0.003);
      halo.scale.setScalar(0.001);
      halo.renderOrder = 2;
      wall.add(halo);
      const L = { id: e.id, role: e.role, mesh, halo, rim: rimMesh, hs, on: !!instant, t0: instant ? -10 : Infinity, order: k };
      lit.push(L); litById[e.id] = L;
    });
  }
  function scheduleSweep(t0) { lit.forEach((L, k) => { L.on = false; L.t0 = t0 + k * 0.065; }); }
  function revealAll(t) { for (const L of lit) if (L.t0 > t) L.t0 = t - 0.3; }
  function updateLit(now, nextId, onFirstOn) {
    for (const L of lit) {
      const dt = now - L.t0;
      if (dt < 0) { L.halo.material.opacity = 0; L.rim.material.opacity = 0; L.mesh.material.emissiveIntensity = 0; continue; }
      if (!L.on) { L.on = true; if (onFirstOn) onFirstOn(L); }
      const e = Math.min(1, dt / 0.22);
      let sc = dt < 0.22 ? easeOutBack(e) : 1;
      const fade = Math.min(1, dt / 0.08);
      let op = 0.42 * fade * haloK, em = 0.28;
      if (L.id === nextId) {
        const pz = 0.5 + 0.5 * Math.sin(now * 6.5);
        sc *= 1 + 0.1 * pz; op = (0.35 + 0.35 * pz) * haloK; em = 0.3 + 0.35 * pz;
      }
      const b = L.rim.userData.base;
      L.rim.scale.set(b.x * sc, b.y * sc, 1);
      L.rim.material.opacity = fade;
      L.halo.scale.setScalar(L.hs * sc);
      L.halo.material.opacity = op;
      L.mesh.material.emissiveIntensity = em;
    }
  }
  function setLedGain(gain, halo) {
    ledGain = gain; haloK = halo;
    for (const L of lit) ledColor(ROLE_HEX[L.role], L.rim.material.color);
  }

  // ---------- chalk particles ----------
  const chalkMat = new THREE.SpriteMaterial({ map: softTex, color: '#ffffff', transparent: true, depthWrite: false, opacity: 0 });
  const chalk = [];
  for (let i = 0; i < 40; i++) {
    const s = new THREE.Sprite(chalkMat.clone());
    s.visible = false; wall.add(s);
    chalk.push({ s, v: new V3(), life: 0, max: 1, size: 0.1 });
  }
  let chalkIdx = 0;
  function puff(pos, n, power = 1) {
    for (let i = 0; i < n; i++) {
      const c = chalk[chalkIdx++ % chalk.length];
      c.s.visible = true; c.s.position.copy(pos);
      c.v.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.2) * 0.7, 0.25 + Math.random() * 0.6).multiplyScalar(power);
      c.life = 0; c.max = 0.5 + Math.random() * 0.5; c.size = 0.05 + Math.random() * 0.07;
    }
  }
  function updateChalk(dt) {
    for (const c of chalk) {
      if (!c.s.visible) continue;
      c.life += dt;
      if (c.life >= c.max) { c.s.visible = false; continue; }
      const k = c.life / c.max;
      c.s.position.addScaledVector(c.v, dt);
      c.v.multiplyScalar(Math.exp(-dt * 3));
      c.s.scale.setScalar(c.size * (1 + k * 2.5));
      c.s.material.opacity = 0.55 * (1 - k);
    }
  }

  // ---------- board angle ----------
  let angle = 30;
  function setAngle(a) {
    angle = a;
    wall.rotation.x = deg(a);
    wall.updateMatrixWorld(true);
    const th = deg(a);
    const n = new V3(0, -Math.sin(th), Math.cos(th));
    const center = wall.localToWorld(new V3(0, BOARD_H * 0.5, 0));
    key.position.copy(center).addScaledVector(n, 5.5).add(new V3(1.4, 1.8, 0.8));
    key.target.position.copy(center);
    key.target.updateMatrixWorld();
    for (const s of struts) {
      const top = wall.localToWorld(new V3(s.sx * 1.25, 2.3, -0.08));
      const bot = new V3(s.sx * 1.25, 0.02, -1.3);
      s.mesh.position.addVectors(top, bot).multiplyScalar(0.5);
      const d = new V3().subVectors(top, bot);
      s.mesh.scale.set(1, d.length(), 1);
      s.mesh.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
    }
  }
  function worldYOf(local) { const th = deg(angle); return KICK_TOP + local.y * Math.cos(th) - local.z * Math.sin(th); }

  let padHitT = -1;
  function padHit(t) { padHitT = t; }
  function updatePads(t) {
    if (padHitT < 0) return;
    const k = (t - padHitT) / 0.35;
    const sq = k < 1 ? 1 - 0.12 * Math.sin(Math.PI * k) : 1;
    for (const p of pads) { p.scale.y = sq; p.position.y = (MAT_TOP * sq) / 2; }
    if (k >= 1) padHitT = -1;
  }

  // ---------- rendering + quality tiers ----------
  let W = 1, H = 1, tier = null, Q = null, composer = null, bloomPass = null;
  function buildComposer() {
    if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); composer = null; }
    if (!Q.bloom) return;
    const isGL2 = renderer.capabilities.isWebGL2;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: isGL2 ? Q.msaa : 0 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.3, 0.95);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(W, H);
  }
  function setQuality(name) {
    if (tier === name) return;
    tier = name;
    Q = { ...QUALITY[name], ...(test.quality || {}) };
    const dpr = Math.min(window.devicePixelRatio || 1, Q.dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    key.castShadow = Q.shadow > 0;
    if (Q.shadow > 0) {
      key.shadow.mapSize.set(Q.shadow, Q.shadow);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    setLedGain(Q.bloom ? 1.5 : 0.85, Q.bloom ? 0.5 : 1);
    buildComposer();
  }
  function resize(w, h) {
    W = w; H = h;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(W, H); }
  }
  function render() {
    if (test.noRender) return;
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  setQuality(quality);

  return {
    renderer, scene, camera, wall, pads, holdsById: byId,
    lightProblem, scheduleSweep, revealAll, updateLit, puff, updateChalk,
    setAngle, worldYOf, padHit, updatePads,
    setQuality, resize, render,
    get quality() { return tier; },
    get angle() { return angle; },
  };
}

export function gripPos(h, out) { return out.set(h.x, h.y + 0.012, HOLD_DEPTH[h.type] * 0.9 + 0.03); }
export function footPos(f, out) { return out.set(f.x, f.y + 0.03, (f.z ?? 0.04) + 0.075); }
