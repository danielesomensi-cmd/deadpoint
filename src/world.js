// DEADPOINT — gym, adjustable board, sculpted holds, Kilter-style LED rims, chalk, post-processing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BOARD_W, BOARD_H, KICK_TOP, MAT_TOP, LAYOUT, mulberry32, clamp } from './logic.js';

const V3 = THREE.Vector3;
const deg = (d) => (d * Math.PI) / 180;
const easeOutBack = (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Kilter-style LED colours: start green, hand cyan, finish magenta, foot orange
export const ROLE_HEX = { start: '#2bff5a', hand: '#12e6ff', finish: '#ff2bd6', foot: '#ff9a1a' };
const HOLD_PALETTE = ['#c39a45', '#a9563f', '#3f638e', '#2b2d33', '#d9d2c2', '#5a7d55', '#6a5891']; // side walls only
const HOLD_TONE = '#56585e'; // every board hold: one charcoal tone (±6%), so the LEDs carry the colour

// half extents (m) of each hold family, and depth of the body above the skirt
const HOLD_SHAPE = {
  jug: { sx: 0.074, sy: 0.062, d: 0.062, k: 0.5 },
  edge: { sx: 0.074, sy: 0.052, d: 0.042, k: 0.45 },
  crimp: { sx: 0.064, sy: 0.038, d: 0.027, k: 0.5 },
  sloper: { sx: 0.08, sy: 0.07, d: 0.042, k: -0.4 },
  pinch: { sx: 0.037, sy: 0.077, d: 0.056, k: 0 },
  chip: { sx: 0.038, sy: 0.03, d: 0.019, k: 0.2 },
};
const SKIRT = 0.004;
export const HOLD_DEPTH = Object.fromEntries(Object.entries(HOLD_SHAPE).map(([k, v]) => [k, v.d + SKIRT]));
const VARIANTS = 4;
// outline families, by how common they are on a Kilter set
const FAMILIES = [['tri', 0.4], ['D', 0.2], ['tear', 0.15], ['bean', 0.15], ['square', 0.1]];

export const QUALITY = {
  high: { dpr: 2, shadow: 2048, bloom: true, msaa: 4 },
  mid: { dpr: 1.5, shadow: 1024, bloom: true, msaa: 2 },
  low: { dpr: 1, shadow: 0, bloom: false, msaa: 0 },
};

// Closed outline (N points, unit box [-1,1]^2) of one hold family.
function holdOutline(fam, rnd, N) {
  const se = (t, n) => [Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 2 / n), Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 2 / n)];
  const a3 = 0.1 + rnd() * 0.07, ph3 = -Math.PI / 2 + (rnd() - 0.5) * 0.6;
  const a1 = (rnd() - 0.5) * 0.14, ph1 = rnd() * 6.28, a5 = 0.012 + rnd() * 0.02, ph5 = rnd() * 6.28;
  const tearDir = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    let x, y;
    if (fam === 'tri') { const r = 1 + a3 * Math.cos(3 * t + ph3) + a1 * Math.cos(t + ph1); x = r * Math.cos(t); y = r * Math.sin(t); }
    else if (fam === 'D') { [x, y] = se(t, 2.6); if (y > 0.25) y = 0.25 + (y - 0.25) * 0.2; }
    else if (fam === 'tear') { const r = 1 + 0.3 * Math.cos(t - tearDir) + 0.04 * Math.cos(3 * t + ph3); x = r * Math.cos(t); y = r * Math.sin(t); }
    else if (fam === 'bean') { [x, y] = se(t, 2.4); y -= 0.22 * (1 - x * x) * (y > 0 ? 1 : 0.4); }
    else { [x, y] = se(t, 4); }
    const n = 1 + a5 * Math.cos(5 * t + ph5);
    pts.push([x * n, y * n]);
  }
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return pts.map(([x, y]) => [((x - x0) / (x1 - x0)) * 2 - 1, ((y - y0) / (y1 - y0)) * 2 - 1]);
}

// Outline-driven hold: flat back, a thin darker skirt, a body whose peak leans to the grip side,
// a centre bolt and 1-2 set screws (chips: two screws). Vertex colours carry skirt, chalk and hardware.
function sculptHold(type, variant) {
  const sh = HOLD_SHAPE[type];
  const rnd = mulberry32(9001 + variant * 131 + type.charCodeAt(0) * 17 + type.length * 7);
  let fam;
  if (type === 'pinch') fam = rnd() < 0.5 ? 'tear' : 'tri';
  else { let r = rnd(); fam = FAMILIES.find(([, w]) => (r -= w) < 0)?.[0] || 'tri'; }
  const N = 32;
  const ax = 0.92 + rnd() * 0.16, ay = 0.92 + rnd() * 0.16;
  const sx = sh.sx * ax, sy = sh.sy * ay;
  const out = holdOutline(fam, rnd, N).map(([x, y]) => [x * sx, y * sy]);
  const ang = out.map(([x, y]) => Math.atan2(y, x)), rad = out.map(([x, y]) => Math.hypot(x, y));
  // boundary radius along any direction (outline is star-shaped around the bolt)
  const boundary = (a) => {
    let best = 0, bd = 9;
    for (let i = 0; i < N; i++) { let d = Math.abs(a - ang[i]); d = Math.min(d, 2 * Math.PI - d); if (d < bd) { bd = d; best = i; } }
    const j = (best + 1) % N, k = (best + N - 1) % N;
    const dj = Math.abs(Math.atan2(Math.sin(ang[j] - a), Math.cos(ang[j] - a))), dk = Math.abs(Math.atan2(Math.sin(ang[k] - a), Math.cos(ang[k] - a)));
    const o = dj < dk ? j : k, d2 = Math.min(dj, dk);
    return (rad[best] * d2 + rad[o] * bd) / Math.max(1e-6, bd + d2);
  };
  const k = sh.k;
  const body = (u, qx, qy) => {
    let f;
    if (type === 'sloper') f = Math.pow(Math.max(0, 1 - u * u), 0.7);
    else if (type === 'pinch') f = Math.pow(Math.max(0, 1 - Math.pow(u, 2.2)), 0.5) * (0.65 + 0.35 * (1 - Math.abs(qx)));
    else f = Math.pow(Math.max(0, 1 - Math.pow(u, 2.4)), 0.55);
    return SKIRT + sh.d * f * (1 + k * qy) / (1 + Math.abs(k));
  };
  const heightAt = (x, y) => {
    const u = Math.min(1, Math.hypot(x, y) / boundary(Math.atan2(y, x)));
    return body(u * 0.985, x / sx, y / sy);
  };
  const P = [], C = [], I = [];
  const vtx = (x, y, z, c) => { P.push(x, y, z); C.push(c, c, c); return P.length / 3 - 1; };
  const ring = (fn) => { const a = []; for (let i = 0; i < N; i++) a.push(fn(i)); return a; };
  const strip = (r0, r1) => { for (let i = 0; i < N; i++) { const j = (i + 1) % N; I.push(r0[i], r1[j], r1[i], r0[i], r0[j], r1[j]); } };
  const inset = (i, d) => { const [x, y] = out[i], r = rad[i]; return [x * (1 - d / r), y * (1 - d / r)]; };
  const ringA = ring((i) => vtx(out[i][0], out[i][1], 0, 0.5));
  const ringB = ring((i) => { const [x, y] = inset(i, 0.003); return vtx(x, y, SKIRT, 0.58); });
  strip(ringA, ringB);
  let prev = ring((i) => { const [x, y] = inset(i, 0.003); return vtx(x, y, SKIRT, 0.92); });
  for (const u of [0.97, 0.9, 0.78, 0.62, 0.44, 0.26, 0.1]) {
    const r = ring((i) => {
      const [bx, by] = inset(i, 0.003), x = bx * u, y = by * u, qx = x / sx, qy = y / sy;
      let c = 1 + 0.45 * smooth(0.0, 0.9, qy) * (1 - u * u) + 0.12 * (1 - u); // chalk on the grip side
      if (type === 'jug' && qy > 0.35 && u > 0.5) c *= 0.72; // shadowed pocket behind the lip
      return vtx(x, y, body(u * 0.985, qx, qy), c);
    });
    strip(prev, r); prev = r;
  }
  const ctr = vtx(0, 0, body(0, 0, 0), 1.1);
  for (let i = 0; i < N; i++) I.push(prev[i], prev[(i + 1) % N], ctr);
  // hardware: small dark fans that follow the surface
  const disc = (cx, cy, r, c, seg = 10) => {
    const c0 = vtx(cx, cy, heightAt(cx, cy) + 0.0012, c);
    const rr = [];
    for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; rr.push(vtx(x, y, heightAt(x, y) + 0.0012, c)); }
    for (let i = 0; i < seg; i++) I.push(c0, rr[i], rr[(i + 1) % seg]);
  };
  if (type === 'chip') { disc(-0.0125, -0.002, 0.0035, 0.18, 8); disc(0.0125, -0.002, 0.0035, 0.18, 8); }
  else {
    disc(0, 0, 0.011, 0.42, 14); disc(0, 0, 0.0065, 0.08, 10); // washer + bolt hole
    const ns = rnd() < 0.5 ? 1 : 2, a0 = rnd() * Math.PI * 2;
    for (let n = 0; n < ns; n++) {
      const a = a0 + n * (2.2 + rnd()), r = boundary(a) * 0.62;
      disc(Math.cos(a) * r, Math.sin(a) * r, 0.003, 0.12, 6);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  // LED glow that hugs the outline: filled to the hold edge, solid band just outside it, then feathered
  const G = [0, 0, 0], GA = [1, 1, 1, 1], GI = [];
  const rings = [[1.0, 0, 1], [1.15, 0.01, 0.75], [1.2, 0.045, 0]];
  rings.forEach(([m, d, al]) => { for (let i = 0; i < N; i++) { const [x, y] = out[i], r = rad[i]; G.push(x * m + (x / r) * d, y * m + (y / r) * d, 0); GA.push(1, 1, 1, al); } });
  for (let i = 0; i < N; i++) GI.push(0, 1 + i, 1 + ((i + 1) % N));
  for (let rI = 0; rI < 2; rI++) for (let i = 0; i < N; i++) {
    const a = 1 + rI * N + i, b = 1 + rI * N + ((i + 1) % N), c = a + N, d = b + N;
    GI.push(a, c, d, a, d, b);
  }
  const glow = new THREE.BufferGeometry();
  glow.setAttribute('position', new THREE.Float32BufferAttribute(G, 3));
  glow.setAttribute('color', new THREE.Float32BufferAttribute(GA, 4));
  glow.setIndex(GI);
  return { geo, glow, rx: sx, ry: sy };
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
  // smooth birch ply: low-contrast grain, 4 ft sheet seams, chalk where hands go, rubber low down
  const birch = (g, w, h, rnd, seams) => {
    g.fillStyle = '#d2b98f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const y0 = rnd() * h, a = 2 + rnd() * 6, f = 0.002 + rnd() * 0.008, ph = rnd() * 6;
      g.strokeStyle = rnd() < 0.55 ? `rgba(150,112,70,${0.03 + rnd() * 0.05})` : `rgba(245,228,196,${0.03 + rnd() * 0.05})`;
      g.lineWidth = 0.6 + rnd() * 2.2;
      g.beginPath();
      for (let x = 0; x <= w; x += 16) { const y = y0 + Math.sin(x * f + ph) * a; if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }
    if (seams) for (let k = 1; k < 3; k++) {
      for (const [x0, y0, x1, y1] of [[(k * w) / 3, 0, (k * w) / 3, h], [0, (k * h) / 3, w, (k * h) / 3]]) {
        g.strokeStyle = 'rgba(70,52,34,0.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
    }
  };
  const woodTex = canvasTex(renderer, 1024, 1024, (g, w, h) => {
    const rnd = mulberry32(7);
    birch(g, w, h, rnd, true);
    const pxm = w / BOARD_W, pym = h / BOARD_H, L = LAYOUT;
    // chalk smudges above random grid holds (hands), rubber marks around chips low on the board
    for (let n = 0; n < 120; n++) {
      const i = Math.floor(rnd() * L.cols), j = 2 + Math.floor(rnd() * (L.rows - 2));
      const x = (L.x0 + i * L.PX + BOARD_W / 2) * pxm, y = h - (L.y0 + j * L.PY + 0.05) * pym, r = 10 + rnd() * 22;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,255,255,${0.12 + rnd() * 0.18})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let n = 0; n < 110; n++) {
      const x = rnd() * w, y = h - rnd() * 1.2 * pym, r = 2 + rnd() * 7;
      g.fillStyle = `rgba(30,24,20,${0.05 + rnd() * 0.1})`;
      g.beginPath(); g.ellipse(x, y, r * 1.7, r * 0.6, rnd() * 3, 0, 7); g.fill();
    }
  });
  const kickTex = canvasTex(renderer, 1024, 256, (g, w, h) => {
    const rnd = mulberry32(8);
    birch(g, w, h, rnd, false);
    for (let n = 0; n < 160; n++) { // heavy rubber on the kickboard
      const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * 8;
      g.fillStyle = `rgba(30,24,20,${0.06 + rnd() * 0.12})`;
      g.beginPath(); g.ellipse(x, y, r * 1.7, r * 0.6, rnd() * 3, 0, 7); g.fill();
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
  // kickboard: birch like the board, black steel posts, dark hinge strip
  const steel = new THREE.MeshStandardMaterial({ color: '#141518', roughness: 0.62, metalness: 0.35, envMapIntensity: 0.4 });
  const plyEdge = new THREE.MeshStandardMaterial({ color: '#b89f74', roughness: 0.85 });
  const kickWood = new THREE.MeshStandardMaterial({ map: kickTex, roughness: 0.8, envMapIntensity: 0.12 });
  const kick = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, KICK_TOP, 0.018), [plyEdge, plyEdge, plyEdge, plyEdge, kickWood, plyEdge]);
  kick.position.set(0, KICK_TOP / 2, -0.009); kick.receiveShadow = true;
  scene.add(kick);
  const kickBack = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, KICK_TOP, 0.12), steel);
  kickBack.position.set(0, KICK_TOP / 2, -0.08);
  scene.add(kickBack);
  const hinge = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.2, 0.01, 0.03), new THREE.MeshStandardMaterial({ color: '#0d0e10', roughness: 0.5, metalness: 0.5 }));
  hinge.position.set(0, KICK_TOP, -0.005);
  scene.add(hinge);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, KICK_TOP + 0.04, 0.15), steel);
    post.position.set(sx * (BOARD_W / 2 + 0.05), (KICK_TOP + 0.04) / 2, -0.06);
    scene.add(post);
  }
  // telescoping rear struts (outer tube from the floor, inner tube up to the board)
  const struts = [];
  for (const sx of [-1, 1]) {
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 12), steel);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 12), steel);
    scene.add(outer, inner); struts.push({ outer, inner, sx });
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
  const panelWood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.78, envMapIntensity: 0.12 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.018), [plyEdge, plyEdge, plyEdge, plyEdge, panelWood, plyEdge]);
  panel.position.set(0, BOARD_H / 2, -0.009); panel.receiveShadow = true;
  wall.add(panel);
  // matte black steel frame: side channels, top cap, a back box behind the ply
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.1, BOARD_H + 0.08, 0.15), steel);
    r.position.set(sx * (BOARD_W / 2 + 0.05), BOARD_H / 2 + 0.04, -0.06);
    wall.add(r);
  }
  const topRail = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 0.2, 0.08, 0.15), steel);
  topRail.position.set(0, BOARD_H + 0.04, -0.06);
  wall.add(topRail);
  const back = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.1), steel);
  back.position.set(0, BOARD_H / 2, -0.07);
  wall.add(back);
  // kickboard holds live in the vertical kickboard plane (a group at the hinge, not tilted)
  const kickG = new THREE.Group();
  kickG.position.set(0, KICK_TOP, 0);
  scene.add(kickG);

  // ---------- holds: one InstancedMesh per (wall|kick) x type x variant ----------
  const shapes = {};
  for (const type of Object.keys(HOLD_SHAPE)) { shapes[type] = []; for (let v = 0; v < VARIANTS; v++) shapes[type].push(sculptHold(type, v)); }
  const holdMat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.78, metalness: 0, envMapIntensity: 0.3 });
  const byId = {};
  for (const h of holds) { byId[h.id] = h; h.variant = h.kick ? (h.id % 2) : (h.id * 7 + 3) % VARIANTS; }
  const _m4 = new THREE.Matrix4(), _qz = new THREE.Quaternion(), _sc = new V3(), _ps = new V3(), _z = new V3(0, 0, 1);
  const holdMatrix = (h, out) => { _qz.setFromAxisAngle(_z, h.rot); _sc.setScalar(h.size); _ps.set(h.x, h.y, 0.001); return out.compose(_ps, _qz, _sc); };
  const groups = {};
  for (const h of holds) { const key = (h.kick ? 'k:' : 'w:') + h.type + h.variant; (groups[key] ||= []).push(h); }
  const tone = new THREE.Color(HOLD_TONE), col = new THREE.Color();
  const instOf = {}; // hold id -> { mesh, i, base colour }
  for (const key in groups) {
    const list = groups[key], h0 = list[0];
    const mesh = new THREE.InstancedMesh(shapes[h0.type][h0.variant].geo, holdMat, list.length);
    const rnd = mulberry32(list.length * 31 + key.length);
    list.forEach((h, i) => {
      mesh.setMatrixAt(i, holdMatrix(h, _m4));
      mesh.setColorAt(i, col.copy(tone).multiplyScalar(0.94 + rnd() * 0.12));
      instOf[h.id] = { mesh, i, base: col.clone() };
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    (h0.kick ? kickG : wall).add(mesh);
  }

  // ---------- lit problem: LED glow hugging each hold's outline + soft spill on the wood ----------
  // filled shapes under the hold (never rings): the hold stays dark, the glow shows around its edge
  let ledGain = 1, haloK = 1;
  // LED colours are scaled to the same luminance so every colour blooms the same amount
  const ledColor = (hex, out) => { out.set(hex); const l = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b; return out.multiplyScalar(ledGain / Math.max(0.05, l)); };
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  let lit = [];
  const litById = {};
  function clearLit() {
    for (const L of lit) {
      L.parent.remove(L.halo, L.rim);
      L.halo.material.dispose(); L.rim.material.dispose();
      tintHold(L, 0);
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
      const parent = h.kick ? kickG : wall;
      const col = new THREE.Color(ROLE_HEX[e.role]);
      const rimMesh = new THREE.Mesh(shape.glow, new THREE.MeshBasicMaterial({ color: ledColor(ROLE_HEX[e.role], new THREE.Color()), vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
      rimMesh.position.set(h.x, h.y, 0.0006);
      rimMesh.rotation.z = h.rot;
      rimMesh.userData.base = h.size;
      rimMesh.scale.setScalar(0.001);
      rimMesh.renderOrder = 3;
      parent.add(rimMesh);
      const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ map: haloTex, color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      const hs = Math.max(shape.rx, shape.ry) * h.size * 2.2 + 0.04;
      halo.position.set(h.x, h.y, 0.0003);
      halo.scale.setScalar(0.001);
      halo.renderOrder = 2;
      parent.add(halo);
      const L = { id: e.id, role: e.role, parent, halo, rim: rimMesh, hs, led: col, tint: 0, on: !!instant, t0: instant ? -10 : Infinity, order: k };
      lit.push(L); litById[e.id] = L;
    });
  }
  // the LED under a lit hold also lights the hold itself, so a lit hold reads as a filled colour
  const _tc = new THREE.Color();
  function tintHold(L, k) {
    if (Math.abs((L.tint ?? 0) - k) < 0.02) return;
    L.tint = k;
    const I = instOf[L.id];
    _tc.copy(I.base).lerp(L.led, 0.6 * k).multiplyScalar(1 + 0.5 * k);
    I.mesh.setColorAt(I.i, _tc);
    I.mesh.instanceColor.needsUpdate = true;
  }
  function scheduleSweep(t0) { lit.forEach((L, k) => { L.on = false; L.t0 = t0 + k * 0.065; }); }
  function revealAll(t) { for (const L of lit) if (L.t0 > t) L.t0 = t - 0.3; }
  function updateLit(now, nextId, onFirstOn) {
    for (const L of lit) {
      const dt = now - L.t0;
      if (dt < 0) { L.halo.material.opacity = 0; L.rim.material.opacity = 0; tintHold(L, 0); continue; }
      if (!L.on) { L.on = true; if (onFirstOn) onFirstOn(L); }
      const e = Math.min(1, dt / 0.22);
      let sc = dt < 0.22 ? easeOutBack(e) : 1;
      const fade = Math.min(1, dt / 0.08);
      let op = 0.5 * fade * haloK;
      if (L.id === nextId) {
        const pz = 0.5 + 0.5 * Math.sin(now * 6.5);
        sc *= 1 + 0.1 * pz; op = (0.45 + 0.45 * pz) * haloK;
      }
      L.rim.scale.setScalar(L.rim.userData.base * sc);
      L.rim.material.opacity = fade;
      L.halo.scale.setScalar(L.hs * sc);
      L.halo.material.opacity = op;
      tintHold(L, fade * (L.id === nextId ? 0.8 + 0.2 * Math.sin(now * 6.5) : 0.8));
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
      const top = wall.localToWorld(new V3(s.sx * 1.25, 2.3, -0.12));
      const bot = new V3(s.sx * 1.25, 0.02, -1.3);
      const d = new V3().subVectors(top, bot), len = d.length();
      d.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d);
      const lo = Math.min(1.1, len * 0.6); // outer tube length; the inner tube slides out of it
      s.outer.scale.set(1, lo, 1); s.outer.quaternion.copy(q); s.outer.position.copy(bot).addScaledVector(d, lo / 2);
      const li = len - lo + 0.15;
      s.inner.scale.set(1, li, 1); s.inner.quaternion.copy(q); s.inner.position.copy(top).addScaledVector(d, -li / 2);
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
    scene.userData.tier = name; // the climber reads it for its outline width / fake shadow
    Q = { ...QUALITY[name], ...(test.quality || {}) };
    const dpr = Math.min(window.devicePixelRatio || 1, Q.dpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    key.castShadow = Q.shadow > 0;
    if (Q.shadow > 0) {
      key.shadow.mapSize.set(Q.shadow, Q.shadow);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    setLedGain(Q.bloom ? 1.25 : 0.8, Q.bloom ? 0.45 : 0.9);
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
