// DEADPOINT — the climber.
// Stylized character built from primitives + a "physics-lite" rig:
//   - shoulders (S) and pelvis (P) are point masses driven by springs and kept valid by
//     position-based constraints (torso length, arm reach, leg reach, wall),
//   - hands/feet are effectors that tween along arcs whenever their target jumps,
//   - limbs are solved with analytic two-bone IK, then secondary motion (ponytail,
//     chalk bag, dangling legs) is layered on top.
// All positions are in board-local coordinates (x right, y up the board, z out of the wall).
import * as THREE from 'three';

const V3 = THREE.Vector3;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const smootherstep = (x) => { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };

export const BODY = { ARM1: 0.31, ARM2: 0.30, LEG1: 0.44, LEG2: 0.44, SHW: 0.17, HIPW: 0.095, TORSO: 0.5 };
const ARM_MAX = (BODY.ARM1 + BODY.ARM2) * 0.985;
const LEG_MAX = (BODY.LEG1 + BODY.LEG2) * 0.985;
const HEAD_R = 0.125;

const COLORS = {
  skin: '#eab58f', chalk: '#f4f0e8', hair: '#4a2a17', hairHi: '#6b3f24', tie: '#ffb43e',
  shirt: '#ff6b57', sleeve: '#f25e4b', pants: '#2c3653', cuff: '#45537c',
  shoe: '#25272e', rand: '#ff6b57', sole: '#121317', bag: '#f2b134', bagRim: '#fbf7ee',
  outline: '#1d140f',
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

// soft rim light ("toy" look) injected into MeshStandardMaterial
function addRim(mat, strength, color = '#fff1e2') {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rimColor = { value: new THREE.Color(color) };
    sh.uniforms.rimStrength = { value: strength };
    sh.fragmentShader = 'uniform vec3 rimColor;\nuniform float rimStrength;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  float rimF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.6);\n  totalEmissiveRadiance += rimColor * rimF * rimStrength;');
  };
  mat.customProgramCacheKey = () => 'rim' + strength;
  return mat;
}

const outlineMat = new THREE.ShaderMaterial({
  uniforms: { thickness: { value: 0.0065 }, color: { value: new THREE.Color(COLORS.outline) } },
  vertexShader: 'uniform float thickness;\nvoid main() {\n  vec3 p = position + normalize(normal) * thickness;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);\n}',
  fragmentShader: 'uniform vec3 color;\nvoid main() { gl_FragColor = vec4(color, 1.0); }',
  side: THREE.BackSide,
});

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
  const eyeOpen = (x, ry = 21, look = 0) => {
    g.fillStyle = ink; g.beginPath(); g.ellipse(x, ey, 14.5, ry, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + 5 + look, ey - ry * 0.38, 5.2, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x - 4 + look, ey + ry * 0.3, 2.4, 0, Math.PI * 2); g.fill();
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
      arc(cx, 160, 15, Math.PI * 0.2, Math.PI * 0.8, 5.5);
      break;
    case 'blink':
      arc(cx - ex, ey - 8, 15, Math.PI * 0.18, Math.PI * 0.82); arc(cx + ex, ey - 8, 15, Math.PI * 0.18, Math.PI * 0.82);
      brows(0, 0); arc(cx, 160, 15, Math.PI * 0.2, Math.PI * 0.8, 5.5);
      break;
    case 'focus':
      eyeOpen(cx - ex, 16, 1); eyeOpen(cx + ex, 16, 1); brows(-6, -2);
      line([[cx - 10, 166], [cx + 10, 166]], 5.5);
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
      brows(2, -2);
      g.strokeStyle = ink; g.lineWidth = 5; g.beginPath(); g.ellipse(cx, 164, 7, 8, 0, 0, Math.PI * 2); g.stroke();
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
    };
    this.stand = { mid: new V3(), action: 'idle', t0: 0, nextChalk: 3, cheerUntil: 0, look: null };
    this.fallSt = null;
    this.expr = 'calm'; this.shownExpr = ''; this.nextBlink = 2; this.blinkUntil = 0;
    this.enterUntil = 0;
    this.now = 0; this.acc = 0; this.angle = 30;
    this.onStep = null; this.onLand = null; this.onChalk = null;
    this.bagPos = new V3(); this.bagVel = new V3();
    this.tail = []; this.tailPrev = [];
    this.build();
  }

  // ------------------------------------------------------------ model
  build() {
    const M = (color, rough = 0.62, rim = 0.32) => addRim(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, envMapIntensity: 0.35 }), rim);
    const mat = this.mat = {
      skin: M(COLORS.skin, 0.55, 0.38), chalk: M(COLORS.chalk, 0.85, 0.25), hair: M(COLORS.hair, 0.42, 0.28),
      tie: M(COLORS.tie, 0.5), shirt: M(COLORS.shirt, 0.78, 0.3), sleeve: M(COLORS.sleeve, 0.78, 0.3),
      pants: M(COLORS.pants, 0.85, 0.28), cuff: M(COLORS.cuff, 0.85, 0.25), shoe: M(COLORS.shoe, 0.5, 0.3),
      rand: M(COLORS.rand, 0.45, 0.3), sole: M(COLORS.sole, 0.7, 0.1), bag: M(COLORS.bag, 0.75, 0.3), bagRim: M(COLORS.bagRim, 0.9, 0.2),
    };
    const parts = this.parts = {};
    this.outlined = [];
    const add = (name, geo, m, { outline = true, shadow = true, parent = this.root } = {}) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = shadow;
      parent.add(mesh);
      if (outline) { const o = new THREE.Mesh(geo, outlineMat); o.castShadow = false; mesh.add(o); }
      parts[name] = mesh;
      return mesh;
    };
    const { ARM1, ARM2, LEG1, LEG2 } = BODY;
    // torso: chest (shirt) + pelvis (pants)
    add('chest', latheGeo([[0.02, -0.04], [0.125, -0.035], [0.13, 0.0], [0.138, 0.07], [0.152, 0.15], [0.162, 0.22], [0.163, 0.27], [0.15, 0.315], [0.12, 0.345], [0.075, 0.365], [0.02, 0.372]], 0.66), mat.shirt);
    add('pelvis', latheGeo([[0.02, -0.13], [0.085, -0.115], [0.125, -0.07], [0.138, 0.0], [0.134, 0.08], [0.127, 0.16], [0.12, 0.21], [0.02, 0.215]], 0.74), mat.pants);
    add('neck', limbGeo(0.046, 0.044, 0.1), mat.skin);
    // head group: skull, face decal, hair cap, bangs, ears, bun tie
    const head = this.head = new THREE.Group();
    this.root.add(head);
    const skullGeo = new THREE.SphereGeometry(HEAD_R, 32, 22); skullGeo.scale(1, 1.04, 0.98);
    add('skull', skullGeo, mat.skin, { parent: head });
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
    add('hairCap', capGeo, mat.hair, { parent: head });
    const bangGeo = new THREE.SphereGeometry(0.05, 14, 10); bangGeo.scale(1.25, 0.62, 0.7);
    [[-0.058, 0.062, 0.092, 0.4], [0.0, 0.072, 0.098, 0], [0.06, 0.06, 0.09, -0.4]].forEach(([x, y, z, rz], i) => {
      const b = add('bang' + i, bangGeo, mat.hair, { parent: head, outline: false });
      b.position.set(x, y, z); b.rotation.set(-0.35, 0, rz);
    });
    const earGeo = new THREE.SphereGeometry(0.03, 12, 10); earGeo.scale(0.6, 1, 0.8);
    for (const s of [-1, 1]) { const e = add('ear' + s, earGeo, mat.skin, { parent: head }); e.position.set(s * HEAD_R * 0.98, -0.005, -0.005); }
    const tieGeo = new THREE.TorusGeometry(0.03, 0.012, 8, 18);
    this.tieAnchor = new V3(0, 0.07, -0.118);
    add('tie', tieGeo, mat.tie, { outline: false });
    // ponytail: 5 simulated nodes, rendered as tapered segments
    this.tailN = 5; this.tailSeg = 0.048;
    const tailR = [0.04, 0.042, 0.036, 0.028, 0.018, 0.01];
    for (let i = 0; i < this.tailN; i++) {
      add('tail' + i, limbGeo(tailR[i], tailR[i + 1], this.tailSeg), mat.hair);
      this.tail.push(new V3()); this.tailPrev.push(new V3());
    }
    // arms
    for (const s of ['L', 'R']) {
      add('sleeve' + s, limbGeo(0.062, 0.054, 0.12), mat.sleeve);
      add('ua' + s, limbGeo(0.045, 0.039, ARM1), mat.skin);
      add('fa' + s, limbGeo(0.039, 0.031, ARM2), mat.skin);
      const hand = new THREE.Group(); this.root.add(hand); this['hand' + s] = hand;
      const palmGeo = new THREE.SphereGeometry(0.042, 16, 12); palmGeo.scale(1.08, 1.3, 0.62); palmGeo.translate(0, 0.045, 0);
      add('palm' + s, palmGeo, mat.chalk, { parent: hand });
      const thumbGeo = limbGeo(0.016, 0.014, 0.035, 10);
      const th = add('thumb' + s, thumbGeo, mat.chalk, { parent: hand });
      th.position.set(s === 'L' ? -0.032 : 0.032, 0.02, 0.006); th.rotation.set(0.3, 0, s === 'L' ? 0.9 : -0.9);
      const fingGeo = limbGeo(0.017, 0.016, 0.06, 10); fingGeo.rotateZ(Math.PI / 2); fingGeo.translate(0.03, 0.016, 0);
      const fg = add('fing' + s, fingGeo, mat.chalk, { parent: hand });
      fg.position.set(0, 0.078, 0.0);
      this['fing' + s] = fg;
    }
    // legs
    for (const s of ['L', 'R']) {
      add('th' + s, limbGeo(0.076, 0.058, LEG1), mat.pants);
      add('sh' + s, limbGeo(0.058, 0.05, LEG2 * 0.7), mat.pants);
      add('cuff' + s, limbGeo(0.057, 0.056, 0.035), mat.cuff);
      add('ank' + s, limbGeo(0.039, 0.036, LEG2 * 0.3), mat.skin, { outline: false });
      const shoe = new THREE.Group(); this.root.add(shoe); this['shoe' + s] = shoe;
      const bodyGeo = limbGeo(0.05, 0.04, 0.15, 14); bodyGeo.scale(0.82, 1, 0.78); bodyGeo.translate(0, -0.035, -0.035);
      add('shoeBody' + s, bodyGeo, mat.shoe, { parent: shoe });
      const toeGeo = new THREE.SphereGeometry(0.041, 14, 10); toeGeo.scale(0.82, 1.15, 0.72); toeGeo.translate(0, 0.118, -0.04);
      add('toe' + s, toeGeo, mat.rand, { parent: shoe });
      const soleGeo = limbGeo(0.046, 0.038, 0.155, 12); soleGeo.scale(0.84, 1, 0.3); soleGeo.translate(0, -0.035, -0.066);
      add('sole' + s, soleGeo, mat.sole, { parent: shoe, outline: false });
    }
    // chalk bag
    const bagGeo = new THREE.CylinderGeometry(0.054, 0.05, 0.11, 18); bagGeo.translate(0, -0.03, 0);
    add('bag', bagGeo, mat.bag);
    const rimGeo = new THREE.TorusGeometry(0.052, 0.012, 8, 20); rimGeo.rotateX(Math.PI / 2); rimGeo.translate(0, 0.027, 0);
    add('bagRim', rimGeo, mat.bagRim, { parent: parts.bag, outline: false });
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
    this.render();
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
        this.E['F' + s].spring(_tmpB, dt, 70, 7.5);
      }
    }
    this.grip.L += (I.gripL - this.grip.L) * (1 - Math.exp(-dt * 18));
    this.grip.R += (I.gripR - this.grip.R) * (1 - Math.exp(-dt * 18));
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
    let feetOn, kS = 380, kP = 220, cPf = 0.78;
    if (this.mode === 'climb') {
      feetOn = I.feetOn;
      St.addVectors(E.HL.pos, E.HR.pos).multiplyScalar(0.5).addScaledVector(this.g, 0.3).addScaledVector(this.n, 0.1).add(I.driveS);
      if (feetOn) {
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
    }
    const cS = 2 * Math.sqrt(kS);
    this.Sv.addScaledVector(_tmpC.subVectors(St, S), kS * h).addScaledVector(this.Sv, -cS * h);
    if (feetOn) {
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
      const l = s < 0 ? this.pole.lL : this.pole.lR;
      if (this.mode === 'stand') _tmpA.copy(back).multiplyScalar(-0.9).addScaledVector(right, s * 0.25);
      else if (feetOff || (this.mode === 'fall')) _tmpA.copy(back).multiplyScalar(-0.85).addScaledVector(right, s * 0.3);
      else _tmpA.copy(right).multiplyScalar(s * 0.28).addScaledVector(back, 0.9).addScaledVector(up, -0.1);
      l.lerp(_tmpA, k);
    }
    ik(J.shL, HLt, BODY.ARM1, BODY.ARM2, this.pole.aL, J.elL, J.hL);
    ik(J.shR, HRt, BODY.ARM1, BODY.ARM2, this.pole.aR, J.elR, J.hR);
    ik(J.hipL, FLt, BODY.LEG1, BODY.LEG2, this.pole.lL, J.knL, J.ftL);
    ik(J.hipR, FRt, BODY.LEG1, BODY.LEG2, this.pole.lR, J.knR, J.ftR);

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
      this['fing' + s].rotation.x = 0.25 + 0.9 * g;
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
    this.tieWorld = this.tieWorld || new V3();
    this.tieWorld.copy(anchor);
    const sub = dt > 0.02 ? 2 : 1, h = dt / sub;
    const headC = this.J.head;
    for (let ss = 0; ss < sub; ss++) {
      for (let i = 0; i < this.tailN; i++) {
        const p = this.tail[i], pr = this.tailPrev[i];
        _tmpB.subVectors(p, pr).multiplyScalar(0.96);
        pr.copy(p);
        p.add(_tmpB).addScaledVector(this.g, 9.81 * h * h * 0.9);
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
    const p = this.parts, J = this.J, up = this.up, right = this.right, back = this.back;
    const placeLimb = (mesh, a, b) => {
      mesh.position.copy(a);
      _tmpA.subVectors(b, a);
      const l = _tmpA.length();
      if (l > 1e-6) mesh.quaternion.setFromUnitVectors(_yAxis, _tmpA.divideScalar(l));
    };
    // chest: from waist to shoulders
    const cu = _tmpB.subVectors(this.S, J.W).normalize();
    const cr = orthoNormal(_tmpC, right, cu);
    const cb = _tmpD.crossVectors(cr, cu);
    p.chest.position.copy(J.W);
    quatFromBasis(p.chest.quaternion, cr, cu, cb);
    const hr = orthoNormal(_tmpC, this.hipAxis, up);
    const hb = _tmpD.crossVectors(hr, up);
    p.pelvis.position.copy(this.P);
    quatFromBasis(p.pelvis.quaternion, hr, up, hb);
    placeLimb(p.neck, J.neck, _tmpB.copy(J.head).addScaledVector(up, -0.06));
    this.head.position.copy(J.head);
    this.head.quaternion.copy(this.headQ);
    // hair tie + ponytail
    p.tie.position.copy(this.tieWorld);
    _tmpB.subVectors(this.tail[0], this.tieWorld).normalize();
    p.tie.quaternion.setFromUnitVectors(_tmpC.set(0, 0, 1), _tmpB);
    let prev = this.tieWorld;
    for (let i = 0; i < this.tailN; i++) { placeLimb(p['tail' + i], prev, this.tail[i]); prev = this.tail[i]; }
    // arms
    for (const s of ['L', 'R']) {
      const sh = J['sh' + s], el = J['el' + s], hd = J['h' + s];
      placeLimb(p['sleeve' + s], sh, el);
      placeLimb(p['ua' + s], sh, el);
      placeLimb(p['fa' + s], el, hd);
      const hand = this['hand' + s];
      hand.position.copy(hd);
      hand.quaternion.copy(this.handQ[s]);
    }
    // legs
    for (const s of ['L', 'R']) {
      const hip = J['hip' + s], kn = J['kn' + s], an = J['ft' + s];
      placeLimb(p['th' + s], hip, kn);
      placeLimb(p['sh' + s], kn, an);
      const cuffAt = _tmpB.lerpVectors(kn, an, 0.66);
      placeLimb(p['cuff' + s], cuffAt, an);
      const ankAt = _tmpC.lerpVectors(kn, an, 0.7);
      placeLimb(p['ank' + s], ankAt, an);
      const shoe = this['shoe' + s];
      shoe.position.copy(an);
      shoe.quaternion.copy(this.footQ[s]);
    }
    // chalk bag hangs from the belt, swings with lag
    p.bag.position.copy(this.bagPos);
    _tmpB.subVectors(_tmpC.copy(this.P).addScaledVector(back, 0.12).addScaledVector(up, 0.05), this.bagPos).normalize();
    p.bag.quaternion.setFromUnitVectors(_yAxis, _tmpB);
  }
}
