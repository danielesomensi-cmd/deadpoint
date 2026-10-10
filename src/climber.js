// DEADPOINT — the climber.
// Stylized character built from primitives + a "physics-lite" rig:
//   - shoulders (S) and pelvis (P) are point masses driven by springs and kept valid by
//     position-based constraints (torso length, arm reach, leg reach, wall),
//   - hands/feet are effectors that tween along arcs whenever their target jumps,
//   - limbs are solved with analytic two-bone IK, then secondary motion (ponytail,
//     chalk bag, dangling legs) is layered on top.
// All positions are in board-local coordinates (x right, y up the board, z out of the wall).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const smootherstep = (x) => { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };

export const BODY = { ARM1: 0.31, ARM2: 0.30, LEG1: 0.44, LEG2: 0.44, SHW: 0.17, HIPW: 0.095, TORSO: 0.5 };
const ARM_MAX = (BODY.ARM1 + BODY.ARM2) * 0.985;
const LEG_MAX = (BODY.LEG1 + BODY.LEG2) * 0.985;
const HEAD_R = 0.125;

// Palette: reads against the plywood (skin darker/redder than the wood, dark shorts) and stays clear
// of the LED hues (green start, cyan hand, magenta finish, yellow foot). Chalked hands are the
// brightest thing on the climber: they carry the deadpoint.
const COLORS = {
  skin: '#d9926a', skinDark: '#a8603f', chalk: '#fbf8f2', hair: '#3a2014', hairHi: '#5e3620', tie: '#ffd3e0',
  shirt: '#d8343c', shirtDark: '#a8222c', trim: '#fff6ee', pants: '#25272f', cuff: '#d8343c',
  shoe: '#1c1d22', rand: '#d8343c', sole: '#0f1013', strap: '#f4f1ea', bag: '#22304f', bagRim: '#f4f1ea',
  belt: '#15161a', outline: '#1a110c',
};

// ---------- geometry helpers ----------
function limbGeo(r0, r1, len, seg = 14) {
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) { const a = -Math.PI / 2 + (i / N) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.cos(a)), r0 * Math.sin(a))); }
  for (let i = 0; i <= N; i++) { const a = (i / N) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(a)), len + r1 * Math.sin(a))); }
  return new THREE.LatheGeometry(pts, seg);
}
function latheGeo(profile, depth, seg = 24) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), seg);
  g.scale(1, 1, depth);
  g.computeVertexNormals();
  return g;
}
const _m4 = new THREE.Matrix4();
const _yAxis = new V3(0, 1, 0);
function quatFromBasis(q, x, y, z) { _m4.makeBasis(x, y, z); return q.setFromRotationMatrix(_m4); }
function orthoNormal(out, v, axis) { // v projected orthogonal to unit axis, normalized
  out.copy(v).addScaledVector(axis, -v.dot(axis));
  const l = out.length();
  if (l < 1e-6) { out.set(axis.y, -axis.x, 0); if (out.lengthSq() < 1e-8) out.set(1, 0, 0); out.normalize(); }
  else out.divideScalar(l);
  return out;
}

// two-bone IK: places outMid/outEnd for a chain root→mid→end with bone lengths l1, l2
const _d = new V3(), _p = new V3();
function ik(root, target, l1, l2, pole, outMid, outEnd) {
  _d.subVectors(target, root);
  let dist = _d.length();
  if (dist < 1e-6) _d.set(0, -1, 0); else _d.divideScalar(dist);
  dist = clamp(dist, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.999);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1);
  _p.normalize();
  outMid.copy(root).addScaledVector(_d, a).addScaledVector(_p, h);
  outEnd.copy(root).addScaledVector(_d, dist);
}

// Toon shading (Jusant / A Short Hike look): 3 hard light bands + a highlight step. The ramp is
// sampled with NearestFilter so the bands stay crisp.
const RAMP = (() => {
  const v = [0.5, 0.72, 0.9, 1.0];
  const d = new Uint8Array(v.length * 4);
  v.forEach((x, i) => { d.set([x * 255, x * 255, x * 255, 255], i * 4); });
  const t = new THREE.DataTexture(d, v.length, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

// banded rim light (soft "toy" edge that separates the silhouette from the board)
function addRim(mat, strength, color = '#fff1e2') {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = { value: new THREE.Color(color) };
    sh.uniforms.rimStrength = { value: strength };
    sh.fragmentShader = 'uniform vec3 rimColor;\nuniform float rimStrength;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  float rimF = smoothstep(0.58, 0.72, 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0));\n  totalEmissiveRadiance += rimColor * rimF * rimStrength;');
  };
  mat.customProgramCacheKey = () => 'rimToon' + strength;
  return mat;
}

// Inverted-hull outline with a constant width in screen pixels (the old world-space hull was ~1 px
// at play distance), capped in world units so small parts never turn into ink blobs up close.
const OUTLINE_U = { resolution: { value: new THREE.Vector2(800, 800) }, color: { value: new THREE.Color(COLORS.outline) } };
function makeOutline(px, maxW) {
  return new THREE.ShaderMaterial({
    uniforms: { ...OUTLINE_U, px: { value: px }, maxW: { value: maxW } },
    vertexShader: `uniform vec2 resolution;
uniform float px;
uniform float maxW;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vec2 d = (projectionMatrix * vec4(n, 0.0)).xy * resolution;
  float l = length(d);
  if (l > 1e-5) {
    float w = min(px, maxW * projectionMatrix[1][1] / max(clip.w, 1e-3) * 0.5 * resolution.y);
    clip.xy += (d / l) * (2.0 * w / resolution) * clip.w;
  }
  gl_Position = clip;
}`,
    fragmentShader: 'uniform vec3 color;\nvoid main() { gl_FragColor = vec4(color, 1.0); }',
    side: THREE.BackSide,
  });
}
const outlineMat = makeOutline(2.2, 0.012);
const outlineHand = makeOutline(3.0, 0.016); // the hands carry the timing: thickest line
const _res = new THREE.Vector2();
const OUTLINE_PX = { high: [2.2, 3.0], mid: [2.0, 2.8], low: [1.5, 2.2] };

// ---------- continuous tube (limbs, ponytail) ----------
// One mesh per limb rebuilt on the CPU every frame along a centreline: no seams between bones.
// Rings are sampled from a radius profile [[t, r], ...]; closely spaced knots make hard steps
// (cuffs, hems). `mat(t)` picks the material group of each band. Ends get hemispherical caps.
function profileAt(K, t) {
  if (t <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++) {
    if (t <= K[i][0]) { const [t0, r0] = K[i - 1], [t1, r1] = K[i]; return r0 + (r1 - r0) * smoothstep((t - t0) / (t1 - t0 || 1)); }
  }
  return K[K.length - 1][1];
}
function tubeRings(K, n, len, mat = () => 0, capA = true, capB = true) {
  const ts = new Set();
  for (let i = 0; i <= n; i++) ts.add(+(i / n).toFixed(4));
  for (const [t] of K) if (t > 0 && t < 1) ts.add(t);
  const list = [...ts].sort((a, b) => a - b);
  const rings = [];
  const CAP = 4;
  const r0 = profileAt(K, 0), r1 = profileAt(K, 1);
  if (capA) for (let k = 0; k < CAP; k++) { const a = (k / CAP) * Math.PI / 2; rings.push({ t: 0, r: r0 * Math.sin(a), ext: -r0 * Math.cos(a) * 0.9, nr: Math.sin(a), nt: -Math.cos(a) }); }
  for (let i = 0; i < list.length; i++) {
    const t = list[i], r = profileAt(K, t);
    const ta = list[Math.max(0, i - 1)], tb = list[Math.min(list.length - 1, i + 1)];
    const slope = tb > ta ? (profileAt(K, tb) - profileAt(K, ta)) / ((tb - ta) * len) : 0;
    const l = Math.hypot(1, slope);
    rings.push({ t, r, ext: 0, nr: 1 / l, nt: -slope / l });
  }
  if (capB) for (let k = CAP - 1; k >= 0; k--) { const a = (k / CAP) * Math.PI / 2; rings.push({ t: 1, r: r1 * Math.sin(a), ext: r1 * Math.cos(a) * 0.9, nr: Math.sin(a), nt: Math.cos(a) }); }
  for (let i = 0; i < rings.length; i++) rings[i].m = mat(i < rings.length - 1 ? (rings[i].t + rings[i + 1].t) / 2 : rings[i].t);
  return rings;
}
const _ta = new V3(), _tb = new V3(), _tn = new V3(), _tB = new V3(), _tr = new V3();
class Tube {
  constructor(rings, K = 12) {
    this.rings = rings; this.K = K;
    const R = rings.length;
    this.pos = new Float32Array(R * K * 3); this.nrm = new Float32Array(R * K * 3);
    const g = this.geo = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    let start = 0, gm = rings[0].m;
    for (let i = 0; i < R - 1; i++) {
      if (rings[i].m !== gm) { g.addGroup(start, idx.length - start, gm); start = idx.length; gm = rings[i].m; }
      for (let j = 0; j < K; j++) { const a = i * K + j, b = i * K + ((j + 1) % K), c = a + K, d = b + K; idx.push(a, b, c, b, d, c); }
    }
    g.addGroup(start, idx.length - start, gm);
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new V3(), 1e4);
    this.cs = []; this.sn = [];
    for (let j = 0; j < K; j++) { this.cs.push(Math.cos((j / K) * Math.PI * 2)); this.sn.push(Math.sin((j / K) * Math.PI * 2)); }
  }
  // curve(t, out) gives the centreline; seed orients the first ring (then parallel transport)
  update(curve, seed) {
    const { rings, K, pos, nrm, cs, sn } = this;
    const N = _tn.copy(seed);
    for (let i = 0; i < rings.length; i++) {
      const rg = rings[i];
      const ta = Math.max(0, rg.t - 0.012), tb = Math.min(1, rg.t + 0.012);
      curve(tb, _ta); curve(ta, _tb);
      const T = _ta.sub(_tb);
      if (T.lengthSq() < 1e-12) T.set(0, 1, 0);
      T.normalize();
      curve(rg.t, _tr).addScaledVector(T, rg.ext);
      orthoNormal(N, N, T);
      const B = _tB.crossVectors(T, N);
      for (let j = 0; j < K; j++) {
        const o = (i * K + j) * 3;
        const rx = N.x * cs[j] + B.x * sn[j], ry = N.y * cs[j] + B.y * sn[j], rz = N.z * cs[j] + B.z * sn[j];
        pos[o] = _tr.x + rx * rg.r; pos[o + 1] = _tr.y + ry * rg.r; pos[o + 2] = _tr.z + rz * rg.r;
        nrm[o] = rx * rg.nr + T.x * rg.nt; nrm[o + 1] = ry * rg.nr + T.y * rg.nt; nrm[o + 2] = rz * rg.nr + T.z * rg.nt;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}
// bone chain a→m→b with the joint rounded off (soft elbow/knee instead of a hinge)
function jointCurve(a, m, b, t, out, w = 0.13) {
  if (t <= 0.5 - w) return out.lerpVectors(a, m, t * 2);
  if (t >= 0.5 + w) return out.lerpVectors(m, b, (t - 0.5) * 2);
  const A = _jA.lerpVectors(a, m, 1 - 2 * w), B = _jB.lerpVectors(m, b, 2 * w);
  const u = (t - (0.5 - w)) / (2 * w), k0 = (1 - u) * (1 - u), k1 = 2 * u * (1 - u), k2 = u * u;
  return out.set(A.x * k0 + m.x * k1 + B.x * k2, A.y * k0 + m.y * k1 + B.y * k2, A.z * k0 + m.z * k1 + B.z * k2);
}
const _jA = new V3(), _jB = new V3();
// uniform Catmull-Rom through pts (ponytail)
function chainCurve(pts, t, out) {
  const n = pts.length - 1;
  const f = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  const a = -0.5 * u3 + u2 - 0.5 * u, b = 1.5 * u3 - 2.5 * u2 + 1, c = -1.5 * u3 + 2 * u2 + 0.5 * u, d = 0.5 * u3 - 0.5 * u2;
  return out.set(p0.x * a + p1.x * b + p2.x * c + p3.x * d, p0.y * a + p1.y * b + p2.y * c + p3.y * d, p0.z * a + p1.z * b + p2.z * c + p3.z * d);
}

// ---------- painted textures ----------
// Racerback sports bra on the chest lathe: u = 0 is the middle of the back, v follows the lathe
// knots (yToV). Bare midriff under the band, bare shoulder blades, V neckline in front, white trim
// along every cut, navel on the belly.
function drawTank(yToV) {
  const W = 256, c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d');
  const img = g.createImageData(W, W), D = img.data;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const SH = hex(COLORS.shirt), SD = hex(COLORS.shirtDark), SK = hex(COLORS.skin), TR = hex(COLORS.trim), NV = hex(COLORS.skinDark);
  const vBand = yToV(0.135), vNavel = yToV(0.05);
  // top cut: v above which it is skin, as a function of the angular distance d from the back middle
  const cut = (d) => {
    if (d < 0.035) return 2; // racerback strap up to the neck
    if (d < 0.2) return yToV(0.205 + 0.13 * (1 - smoothstep((d - 0.035) / 0.12))); // shoulder blades bare
    if (d < 0.3) return yToV(0.205); // arm holes
    if (d < 0.35) return 2; // front straps
    return yToV(0.29 - 0.055 * smoothstep((d - 0.38) / 0.12)); // V neckline
  };
  const skin = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, d = Math.min(u, 1 - u), v = 1 - (y + 0.5) / W;
    skin[y * W + x] = v > cut(d) || v < vBand ? 1 : 0;
  }
  const R = 5; // trim width in texels
  for (let y = 0; y < W; y++) {
    const v = 1 - (y + 0.5) / W;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, d = Math.min(u, 1 - u);
      let col = SH;
      if (skin[y * W + x]) {
        col = SK;
        const nx = (u - 0.5) * W, ny = (v - vNavel) * W;
        if (nx * nx / 4 + ny * ny / 12 < 1) col = NV; // navel
      } else {
        let near = false;
        for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R; dx++) {
          const yy = y + dy;
          if (yy < 0 || yy >= W || dx * dx + dy * dy > R * R) continue;
          if (skin[yy * W + ((x + dx + W) % W)]) { near = true; break; }
        }
        if (near) col = TR;
        else if (d < 0.007) col = SD; // racerback seam
        else if (d > 0.493 && v < cut(0.5) - 0.02) col = SD; // centre seam between the cups
      }
      const o = (y * W + x) * 4;
      D[o] = col[0]; D[o + 1] = col[1]; D[o + 2] = col[2]; D[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// hair: strands converging on the tie (sphere cap UVs: u around, v from the crown)
function drawHair() {
  const W = 128, c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d');
  g.fillStyle = COLORS.hair; g.fillRect(0, 0, W, W);
  const rnd = (i) => (Math.sin(i * 91.7) * 43758.5) % 1;
  for (let i = 0; i < 26; i++) {
    const x = (i / 26) * W + Math.abs(rnd(i)) * 4;
    g.strokeStyle = i % 3 ? 'rgba(120,72,44,0.55)' : 'rgba(18,8,4,0.5)';
    g.lineWidth = 1.2 + Math.abs(rnd(i + 7)) * 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rnd(i + 3)) * 6, W); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function blobTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.9)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
// bake a transform into a geometry copy (for merging static sub-parts into one draw call)
function baked(geo, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const m = new THREE.Matrix4().compose(new V3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new V3(...s));
  return geo.clone().applyMatrix4(m);
}
const merge = (list) => mergeGeometries(list, false);

// ---------- face textures ----------
const FACE_W = 256;
function drawFace(expr) {
  const c = document.createElement('canvas');
  c.width = c.height = FACE_W;
  const g = c.getContext('2d');
  const ink = '#2b1a13';
  const ey = 120, ex = 47, cx = 128;
  const cheek = (x, a) => {
    const gr = g.createRadialGradient(x, 156, 0, x, 156, 28);
    gr.addColorStop(0, `rgba(255,120,110,${a})`); gr.addColorStop(1, 'rgba(255,120,110,0)');
    g.fillStyle = gr; g.fillRect(x - 32, 124, 64, 64);
  };
  const blush = expr === 'happy' ? 0.6 : expr === 'effort' ? 0.55 : 0.35;
  cheek(cx - 66, blush); cheek(cx + 66, blush);
  g.lineCap = 'round'; g.lineJoin = 'round';
  // lashes flick out on the outer corner (sg: -1 left eye, +1 right eye)
  const lashes = (x, y, sg, r) => {
    g.strokeStyle = ink; g.lineWidth = 3.6;
    for (const [a, l] of [[-0.35, 9], [-0.05, 11], [0.25, 9]]) {
      const ax = x + sg * r * Math.cos(a), ay = y - r * 0.9 * Math.sin(a + 0.55);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + sg * l * Math.cos(a - 0.5), ay - l * Math.sin(a + 0.45)); g.stroke();
    }
  };
  const eyeOpen = (x, ry = 23, look = 0) => {
    const sg = x < cx ? -1 : 1;
    g.fillStyle = ink; g.beginPath(); g.ellipse(x, ey, 16, ry, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6b3a22'; g.beginPath(); g.ellipse(x + look, ey + ry * 0.3, 10, ry * 0.45, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink; g.beginPath(); g.ellipse(x + look, ey + ry * 0.12, 6, ry * 0.42, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + 5 + look, ey - ry * 0.38, 5.8, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x - 4 + look, ey + ry * 0.32, 2.6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = ink; g.lineWidth = 6.5; g.beginPath(); g.ellipse(x, ey + 2, 17.5, ry + 1, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    lashes(x, ey + 2, sg, 17.5);
  };
  const lip = '#b8475a';
  const lips = (w = 13) => { // small closed smile, lipstick pink
    g.fillStyle = '#d9667a'; g.beginPath(); g.ellipse(cx, 163, w * 0.75, 5, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = lip; g.lineWidth = 4; g.beginPath(); g.arc(cx, 152, w, Math.PI * 0.25, Math.PI * 0.75); g.stroke();
  };
  const arc = (x, y, r, a0, a1, w = 6) => { g.strokeStyle = ink; g.lineWidth = w; g.beginPath(); g.arc(x, y, r, a0, a1); g.stroke(); };
  const line = (pts, w = 6) => { g.strokeStyle = ink; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
  const brows = (tilt, lift = 0) => {
    line([[cx - ex - 15, ey - 34 - lift + tilt], [cx - ex + 13, ey - 37 - lift - tilt]], 5.5);
    line([[cx + ex - 13, ey - 37 - lift - tilt], [cx + ex + 15, ey - 34 - lift + tilt]], 5.5);
  };
  switch (expr) {
    case 'calm':
      eyeOpen(cx - ex); eyeOpen(cx + ex); brows(0, 0);
      lips();
      break;
    case 'blink':
      arc(cx - ex, ey - 8, 16, Math.PI * 0.18, Math.PI * 0.82, 6.5); arc(cx + ex, ey - 8, 16, Math.PI * 0.18, Math.PI * 0.82, 6.5);
      lashes(cx - ex, ey + 18, -1, 12); lashes(cx + ex, ey + 18, 1, 12);
      brows(0, 0); lips();
      break;
    case 'focus':
      eyeOpen(cx - ex, 18, 1); eyeOpen(cx + ex, 18, 1); brows(-6, -2);
      g.fillStyle = '#d9667a'; g.beginPath(); g.ellipse(cx, 166, 9, 4.5, 0, 0, Math.PI * 2); g.fill();
      line([[cx - 9, 164], [cx + 9, 164]], 3.5);
      break;
    case 'effort':
      line([[cx - ex - 14, ey - 10], [cx - ex + 10, ey], [cx - ex - 14, ey + 10]], 6.5);
      line([[cx + ex + 14, ey - 10], [cx + ex - 10, ey], [cx + ex + 14, ey + 10]], 6.5);
      brows(-9, -4);
      g.fillStyle = '#5a1f1a'; g.beginPath(); g.roundRect(cx - 19, 152, 38, 20, 9); g.fill();
      g.fillStyle = '#ffffff'; g.fillRect(cx - 15, 160, 30, 4);
      break;
    case 'happy':
      arc(cx - ex, ey + 6, 15, Math.PI * 1.15, Math.PI * 1.85, 6.5); arc(cx + ex, ey + 6, 15, Math.PI * 1.15, Math.PI * 1.85, 6.5);
      lashes(cx - ex, ey + 4, -1, 14); lashes(cx + ex, ey + 4, 1, 14);
      brows(3, 6);
      g.fillStyle = '#5a1f1a'; g.beginPath(); g.moveTo(cx - 24, 150); g.quadraticCurveTo(cx, 194, cx + 24, 150); g.closePath(); g.fill();
      g.fillStyle = '#ff7f7a'; g.beginPath(); g.ellipse(cx, 172, 10, 6, 0, 0, Math.PI * 2); g.fill();
      break;
    case 'ouch':
      for (const x of [cx - ex, cx + ex]) { line([[x - 11, ey - 11], [x + 11, ey + 11]], 6); line([[x + 11, ey - 11], [x - 11, ey + 11]], 6); }
      brows(8, 4);
      line([[cx - 20, 166], [cx - 10, 160], [cx, 166], [cx + 10, 160], [cx + 20, 166]], 5);
      break;
    case 'rest':
      arc(cx - ex, ey - 4, 14, Math.PI * 0.15, Math.PI * 0.85, 5.5); arc(cx + ex, ey - 4, 14, Math.PI * 0.15, Math.PI * 0.85, 5.5);
      lashes(cx - ex, ey + 10, -1, 12); lashes(cx + ex, ey + 10, 1, 12);
      brows(2, -2);
      g.strokeStyle = lip; g.lineWidth = 5; g.beginPath(); g.ellipse(cx, 164, 7, 8, 0, 0, Math.PI * 2); g.stroke();
      break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------- effector (hand or foot) ----------
class Effector {
  constructor() {
    this.pos = new V3(); this.target = new V3(); this.from = new V3(); this.vel = new V3();
    this.liftDir = new V3(0, 0, 1);
    this.t0 = 0; this.dur = 0.2; this.dist = 0; this.tweening = false;
    this.delay = 0; this.speed = 1; this.lift = 0.07;
  }
  // tween toward target whenever it jumps; track exactly when `driven`
  drive(target, driven, now, onArrive) {
    if (driven) { this.pos.copy(target); this.target.copy(target); this.tweening = false; this.vel.set(0, 0, 0); return; }
    if (this.target.distanceTo(target) > 0.015) {
      this.from.copy(this.pos);
      this.target.copy(target);
      this.dist = this.from.distanceTo(this.target);
      this.dur = clamp(0.14 + 0.34 * this.dist, 0.16, 0.55) * this.speed;
      this.t0 = now + this.delay;
      this.delay = 0; this.speed = 1;
      this.tweening = this.dist > 0.004;
    } else if (!this.tweening) this.target.copy(target);
    if (this.tweening) {
      const k = (now - this.t0) / this.dur;
      if (k >= 1) { this.tweening = false; this.pos.copy(this.target); if (onArrive) onArrive(this); }
      else if (k > 0) {
        const e = smootherstep(k);
        this.pos.lerpVectors(this.from, this.target, e).addScaledVector(this.liftDir, this.lift * Math.sin(Math.PI * e) * Math.min(1, this.dist / 0.25));
      } else this.pos.copy(this.from);
    } else this.pos.copy(this.target);
  }
  // free spring (dangling feet, relaxed hands)
  spring(target, dt, k = 90, c = 10) {
    this.vel.addScaledVector(_tmpA.subVectors(target, this.pos), k * dt);
    this.vel.multiplyScalar(Math.exp(-c * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.target.copy(this.pos);
    this.tweening = false;
  }
}
const _tmpA = new V3(), _tmpB = new V3(), _tmpC = new V3(), _tmpD = new V3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

// =====================================================================
export class Climber {
  constructor(parent, opts = {}) {
    this.KICK_TOP = opts.kickTop ?? 0.78;
    this.MAT_TOP = opts.matTop ?? 0.32;
    this.root = new THREE.Group();
    this.root.visible = false;
    parent.add(this.root);
    // body state
    this.P = new V3(0, 1.0, 0.35); this.S = new V3(0, 1.5, 0.35);
    this.Pv = new V3(); this.Sv = new V3();
    this.g = new V3(0, -1, 0); this.wup = new V3(0, 1, 0); this.n = new V3(0, 0, 1);
    this.toWall = new V3(0, 0, -1); this.awayH = new V3(0, 0, 1);
    this.up = new V3(0, 1, 0); this.right = new V3(1, 0, 0); this.back = new V3(0, 0, 1);
    this.shAxis = new V3(1, 0, 0); this.hipAxis = new V3(1, 0, 0);
    this.E = { HL: new Effector(), HR: new Effector(), FL: new Effector(), FR: new Effector() };
    this.J = {};
    for (const k of ['shL', 'shR', 'elL', 'elR', 'hL', 'hR', 'hipL', 'hipR', 'knL', 'knR', 'ftL', 'ftR', 'W', 'neck', 'head']) this.J[k] = new V3();
    this.pole = { aL: new V3(-0.5, -0.6, 0.5), aR: new V3(0.5, -0.6, 0.5), lL: new V3(-0.6, 0.1, 0.75), lR: new V3(0.6, 0.1, 0.75) };
    this.headQ = new THREE.Quaternion();
    this.handQ = { L: new THREE.Quaternion(), R: new THREE.Quaternion() };
    this.footQ = { L: new THREE.Quaternion(), R: new THREE.Quaternion() };
    this.grip = { L: 1, R: 1 };
    this.mode = 'hidden';
    this.input = {
      HL: new V3(), HR: new V3(), FL: new V3(), FR: new V3(),
      drivenL: false, drivenR: false, feetOn: true, gripL: 1, gripR: 1,
      driveS: new V3(), driveP: new V3(), look: null, lookBack: false, stiff: 1,
      // timing cues read from the body: open hand (splay), white flash on hand/foot, weightless
      // ponytail at the deadpoint, feet pendulum when cut, grip snap rate
      splayL: 0, splayR: 0, flashL: 0, flashR: 0, flashF: 0, tailFloat: 0, feetSwing: 0, gripRate: 18,
      hipDrive: false, // keep the pelvis on its spring with the feet off (dyno rise)
    };
    this.pulse = { L: 0, R: 0, F: 0 }; // short white flashes fired by the game (catch), decaying
    this.stand = { mid: new V3(), action: 'idle', t0: 0, nextChalk: 3, cheerUntil: 0, look: null };
    this.fallSt = null;
    this.expr = 'calm'; this.shownExpr = ''; this.nextBlink = 2; this.blinkUntil = 0;
    this.enterUntil = 0;
    this.now = 0; this.acc = 0; this.angle = 30;
    this.onStep = null; this.onLand = null; this.onChalk = null;
    this.bagPos = new V3(); this.bagVel = new V3();
    this.tail = []; this.tailPrev = []; this.tieWorld = new V3();
    this.build();
  }

  // ------------------------------------------------------------ model
  build() {
    const M = (color, rim = 0.3) => addRim(new THREE.MeshToonMaterial({ color, gradientMap: RAMP }), rim);
    // chest lathe: narrow waist, ribcage, shoulders (radius, height above the waist joint)
    const CH = [[0.02, -0.04], [0.106, -0.035], [0.104, 0.0], [0.108, 0.06], [0.128, 0.13], [0.15, 0.2], [0.166, 0.26], [0.156, 0.31], [0.122, 0.343], [0.076, 0.363], [0.02, 0.371]];
    const CH_D = 0.66;
    const yToV = (y) => { // lathe v (one step per knot) at height y
      for (let k = 1; k < CH.length; k++) if (y <= CH[k][1]) return (k - 1 + clamp((y - CH[k - 1][1]) / (CH[k][1] - CH[k - 1][1]), 0, 1)) / (CH.length - 1);
      return 1;
    };
    const tank = addRim(new THREE.MeshToonMaterial({ map: drawTank(yToV), gradientMap: RAMP }), 0.3);
    const hairM = addRim(new THREE.MeshToonMaterial({ map: drawHair(), gradientMap: RAMP }), 0.3);
    const mat = this.mat = {
      skin: M(COLORS.skin, 0.32), hair: hairM, tie: M(COLORS.tie, 0.25), shirt: tank,
      pants: M(COLORS.pants, 0.2), cuff: M(COLORS.cuff, 0.3), shoe: M(COLORS.shoe, 0.34),
      rand: M(COLORS.rand, 0.3), sole: M(COLORS.sole, 0.1), strap: M(COLORS.strap, 0.2),
      bag: M(COLORS.bag, 0.34), bagRim: M(COLORS.bagRim, 0.2), belt: M(COLORS.belt, 0.2),
    };
    const parts = this.parts = {};
    const add = (name, geo, m, { outline = outlineMat, shadow = true, parent = this.root } = {}) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = shadow;
      parent.add(mesh);
      if (outline) { const o = new THREE.Mesh(geo, outline); o.castShadow = false; mesh.add(o); }
      parts[name] = mesh;
      return mesh;
    };
    const dyn = (mesh) => { mesh.frustumCulled = false; for (const c of mesh.children) c.frustumCulled = false; return mesh; };

    // torso: chest (racerback tank, shoulder blades and lats so the back reads) + pelvis (glutes)
    const chestGeo = latheGeo(CH, CH_D);
    // project the bra texture onto the bumps so the cut lines continue across them
    const projectUV = (b) => {
      const P = b.attributes.position, UV = b.attributes.uv;
      for (let i = 0; i < P.count; i++) {
        let u = Math.atan2(P.getX(i), P.getZ(i) / CH_D) / (Math.PI * 2); if (u < 0) u += 1;
        UV.setXY(i, u, clamp(yToV(P.getY(i)), 0, 1));
      }
      return b;
    };
    const blades = [-1, 1].map((s) => projectUV(baked(new THREE.SphereGeometry(0.052, 16, 12), { p: [s * 0.07, 0.238, 0.09], r: [0.15, 0, s * -0.25], s: [1, 1.3, 0.38] })));
    // bust (local -z is the front): teardrop cups, a gentle upper slope into the chest and a full
    // lower curve, toed out a little
    const cupGeo = new THREE.SphereGeometry(0.066, 20, 16);
    { const P = cupGeo.attributes.position;
      for (let i = 0; i < P.count; i++) { const y = P.getY(i) / 0.066; P.setZ(i, P.getZ(i) * (1 - 0.5 * Math.max(0, y) ** 1.5)); }
      cupGeo.computeVertexNormals(); }
    const bust = [-1, 1].map((s) => projectUV(baked(cupGeo, { p: [s * 0.054, 0.21, -0.062], r: [0.1, s * 0.32, 0], s: [1, 0.95, 0.88] })));
    add('chest', merge([chestGeo, ...blades, ...bust]), mat.shirt);
    // shorts: wide hips, round glutes, low waistband
    const pelvisGeo = latheGeo([[0.02, -0.125], [0.09, -0.115], [0.135, -0.07], [0.152, 0.0], [0.146, 0.07], [0.128, 0.14], [0.114, 0.185], [0.02, 0.19]], 0.76);
    const glutes = [-1, 1].map((s) => baked(new THREE.SphereGeometry(0.077, 18, 14), { p: [s * 0.06, -0.045, 0.056], s: [1, 1.05, 0.84] }));
    add('pelvis', merge([pelvisGeo, ...glutes]), mat.pants);
    const beltGeo = new THREE.TorusGeometry(0.117, 0.012, 6, 28); beltGeo.rotateX(Math.PI / 2); beltGeo.scale(1, 1, 0.78); beltGeo.translate(0, 0.172, 0);
    add('belt', beltGeo, mat.cuff, { parent: parts.pelvis, outline: false, shadow: false });
    add('neck', limbGeo(0.042, 0.039, 0.1), mat.skin);

    // head group: skull + ears (one mesh), face decal, hair cap + bangs (one mesh)
    const head = this.head = new THREE.Group();
    this.root.add(head);
    const skullGeo = new THREE.SphereGeometry(HEAD_R, 32, 22); skullGeo.scale(1, 1.04, 0.98);
    const earGeo = new THREE.SphereGeometry(0.03, 12, 10); earGeo.scale(0.6, 1, 0.8);
    add('skull', merge([skullGeo, ...[-1, 1].map((s) => baked(earGeo, { p: [s * HEAD_R * 0.98, -0.005, -0.005] }))]), mat.skin, { parent: head });
    const faceGeo = new THREE.SphereGeometry(HEAD_R * 1.006, 32, 18, Math.PI / 2 - 0.85, 1.7, Math.PI / 2 - 0.7, 1.45);
    faceGeo.scale(1, 1.04, 0.98);
    this.faceTex = {};
    for (const e of ['calm', 'blink', 'focus', 'effort', 'happy', 'ouch', 'rest']) this.faceTex[e] = drawFace(e);
    this.faceMat = new THREE.MeshStandardMaterial({ map: this.faceTex.calm, transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const face = new THREE.Mesh(faceGeo, this.faceMat);
    face.renderOrder = 2;
    head.add(face);
    const capGeo = new THREE.SphereGeometry(HEAD_R * 1.07, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.6);
    capGeo.rotateX(-0.72); capGeo.scale(1.02, 1.04, 1.0);
    const bangGeo = new THREE.SphereGeometry(0.05, 14, 10); bangGeo.scale(1.25, 0.62, 0.7);
    const bangs = [[-0.058, 0.062, 0.092, 0.4], [0.0, 0.072, 0.098, 0], [0.06, 0.06, 0.09, -0.4]].map(([x, y, z, rz]) => baked(bangGeo, { p: [x, y, z], r: [-0.35, 0, rz] }));
    // loose strands framing the face, in front of the ears
    const lockGeo = new THREE.SphereGeometry(0.05, 12, 10); lockGeo.scale(0.3, 1.45, 0.45);
    const locks = [-1, 1].map((s) => baked(lockGeo, { p: [s * 0.108, -0.03, 0.068], r: [0.2, 0, s * 0.14] }));
    add('hairCap', merge([capGeo, ...bangs, ...locks]), mat.hair, { parent: head });
    const tieGeo = new THREE.TorusGeometry(0.034, 0.016, 8, 18);
    this.tieAnchor = new V3(0, 0.07, -0.118);
    add('tie', tieGeo, mat.tie, { outline: false, shadow: false });
    // ponytail: verlet nodes, drawn as one smooth tube through them
    this.tailN = 7; this.tailSeg = 0.046;
    for (let i = 0; i < this.tailN; i++) { this.tail.push(new V3()); this.tailPrev.push(new V3()); }
    this.tailPts = [this.tieWorld, ...this.tail];
    this.tailTube = new Tube(tubeRings([[0, 0.048], [0.18, 0.06], [0.45, 0.054], [0.7, 0.04], [0.9, 0.022], [1, 0.012]], 20, 0.32, () => 0, false, true), 10);
    dyn(add('tail', this.tailTube.geo, mat.hair));

    // arms: one tapered tube shoulder → wrist (deltoid, bicep, elbow, climber forearm)
    this.armTube = {}; this.legTube = {};
    const ARM = [[0, 0.052], [0.1, 0.052], [0.3, 0.043], [0.5, 0.032], [0.63, 0.044], [0.85, 0.032], [1, 0.027]];
    // shorts hem high on the thigh (red trim), then bare leg: thigh, slim knee, calf, ankle
    const LEG = [[0, 0.09], [0.09, 0.086], [0.095, 0.088], [0.11, 0.088], [0.115, 0.079], [0.3, 0.069], [0.47, 0.045], [0.53, 0.045], [0.64, 0.051], [0.82, 0.037], [0.92, 0.031], [1, 0.032]];
    const legMat = (t) => (t < 0.092 ? 0 : t < 0.113 ? 1 : 2);
    const fingGeo = (len, r, offs) => merge([-0.026, -0.0087, 0.0087, 0.026].map((x, i) => baked(new THREE.CapsuleGeometry(r, len, 3, 8), { p: [x, len / 2 + offs[i], 0] })));
    const KNUCKLE = [-0.007, 0.002, 0, -0.01];
    for (const s of ['L', 'R']) {
      this.armTube[s] = new Tube(tubeRings(ARM, 18, BODY.ARM1 + BODY.ARM2), 12);
      dyn(add('arm' + s, this.armTube[s].geo, mat.skin));
      // hand (the timing actor): big, chalk white, thick outline, two finger rows that curl
      const hand = new THREE.Group(); this.root.add(hand); this['hand' + s] = hand;
      const chalk = mat['chalk' + s] = M(COLORS.chalk, 0.25); // per hand: it flashes on its own
      const palmGeo = new THREE.SphereGeometry(0.042, 16, 12); palmGeo.scale(1.08, 1.25, 0.6); palmGeo.translate(0, 0.045, 0);
      add('palm' + s, palmGeo, chalk, { parent: hand, outline: outlineHand });
      const th = add('thumb' + s, limbGeo(0.016, 0.014, 0.035, 10), chalk, { parent: hand, outline: outlineHand, shadow: false });
      th.position.set(s === 'L' ? -0.032 : 0.032, 0.02, 0.006); th.rotation.set(0.3, 0, s === 'L' ? 0.9 : -0.9);
      this['thumb' + s] = th;
      const fg = add('fing' + s, fingGeo(0.022, 0.0105, KNUCKLE), chalk, { parent: hand, outline: outlineHand, shadow: false });
      fg.position.set(0, 0.075, 0.0);
      this['fing' + s] = fg;
      const tip = add('tip' + s, fingGeo(0.016, 0.0098, KNUCKLE), chalk, { parent: fg, outline: outlineHand, shadow: false });
      tip.position.set(0, 0.026, 0);
      this['tip' + s] = tip;
    }
    // legs: one tube hip → ankle (pants, rolled cuff, bare ankle) + downturned climbing shoes
    const bend = (geo) => {
      const P = geo.attributes.position;
      for (let i = 0; i < P.count; i++) { const y = P.getY(i); if (y > 0.05) P.setZ(i, P.getZ(i) - 0.3 * (y - 0.05) ** 2 / 0.1); }
      geo.computeVertexNormals();
      return geo;
    };
    for (const s of ['L', 'R']) {
      this.legTube[s] = new Tube(tubeRings(LEG, 20, BODY.LEG1 + BODY.LEG2, legMat), 12);
      dyn(add('leg' + s, this.legTube[s].geo, [mat.pants, mat.cuff, mat.skin]));
      const shoe = new THREE.Group(); this.root.add(shoe); this['shoe' + s] = shoe;
      const bodyGeo = limbGeo(0.05, 0.04, 0.15, 14); bodyGeo.scale(0.84, 1, 0.8); bodyGeo.translate(0, -0.035, -0.035);
      add('shoeBody' + s, bend(bodyGeo), mat.shoe, { parent: shoe });
      const toeGeo = new THREE.SphereGeometry(0.042, 14, 10); toeGeo.scale(0.86, 1.2, 0.74); toeGeo.translate(0, 0.116, -0.042);
      add('toe' + s, bend(toeGeo), mat.rand, { parent: shoe });
      const heelGeo = new THREE.SphereGeometry(0.043, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55); heelGeo.scale(0.88, 0.9, 0.8); heelGeo.translate(0, -0.04, -0.045);
      add('heel' + s, heelGeo, mat.rand, { parent: shoe, outline: false, shadow: false });
      const soleGeo = limbGeo(0.047, 0.039, 0.155, 12); soleGeo.scale(0.86, 1, 0.3); soleGeo.translate(0, -0.035, -0.068);
      add('sole' + s, bend(soleGeo), mat.sole, { parent: shoe, outline: false });
      const strapGeo = new THREE.TorusGeometry(0.044, 0.008, 6, 16, Math.PI); strapGeo.rotateY(Math.PI / 2); strapGeo.rotateX(Math.PI / 2); strapGeo.scale(1, 1, 0.92);
      for (const y of [0.025, 0.06]) add('strap' + s + y, baked(strapGeo, { p: [0, y, -0.035] }), mat.strap, { parent: shoe, outline: false, shadow: false });
    }
    // chalk bag (navy, white rim: never a yellow blob that reads as a foot hold)
    const bagGeo = new THREE.CylinderGeometry(0.056, 0.05, 0.11, 18); bagGeo.translate(0, -0.03, 0);
    add('bag', bagGeo, mat.bag, { shadow: false });
    const rimGeo = new THREE.TorusGeometry(0.054, 0.013, 8, 20); rimGeo.rotateX(Math.PI / 2); rimGeo.translate(0, 0.027, 0);
    add('bagRim', rimGeo, mat.bagRim, { parent: parts.bag, outline: false, shadow: false });
    // fake contact shadow for the low tier (no shadow map there)
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex(), transparent: true, depthWrite: false, opacity: 0.35 }));
    this.blob.visible = false;
    this.blob.renderOrder = 1;
    this.root.add(this.blob);
    // centrelines (the joint vectors are persistent, so the closures are built once)
    const J = this.J;
    this.curves = {
      tail: (t, out) => chainCurve(this.tailPts, t, out),
      aL: (t, out) => jointCurve(J.shL, J.elL, J.hL, t, out), aR: (t, out) => jointCurve(J.shR, J.elR, J.hR, t, out),
      lL: (t, out) => jointCurve(J.hipL, J.knL, J.ftL, t, out, 0.11), lR: (t, out) => jointCurve(J.hipR, J.knR, J.ftR, t, out, 0.11),
    };
    // per-frame outline width from the drawing buffer size and the world's quality tier
    parts.chest.onBeforeRender = (renderer, scene) => {
      renderer.getDrawingBufferSize(_res);
      OUTLINE_U.resolution.value.copy(_res);
      const tier = (scene && scene.userData.tier) || 'mid';
      const [a, b] = OUTLINE_PX[tier] || OUTLINE_PX.mid;
      const pr = renderer.getPixelRatio();
      outlineMat.uniforms.px.value = a * pr; outlineHand.uniforms.px.value = b * pr;
      this.blobOn = tier === 'low';
    };
  }

  setExpr(e) { this.expr = e; }
  get entering() { return this.now < this.enterUntil; }

  // ------------------------------------------------------------ frame helpers
  frame(angleDeg) {
    this.angle = angleDeg;
    const th = (angleDeg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    this.g.set(0, -c, s);           // gravity (board-local)
    this.wup.set(0, c, -s);         // world up
    this.toWall.set(0, -s, -c);     // world horizontal toward the wall
    this.awayH.set(0, s, c);        // world horizontal away from the wall
  }
  worldY(v) { const th = (this.angle * Math.PI) / 180; return this.KICK_TOP + v.y * Math.cos(th) - v.z * Math.sin(th); }

  // ------------------------------------------------------------ mode control
  // instant climbing pose (title demo, debug)
  placeClimbing(inp) {
    this.mode = 'climb';
    this.root.visible = true;
    this.input.HL.copy(inp.HL); this.input.HR.copy(inp.HR); this.input.FL.copy(inp.FL); this.input.FR.copy(inp.FR);
    for (const k of ['HL', 'HR', 'FL', 'FR']) { const e = this.E[k]; e.pos.copy(inp[k]); e.target.copy(inp[k]); e.tweening = false; e.vel.set(0, 0, 0); }
    _tmpA.addVectors(inp.HL, inp.HR).multiplyScalar(0.5).addScaledVector(this.g, 0.3).addScaledVector(this.n, 0.1);
    this.S.copy(_tmpA);
    _tmpB.addVectors(inp.FL, inp.FR).multiplyScalar(0.5).sub(this.S).normalize().multiplyScalar(0.8).addScaledVector(this.g, 0.2).normalize();
    this.P.copy(this.S).addScaledVector(_tmpB, BODY.TORSO).addScaledVector(this.n, 0.08);
    this.Pv.set(0, 0, 0); this.Sv.set(0, 0, 0);
    this.fallSt = null;
    this.resetTail();
  }
  // instant standing pose on the mat (feet mid-point given in board-local coords)
  placeStanding(mid) {
    this.mode = 'stand';
    this.root.visible = true;
    this.stand.mid.copy(mid);
    this.stand.action = 'idle'; this.stand.nextChalk = this.now + 2 + Math.random() * 2;
    this.P.copy(mid).addScaledVector(this.wup, 0.85);
    this.S.copy(this.P).addScaledVector(this.wup, BODY.TORSO);
    this.Pv.set(0, 0, 0); this.Sv.set(0, 0, 0);
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? -1 : 1;
      const f = this.E['F' + s];
      f.pos.copy(mid).addScaledVector(this.right.set(1, 0, 0), sg * 0.12).addScaledVector(this.wup, 0.07);
      f.target.copy(f.pos); f.tweening = false; f.vel.set(0, 0, 0);
      const h = this.E['H' + s];
      h.pos.copy(this.S).addScaledVector(this.right, sg * 0.24).addScaledVector(this.wup, -0.55);
      h.target.copy(h.pos); h.vel.set(0, 0, 0); h.tweening = false;
    }
    this.fallSt = null;
    this.resetTail();
  }
  // from wherever we are, go to standing at `mid` (used after a drop landing)
  standFromHere(mid, cheer) {
    this.mode = 'stand';
    this.stand.mid.copy(mid);
    this.stand.action = cheer ? 'cheer' : 'idle';
    this.stand.t0 = this.now;
    this.stand.nextChalk = this.now + 3;
    for (const s of ['L', 'R']) {
      const f = this.E['F' + s];
      f.liftDir.copy(this.wup);
      f.target.copy(f.pos);
      f.tweening = false;
    }
    this.fallSt = null;
  }
  // pull on to the start holds (targets come from the next setClimb input)
  beginClimb() {
    this.mode = 'climb';
    this.root.visible = true;
    const d = { HL: 0, HR: 0.07, FL: 0.22, FR: 0.34 };
    for (const k in d) { this.E[k].delay = d[k]; this.E[k].speed = 1.15; this.E[k].liftDir.copy(this.n); this.E[k].lift = k[0] === 'H' ? 0.1 : 0.08; }
    this.enterUntil = this.now + 0.95;
    this.fallSt = null;
  }
  fall(kind, extraVel) {
    this.mode = 'fall';
    const up0 = _tmpA.subVectors(this.S, this.P).normalize();
    const F = this.fallSt = {
      kind, landed: false, landT: 0, t0: this.now,
      up: up0.clone(), right: this.shAxis.clone(),
      targetUp: new V3(),
    };
    if (kind === 'drop') F.targetUp.copy(this.wup);
    else F.targetUp.copy(this.wup).multiplyScalar(0.75).addScaledVector(this.awayH, 0.66).normalize();
    this.Pv.multiplyScalar(0.4).addScaledVector(this.n, kind === 'drop' ? 0.35 : 0.8);
    if (extraVel) this.Pv.add(extraVel);
    for (const s of ['L', 'R']) this.E['H' + s].vel.set(0, 0, 0);
  }
  kick(v, sFactor = 0.5) { this.Pv.add(v); this.Sv.addScaledVector(v, sFactor); }
  hide() { this.mode = 'hidden'; this.root.visible = false; }
  // re-express the whole state after the parent (board) frame changed, e.g. while the board
  // tilts under a climber standing on the mat: M maps old board-local coords to new ones.
  applyMatrix(M) {
    const q = _q2.setFromRotationMatrix(M);
    const pts = [this.P, this.S, this.bagPos, this.stand.mid, ...Object.values(this.J), ...this.tail, ...this.tailPrev];
    if (this.tieWorld) pts.push(this.tieWorld);
    for (const e of Object.values(this.E)) pts.push(e.pos, e.target, e.from);
    for (const p of pts) p.applyMatrix4(M);
    for (const v of [this.Pv, this.Sv, this.bagVel, this.shAxis, this.hipAxis, this.up, this.right, this.back, ...Object.values(this.pole)]) v.applyQuaternion(q);
    for (const e of Object.values(this.E)) { e.vel.applyQuaternion(q); e.liftDir.applyQuaternion(q); }
    for (const qq of [this.headQ, this.handQ.L, this.handQ.R, this.footQ.L, this.footQ.R]) qq.premultiply(q);
    if (this.stand.look) this.stand.look.applyMatrix4(M);
  }

  resetTail() {
    this.updateHeadFrame(true);
    const a = _tmpA.copy(this.tieAnchor).applyQuaternion(this.headQ).add(this.J.head);
    for (let i = 0; i < this.tailN; i++) {
      this.tail[i].copy(a).addScaledVector(this.g, this.tailSeg * (i + 1)).addScaledVector(this.back, 0.02 * (i + 1));
      this.tailPrev[i].copy(this.tail[i]);
    }
    this.bagPos.copy(this.P).addScaledVector(this.back, 0.14); this.bagVel.set(0, 0, 0);
  }

  // ------------------------------------------------------------ main update
  update(dt, now, angleDeg) {
    this.now = now;
    if (this.mode === 'hidden') { this.root.visible = false; return; }
    this.root.visible = true;
    this.frame(angleDeg);
    dt = clamp(dt, 0, 0.1);
    if (this.mode === 'climb') this.driveEffectorsClimb(now, dt);
    else if (this.mode === 'stand') this.driveEffectorsStand(now, dt);
    const h = 1 / 120;
    this.acc += dt;
    let k = 0;
    while (this.acc >= h && k < 14) { this.step(h); this.acc -= h; k++; }
    if (k >= 14) this.acc = 0;
    this.solvePose(dt);
    this.updateSecondary(dt);
    this.updateFace(now);
    this.updateFlash(dt);
    this.render();
  }
  // white emissive flash on a hand (or the shoes): game pulses + the deadpoint cue from input
  flash(which, v = 1) { this.pulse[which] = Math.max(this.pulse[which], v); }
  updateFlash(dt) {
    const I = this.input, climb = this.mode === 'climb';
    for (const k of ['L', 'R', 'F']) {
      this.pulse[k] *= Math.exp(-dt / 0.12);
      const v = Math.max(this.pulse[k], climb ? I['flash' + k] : 0);
      const m = k === 'F' ? this.mat.rand : this.mat['chalk' + k];
      const e = v < 0.01 ? 0 : v * 1.6;
      if (Math.abs(m.emissive.r - e) > 0.005) m.emissive.setScalar(e);
    }
  }

  driveEffectorsClimb(now, dt) {
    const I = this.input;
    const step = (e) => { if (this.onStep) this.onStep(e); };
    this.E.HL.drive(I.HL, I.drivenL, now);
    this.E.HR.drive(I.HR, I.drivenR, now);
    if (I.feetOn) {
      this.E.FL.drive(I.FL, false, now, step);
      this.E.FR.drive(I.FR, false, now, step);
    } else {
      for (const s of ['L', 'R']) {
        const hip = s === 'L' ? this.J.hipL : this.J.hipR;
        _tmpB.copy(hip).addScaledVector(this.g, 0.72).addScaledVector(this.n, -0.05).addScaledVector(this.shAxis, s === 'L' ? -0.05 : 0.05);
        if (I.feetSwing) _tmpB.addScaledVector(this.n, I.feetSwing);
        this.E['F' + s].spring(_tmpB, dt, 70, 7.5);
      }
    }
    const gr = I.gripRate || 18;
    this.grip.L += (I.gripL - this.grip.L) * (1 - Math.exp(-dt * gr));
    this.grip.R += (I.gripR - this.grip.R) * (1 - Math.exp(-dt * gr));
  }

  driveEffectorsStand(now, dt) {
    const st = this.stand;
    const r = _tmpC.set(1, 0, 0);
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? -1 : 1;
      _tmpB.copy(st.mid).addScaledVector(r, sg * 0.12).addScaledVector(this.wup, 0.07);
      const f = this.E['F' + s];
      f.liftDir.copy(this.wup);
      f.drive(_tmpB, false, now, (e) => this.onStep && this.onStep(e));
    }
    if (st.action === 'idle' && now > st.nextChalk) { st.action = 'chalk'; st.t0 = now; }
    if (st.action === 'chalk' && now - st.t0 > 1.4) { st.action = 'idle'; st.nextChalk = now + 3.5 + Math.random() * 3; }
    if (st.action === 'cheer' && now - st.t0 > 1.8) { st.action = 'idle'; st.nextChalk = now + 2.5; }
    const tt = now - st.t0;
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? -1 : 1;
      const T = _tmpB;
      if (st.action === 'chalk') {
        T.copy(this.S).addScaledVector(this.wup, -0.22).addScaledVector(this.toWall, 0.17).addScaledVector(r, sg * 0.035);
        T.addScaledVector(this.wup, Math.sin(tt * 14 + (sg > 0 ? 0 : 1.6)) * 0.03).addScaledVector(r, Math.cos(tt * 14) * 0.02);
        if (s === 'R' && tt > 0.5 && !st.puffed) { st.puffed = true; if (this.onChalk) this.onChalk(T.clone()); }
      } else if (st.action === 'cheer' && s === 'R' && tt < 1.6) {
        const pump = Math.sin(Math.min(1, tt / 0.3) * Math.PI / 2) - 0.1 * Math.max(0, Math.sin((tt - 0.3) * 9));
        T.copy(this.S).addScaledVector(r, 0.2).addScaledVector(this.wup, -0.45 + 1.05 * pump).addScaledVector(this.awayH, 0.05);
      } else {
        T.copy(this.S).addScaledVector(r, sg * (BODY.SHW + 0.075)).addScaledVector(this.wup, -0.56).addScaledVector(this.awayH, 0.03);
        T.addScaledVector(this.wup, Math.sin(this.now * 1.6 + sg) * 0.008);
      }
      this.E['H' + s].spring(T, dt, 120, 14);
    }
    if (st.action !== 'chalk') st.puffed = false;
    this.grip.L += (0 - this.grip.L) * (1 - Math.exp(-dt * 10));
    this.grip.R += (0 - this.grip.R) * (1 - Math.exp(-dt * 10));
  }

  // one physics substep
  step(h) {
    if (this.mode === 'fall') { this.stepFall(h); return; }
    const I = this.input, E = this.E, S = this.S, P = this.P;
    const St = _tmpA, Pt = _tmpB;
    let feetOn, kS = 380, kP = 220, cPf = 0.78, hipSpring;
    if (this.mode === 'climb') {
      feetOn = I.feetOn;
      hipSpring = feetOn || I.hipDrive;
      St.addVectors(E.HL.pos, E.HR.pos).multiplyScalar(0.5).addScaledVector(this.g, 0.3).addScaledVector(this.n, 0.1).add(I.driveS);
      if (hipSpring) {
        Pt.addVectors(E.FL.pos, E.FR.pos).multiplyScalar(0.5).sub(St).normalize().multiplyScalar(0.8).addScaledVector(this.g, 0.2).normalize();
        const th = (this.angle * Math.PI) / 180;
        Pt.multiplyScalar(BODY.TORSO).add(St).addScaledVector(this.n, 0.03 + 0.1 * Math.sin(th)).add(I.driveP);
      }
      kS *= I.stiff; kP *= I.stiff;
    } else { // stand
      feetOn = true;
      const st = this.stand;
      const squat = st.action === 'chalk' ? 0.02 : 0;
      Pt.copy(st.mid).addScaledVector(this.wup, 0.85 - squat);
      St.copy(Pt).addScaledVector(this.wup, BODY.TORSO).addScaledVector(this.toWall, 0.02);
      if (st.action === 'cheer') St.addScaledVector(this.awayH, 0.03);
      kP = 160; cPf = 0.55;
      hipSpring = true;
    }
    const cS = 2 * Math.sqrt(kS);
    this.Sv.addScaledVector(_tmpC.subVectors(St, S), kS * h).addScaledVector(this.Sv, -cS * h);
    if (hipSpring) {
      const cP = 2 * Math.sqrt(kP) * cPf;
      this.Pv.addScaledVector(_tmpC.subVectors(Pt, P), kP * h).addScaledVector(this.Pv, -cP * h);
    } else {
      this.Pv.addScaledVector(this.g, 9.81 * 0.9 * h).multiplyScalar(Math.exp(-1.3 * h));
    }
    const Sp = _tmpC.copy(S).addScaledVector(this.Sv, h);
    const Pp = _tmpD.copy(P).addScaledVector(this.Pv, h);
    const climbing = this.mode === 'climb';
    for (let it = 0; it < 4; it++) {
      // torso length
      _d.subVectors(Sp, Pp);
      const L = _d.length() || 1e-6;
      const corr = (L - BODY.TORSO) / L;
      const wS = feetOn ? 0.35 : 0.12;
      Sp.addScaledVector(_d, -corr * wS);
      Pp.addScaledVector(_d, corr * (1 - wS));
      // legs (feet on holds / floor)
      if (feetOn) {
        for (const s of [-1, 1]) {
          const F = s < 0 ? E.FL.pos : E.FR.pos;
          _p.copy(Pp).addScaledVector(this.hipAxis, s * BODY.HIPW);
          const dd = _p.distanceTo(F);
          if (dd > LEG_MAX) Pp.addScaledVector(_p.subVectors(F, _p), ((dd - LEG_MAX) / dd) * 0.7);
        }
      }
      // wall
      if (climbing) { if (Pp.z < 0.11) Pp.z = 0.11; if (Sp.z < 0.14) Sp.z = 0.14; }
      // arms last: hands are fixed on holds
      if (climbing) {
        for (const s of [-1, 1]) {
          const H = s < 0 ? E.HL.pos : E.HR.pos;
          _p.copy(Sp).addScaledVector(this.shAxis, s * BODY.SHW);
          const dd = _p.distanceTo(H);
          if (dd > ARM_MAX) Sp.addScaledVector(_p.subVectors(H, _p), (dd - ARM_MAX) / dd);
        }
      }
    }
    this.Sv.subVectors(Sp, S).divideScalar(h);
    this.Pv.subVectors(Pp, P).divideScalar(h);
    S.copy(Sp); P.copy(Pp);
  }

  stepFall(h) {
    const F = this.fallSt, P = this.P;
    if (!F.landed) {
      this.Pv.addScaledVector(this.g, 9.81 * h);
      P.addScaledVector(this.Pv, h);
      const rate = (F.kind === 'drop' ? 5 : 3.2) * h;
      F.up.lerp(F.targetUp, clamp(rate, 0, 1)).normalize();
      const landY = this.MAT_TOP + (F.kind === 'drop' ? 0.78 : 0.13);
      if (this.worldY(P) <= landY) {
        // project back onto the landing height
        const d = landY - this.worldY(P);
        P.addScaledVector(this.wup, d);
        F.landed = true; F.landT = this.now;
        const vImpact = this.Pv.length();
        if (this.onLand) this.onLand(F.kind, vImpact, P.clone());
        if (F.kind === 'drop') {
          const mid = _tmpA.copy(P).addScaledVector(this.wup, -0.78);
          this.Pv.multiplyScalar(0.25);
          this.Sv.copy(this.Pv);
          this.S.copy(P).addScaledVector(F.up, BODY.TORSO);
          this.standFromHere(mid, true);
          return;
        }
        this.Pv.set(0, 0, 0);
        F.lyUp = this.awayH.clone();
      }
    } else if (F.lyUp) {
      const k = clamp((this.now - F.landT) / 0.35, 0, 1);
      F.up.lerp(F.lyUp, clamp(8 * h * (0.3 + k), 0, 1)).normalize();
      // keep the pelvis on the mat while rolling back
      const d = this.MAT_TOP + 0.13 - this.worldY(P);
      if (d > 0) P.addScaledVector(this.wup, d);
    }
    this.S.copy(P).addScaledVector(F.up, BODY.TORSO);
    this.Sv.copy(this.Pv);
  }

  // ------------------------------------------------------------ pose (orientation + IK)
  solvePose(dt) {
    const S = this.S, P = this.P, J = this.J, I = this.input, E = this.E;
    const up = this.up.subVectors(S, P);
    if (up.lengthSq() < 1e-8) up.copy(this.wup);
    up.normalize();
    // shoulder axis: follows the hand-to-hand line, smoothed
    if (this.mode === 'climb') {
      _tmpA.subVectors(E.HR.pos, E.HL.pos); _tmpA.z = 0;
      if (_tmpA.lengthSq() < 1e-6) _tmpA.set(1, 0, 0);
      _tmpA.normalize();
      if (_tmpA.x < 0.35) { _tmpA.x = 0.35; _tmpA.normalize(); }
      _tmpA.lerp(_tmpB.set(1, 0, 0), 0.35);
    } else if (this.mode === 'fall' && this.fallSt) _tmpA.copy(this.fallSt.right);
    else _tmpA.set(1, 0, 0);
    orthoNormal(_tmpA, _tmpA, up);
    this.shAxis.lerp(_tmpA, 1 - Math.exp(-dt * 14));
    orthoNormal(this.shAxis, this.shAxis, up);
    const right = this.right.copy(this.shAxis);
    const back = this.back.crossVectors(right, up).normalize();
    // hip axis: between shoulder axis and the feet line
    _tmpB.subVectors(E.FR.pos, E.FL.pos);
    orthoNormal(_tmpB, _tmpB, up);
    if (_tmpB.dot(right) < 0) _tmpB.negate();
    _tmpB.lerp(right, 0.5);
    orthoNormal(_tmpB, _tmpB, up);
    this.hipAxis.lerp(_tmpB, 1 - Math.exp(-dt * 10));
    orthoNormal(this.hipAxis, this.hipAxis, up);

    J.shL.copy(S).addScaledVector(right, -BODY.SHW);
    J.shR.copy(S).addScaledVector(right, BODY.SHW);
    J.hipL.copy(P).addScaledVector(this.hipAxis, -BODY.HIPW);
    J.hipR.copy(P).addScaledVector(this.hipAxis, BODY.HIPW);
    J.W.copy(P).addScaledVector(up, 0.17).addScaledVector(back, 0.012);
    J.neck.copy(S).addScaledVector(up, 0.02);

    // hand & foot targets for this frame
    const HLt = _tmpC.copy(E.HL.pos), HRt = _tmpD.copy(E.HR.pos);
    let FLt = E.FL.pos, FRt = E.FR.pos;
    if (this.mode === 'fall') {
      const F = this.fallSt;
      const t = this.now - F.t0;
      const lying = F.landed && F.kind === 'fall';
      for (const s of [-1, 1]) {
        const sh = s < 0 ? J.shL : J.shR;
        const T = s < 0 ? HLt : HRt;
        if (lying) T.copy(sh).addScaledVector(right, s * 0.42).addScaledVector(up, 0.08).addScaledVector(back, 0.05);
        else if (F.kind === 'drop') T.copy(sh).addScaledVector(up, 0.3).addScaledVector(right, s * 0.18).addScaledVector(back, -0.12);
        else T.copy(sh).addScaledVector(up, 0.4 + 0.06 * Math.sin(t * 17 + s)).addScaledVector(right, s * (0.28 + 0.05 * Math.sin(t * 13))).addScaledVector(back, -0.08);
        const e = s < 0 ? E.HL : E.HR;
        e.spring(T, dt, 140, 13);
        T.copy(e.pos);
      }
      for (const s of [-1, 1]) {
        const hip = s < 0 ? J.hipL : J.hipR;
        const e = s < 0 ? E.FL : E.FR;
        if (lying) _tmpA.copy(hip).addScaledVector(up, -0.62).addScaledVector(right, s * 0.12).addScaledVector(back, 0.08);
        else if (F.kind === 'drop') _tmpA.copy(hip).addScaledVector(up, -0.8).addScaledVector(back, -0.05).addScaledVector(right, s * 0.03);
        else _tmpA.copy(hip).addScaledVector(up, -0.6).addScaledVector(back, -0.25).addScaledVector(right, s * 0.1).addScaledVector(up, 0.05 * Math.sin(t * 15 + s));
        e.spring(_tmpA, dt, 150, 14);
      }
      FLt = E.FL.pos; FRt = E.FR.pos;
    }

    // IK poles (smoothed so elbows/knees never flip)
    const k = 1 - Math.exp(-dt * 12);
    const feetOff = this.mode === 'climb' && !I.feetOn;
    for (const s of [-1, 1]) {
      const a = s < 0 ? this.pole.aL : this.pole.aR;
      _tmpA.copy(right).multiplyScalar(s * 0.55).addScaledVector(up, -0.6).addScaledVector(back, 0.5);
      if (this.mode === 'stand') _tmpA.copy(right).multiplyScalar(s * 0.3).addScaledVector(back, 0.8).addScaledVector(up, -0.2);
      a.lerp(_tmpA, k);
      // knees flex forward (toward the wall the climber faces, -back) and turn out with the hips.
      // On holds they open sideways a lot (climbers turn the hips out to keep the knee off the wall).
      const l = s < 0 ? this.pole.lL : this.pole.lR;
      if (this.mode === 'stand') _tmpA.copy(back).multiplyScalar(-0.9).addScaledVector(right, s * 0.25);
      else if (feetOff || (this.mode === 'fall')) _tmpA.copy(back).multiplyScalar(-0.85).addScaledVector(right, s * 0.3);
      else _tmpA.copy(right).multiplyScalar(s * 0.7).addScaledVector(back, -0.6).addScaledVector(up, 0.2);
      l.lerp(_tmpA, k);
    }
    ik(J.shL, HLt, BODY.ARM1, BODY.ARM2, this.pole.aL, J.elL, J.hL);
    ik(J.shR, HRt, BODY.ARM1, BODY.ARM2, this.pole.aR, J.elR, J.hR);
    for (const s of [-1, 1]) {
      const hip = s < 0 ? J.hipL : J.hipR, kn = s < 0 ? J.knL : J.knR, ft = s < 0 ? J.ftL : J.ftR;
      const F = s < 0 ? FLt : FRt, pole = s < 0 ? this.pole.lL : this.pole.lR;
      ik(hip, F, BODY.LEG1, BODY.LEG2, pole, kn, ft);
      // a knee that would go into the board swings out to the side (frog), continuously
      if (this.mode === 'climb' && kn.z < 0.13) {
        const w = smoothstep((0.13 - kn.z) / 0.1);
        _tmpA.copy(right).multiplyScalar(s).addScaledVector(back, 0.25).normalize();
        _tmpB.copy(pole).normalize().lerp(_tmpA, w);
        ik(hip, F, BODY.LEG1, BODY.LEG2, _tmpB, kn, ft);
      }
    }

    // head: look target, smoothed
    this.updateHeadFrame(false, dt);

    // hands: fingers along the forearm when open, up the wall when gripping
    for (const s of ['L', 'R']) {
      const hd = J['h' + s], el = J['el' + s];
      const g = this.grip[s];
      const fingers = _tmpA.subVectors(hd, el).normalize();
      if (this.mode === 'climb') fingers.lerp(_tmpB.set(0, 1, -0.35).normalize(), g).normalize();
      const palm = _tmpB.copy(this.mode === 'climb' ? this.toWallLocal() : back).multiplyScalar(this.mode === 'climb' ? 1 : -1);
      if (this.mode === 'stand') palm.copy(right).multiplyScalar(s === 'L' ? 1 : -1);
      orthoNormal(palm, palm, fingers);
      const x = _tmpC.crossVectors(fingers, palm);
      quatFromBasis(this.handQ[s], x, fingers, palm);
      // open hand reaching for the hold: fingers bend back, thumb spreads out
      const sp = this.mode === 'climb' ? I['splay' + s] * (1 - g) : 0;
      this['fing' + s].rotation.x = 0.25 + 0.9 * g - 0.55 * sp;
      this['thumb' + s].rotation.z = (s === 'L' ? 1 : -1) * (0.9 + 0.6 * sp);
    }
    // shoes: toe into the wall when on a hold, pointing down when dangling
    for (const s of ['L', 'R']) {
      const an = J['ft' + s], kn = J['kn' + s];
      const shin = _tmpA.subVectors(kn, an).normalize();
      const toe = _tmpB;
      if (this.mode === 'climb' && I.feetOn) toe.set(0, 0.32, -1).normalize();
      else if (this.mode === 'stand' || (this.mode === 'fall' && this.fallSt && this.fallSt.kind === 'drop')) toe.copy(this.toWall);
      else toe.copy(back).multiplyScalar(-0.6).addScaledVector(shin, -0.8).normalize();
      orthoNormal(toe, toe, shin);
      const x = _tmpC.crossVectors(toe, shin);
      quatFromBasis(this.footQ[s], x, toe, shin);
    }
  }
  toWallLocal() { return _tmpD.set(0, 0, -1); }

  updateHeadFrame(snap, dt = 0.016) {
    const J = this.J, I = this.input;
    const up = this.up, back = this.back;
    J.head.copy(J.neck).addScaledVector(up, 0.205).addScaledVector(back, -0.02);
    const fwd = _tmpA;
    let look = null;
    if (this.mode === 'climb') look = I.lookBack ? I.look : I.look;
    else if (this.mode === 'stand') look = this.stand.look;
    if (look) fwd.subVectors(look, J.head).normalize(); else fwd.copy(back).negate();
    const lookBack = this.mode === 'climb' ? I.lookBack : this.mode === 'stand' && this.stand.lookBack;
    if (lookBack) {
      // look over the shoulder (3/4 view), not an owl-like 180° turn
      const side = fwd.dot(this.right) >= 0 ? 1 : -1;
      fwd.addScaledVector(this.right, side * 0.9).addScaledVector(back, -0.35).normalize();
    } else {
      // keep the face roughly toward the chest front (−back)
      const f0 = _tmpB.copy(back).negate();
      const dot = fwd.dot(f0);
      if (dot < 0.3) { fwd.lerp(f0, clamp((0.3 - dot) / 1.3, 0, 1)).normalize(); }
    }
    if (this.mode === 'fall' && this.fallSt) fwd.copy(back).negate().addScaledVector(up, this.fallSt.landed ? 0 : 0.3).normalize();
    const hu = orthoNormal(_tmpC, up, fwd);
    const hx = _tmpD.crossVectors(hu, fwd);
    quatFromBasis(_q, hx, hu, fwd);
    if (snap) this.headQ.copy(_q);
    else this.headQ.slerp(_q, 1 - Math.exp(-dt * 9));
  }

  updateSecondary(dt) {
    // ponytail: verlet chain hanging from the hair tie
    const anchor = _tmpA.copy(this.tieAnchor).applyQuaternion(this.headQ).add(this.J.head);
    this.tieWorld.copy(anchor);
    const sub = dt > 0.02 ? 2 : 1, h = dt / sub;
    const headC = this.J.head;
    // weightless at the deadpoint: gravity fades out and the hair drifts up (reads from behind)
    const fl = this.mode === 'climb' ? clamp(this.input.tailFloat, 0, 1) : 0;
    const gk = 9.81 * h * h * (0.9 - 2.6 * fl);
    for (let ss = 0; ss < sub; ss++) {
      for (let i = 0; i < this.tailN; i++) {
        const p = this.tail[i], pr = this.tailPrev[i];
        _tmpB.subVectors(p, pr).multiplyScalar(0.96);
        pr.copy(p);
        p.add(_tmpB).addScaledVector(this.g, gk);
        // gentle bias out of the back of the head so the tail does not hang through the neck
        p.addScaledVector(this.back, 0.12 * h * h * 60);
      }
      for (let it = 0; it < 3; it++) {
        let prev = anchor;
        for (let i = 0; i < this.tailN; i++) {
          const p = this.tail[i];
          _tmpB.subVectors(p, prev);
          const L = _tmpB.length() || 1e-6;
          if (i === 0) p.copy(prev).addScaledVector(_tmpB, this.tailSeg / L);
          else { const c = (L - this.tailSeg) / L; prev.addScaledVector(_tmpB, c * 0.5); p.addScaledVector(_tmpB, -c * 0.5); }
          // collide with skull and upper back
          _tmpC.subVectors(p, headC);
          const dh = _tmpC.length();
          if (dh < HEAD_R + 0.035) p.copy(headC).addScaledVector(_tmpC, (HEAD_R + 0.035) / (dh || 1));
          _tmpC.subVectors(p, this.S);
          const along = _tmpC.dot(this.back);
          if (along < 0.09 && _tmpC.dot(this.up) < 0.12) p.addScaledVector(this.back, 0.09 - along);
          prev = p;
        }
      }
    }
    // chalk bag: lags behind the pelvis
    _tmpB.copy(this.P).addScaledVector(this.back, 0.15).addScaledVector(this.up, -0.03);
    this.bagVel.addScaledVector(_tmpC.subVectors(_tmpB, this.bagPos), 140 * dt).multiplyScalar(Math.exp(-9 * dt));
    this.bagPos.addScaledVector(this.bagVel, dt);
    if (this.bagPos.distanceTo(_tmpB) > 0.08) this.bagPos.copy(_tmpB).addScaledVector(_tmpC.subVectors(this.bagPos, _tmpB).normalize(), 0.08);
  }

  updateFace(now) {
    let e = this.expr;
    if ((e === 'calm' || e === 'focus') && now > this.nextBlink) { this.blinkUntil = now + 0.13; this.nextBlink = now + 2.2 + Math.random() * 3; }
    if (now < this.blinkUntil && (e === 'calm' || e === 'focus')) e = 'blink';
    if (e !== this.shownExpr) { this.faceMat.map = this.faceTex[e] || this.faceTex.calm; this.shownExpr = e; }
  }

  // ------------------------------------------------------------ mesh placement
  render() {
    const p = this.parts, J = this.J, up = this.up, back = this.back;
    const placeLimb = (mesh, a, b) => {
      mesh.position.copy(a);
      _tmpA.subVectors(b, a);
      const l = _tmpA.length();
      if (l > 1e-6) mesh.quaternion.setFromUnitVectors(_yAxis, _tmpA.divideScalar(l));
    };
    // chest: from waist to shoulders, breathing
    const cu = _tmpB.subVectors(this.S, J.W).normalize();
    const cr = orthoNormal(_tmpC, this.right, cu);
    const cb = _tmpD.crossVectors(cr, cu);
    p.chest.position.copy(J.W);
    quatFromBasis(p.chest.quaternion, cr, cu, cb);
    const br = 1 + 0.014 * Math.sin(this.now * 2.3);
    p.chest.scale.set(br, 1, br);
    const hr = orthoNormal(_tmpC, this.hipAxis, up);
    const hb = _tmpD.crossVectors(hr, up);
    p.pelvis.position.copy(this.P);
    quatFromBasis(p.pelvis.quaternion, hr, up, hb);
    placeLimb(p.neck, J.neck, _tmpB.copy(J.head).addScaledVector(up, -0.06));
    this.head.position.copy(J.head);
    this.head.quaternion.copy(this.headQ);
    // hair tie + ponytail tube
    p.tie.position.copy(this.tieWorld);
    _tmpB.subVectors(this.tail[0], this.tieWorld).normalize();
    p.tie.quaternion.setFromUnitVectors(_tmpC.set(0, 0, 1), _tmpB);
    this.tailTube.update(this.curves.tail, this.right);
    // arms + hands (a catch pulse squashes the hand for a frame or two)
    for (const s of ['L', 'R']) {
      const hd = J['h' + s];
      this.armTube[s].update(this.curves['a' + s], this.pole['a' + s]);
      const hand = this['hand' + s];
      hand.position.copy(hd);
      hand.quaternion.copy(this.handQ[s]);
      const q = clamp(this.pulse[s], 0, 1) * 0.16;
      hand.scale.set(1.32 * (1 + q), 1.32 * (1 - q), 1.32 * (1 + q));
    }
    // legs + shoes
    for (const s of ['L', 'R']) {
      const an = J['ft' + s];
      this.legTube[s].update(this.curves['l' + s], this.pole['l' + s]);
      const shoe = this['shoe' + s];
      shoe.position.copy(an);
      shoe.quaternion.copy(this.footQ[s]);
    }
    // chalk bag hangs from the belt, swings with lag
    p.bag.position.copy(this.bagPos);
    _tmpB.subVectors(_tmpC.copy(this.P).addScaledVector(back, 0.12).addScaledVector(up, 0.05), this.bagPos).normalize();
    p.bag.quaternion.setFromUnitVectors(_yAxis, _tmpB);
    // blob shadow on the board under the body (low tier), fades as the climber leaves the wall
    const bl = this.blob;
    bl.visible = !!this.blobOn && this.mode === 'climb';
    if (bl.visible) {
      const z = (this.P.z + this.S.z) * 0.5;
      bl.position.set((this.P.x + this.S.x) * 0.5, (this.P.y + this.S.y) * 0.5 - 0.05, 0.004);
      const sc = 0.55 + z * 0.6;
      bl.scale.set(sc * 0.8, sc * 1.3, 1);
      bl.material.opacity = 0.42 * (1 - clamp((z - 0.15) / 0.6, 0, 1));
    }
  }
}
