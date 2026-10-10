// DEADPOINT — game rules. Pure JS (no DOM, no three.js).
// Shared by the game page and by the Node balance simulator (test/sim.mjs).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Board geometry (meters) ----------
// 12x12 ft upper board on an adjustable frame, kickboard exposed above the pads.
export const BOARD_W = 3.66;
export const BOARD_H = 3.66;
export const KICK_TOP = 0.78; // world height of the hinge (top of kickboard)
export const MAT_TOP = 0.32;  // world height of crash-pad surface

// ---------- Hold types ----------
// win: timing-window multiplier, drain: hang cost multiplier,
// rest: shake-out recovery factor, cost: move cost multiplier
export const HOLD_TYPES = {
  jug:    { it: 'Maniglia',  win: 1.30, drain: 0.55, rest: 1.00, cost: 0.85 },
  edge:   { it: 'Listino',   win: 1.05, drain: 1.00, rest: 0.50, cost: 1.00 },
  pinch:  { it: 'Pinza',     win: 0.95, drain: 1.10, rest: 0.30, cost: 1.05 },
  crimp:  { it: 'Tacchetta', win: 0.85, drain: 1.40, rest: 0.12, cost: 1.15 },
  sloper: { it: 'Svaso',     win: 0.78, drain: 1.25, rest: 0.25, cost: 1.20 },
  chip:   { it: 'Appoggio',  win: 1.00, drain: 1.00, rest: 0.00, cost: 1.00, footOnly: true },
};

// ---------- Grades ----------
export const GRADES = [
  { v: 'V0', f: '4' }, { v: 'V1', f: '5' }, { v: 'V2', f: '5+' }, { v: 'V3', f: '6a+' },
  { v: 'V4', f: '6b+' }, { v: 'V5', f: '6c+' }, { v: 'V6', f: '7a' }, { v: 'V7', f: '7a+' },
  { v: 'V8', f: '7b+' }, { v: 'V9', f: '7c' }, { v: 'V10', f: '7c+' }, { v: 'V11', f: '8a' },
  { v: 'V12', f: '8a+' }, { v: 'V13', f: '8b' },
];
export const MAX_G = GRADES.length - 1;
export const gradeLabel = (g) => { const G = GRADES[clamp(g, 0, MAX_G)]; return G.f; };

export function gradeParams(g) {
  const G = clamp(g, 0, MAX_G);
  return {
    angle: [20, 25, 30, 35, 40, 40, 45, 45, 50, 50, 55, 60, 65, 70][G],
    win: Math.max(0.72, 1.22 - 0.038 * G),
    speed: Math.max(0.7, 1 - 0.024 * G),
    gainMin: 0.2 + 0.008 * G,
    gainMax: 0.44 + 0.022 * G,
    weights: {
      jug: Math.max(0.04, 0.62 - 0.075 * G),
      edge: 0.32,
      crimp: 0.04 + 0.045 * G,
      sloper: 0.02 + 0.04 * G,
      pinch: 0.06 + 0.025 * G,
    },
    dyno: G < 3 ? 0 : Math.min(0.45, 0.07 * (G - 2)),
  };
}

// ---------- Tuning (balanced with test/sim.mjs) ----------
export const TUNE = {
  drainBase: (angle) => 0.5 + 0.05 * angle, // energy/s on a hold with drain 1
  restRate: 15,          // energy/s recovered on a hold with rest 1
  restDrain: 1.25,       // one-hand hang while shaking
  restHold: 0.22,        // s of press before it counts as "shake out"
  flightDrain: 0.65,
  feetDrain: 1.8,
  costBase: 2.2,
  costPerM: 7,
  costAngle: (angle) => 0.7 + angle / 55,
  gradeCost: 0.035,      // extra move cost per grade step
  timingMult: { perfect: 0.45, good: 1.0, ok: 1.85 },
  fatigue: 0.22,         // max-energy loss per energy spent on moves
  minMax: 40,
  win: { perfect: 0.040, good: 0.085, ok: 0.140 },
  dynoWin: 0.85, dynoCost: 1.3, dynoFlight: 0.9,
  feetT: 0.55, feetWin: 1.1, feetMissCost: 14,
  matchDelay: 0.3, matchT: 0.7, matchWin: 1.35, matchMissCost: 15,
  flowCombo: 3, flowCost: 0.85,
  latency: 0.03,         // default input/display latency compensation (s)
  latencyMin: -0.01, latencyMax: 0.07, latencyRate: 0.05,
  grace: 0.12,           // ignore double-taps right after a launch/catch
  attempts: 3,
};

// ---------- Board layout (fixed, like a real board) ----------
// Kilter-style pattern (geometry only, no real hole table): a square grid of bolt-on holds
// (19 cols x 18 rows, 8" pitch, every hole filled), screw-on foot chips in a checkerboard at the
// centres of every other grid square, and two rows of holds on the vertical kickboard.
export const LAYOUT = {
  PX: 0.192, PY: 0.2032, cols: 19, rows: 18,
  x0: -BOARD_W / 2 + 0.10, y0: 0.10,       // first bolt-on
  chipY0: 0.20, chipRows: 15, chipCols: 9,  // chips: half-pitch offset, 2*PX apart, rows alternate
  kickBoltY: KICK_TOP - 0.10, kickChipY: KICK_TOP - 0.20, // world heights of the kickboard rows
};
const TYPE_RATIO = { jug: 0.21, edge: 0.25, crimp: 0.21, sloper: 0.18, pinch: 0.15 };
const LOW_RATIO = { edge: 0.5, jug: 0.3, crimp: 0.2 };

// a bag of n types matching the ratios (largest remainder), shuffled
function typeBag(rnd, ratio, n) {
  const keys = Object.keys(ratio), out = [];
  const base = keys.map((k) => Math.floor(ratio[k] * n));
  let left = n - base.reduce((a, b) => a + b, 0);
  const rem = keys.map((k, i) => ({ i, r: ratio[k] * n - base[i] + rnd() * 0.5 })).sort((a, b) => b.r - a.r);
  for (let k = 0; k < left; k++) base[rem[k % keys.length].i]++;
  keys.forEach((k, i) => { for (let j = 0; j < base[i]; j++) out.push(k); });
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function holdRot(rnd, type) {
  if (type === 'pinch') return (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.6;
  const r = rnd();
  if (r < 0.6) return (rnd() - 0.5) * 0.7;                                   // up, slightly angled
  if (r < 0.85) return (rnd() < 0.5 ? -1 : 1) * (1.0 + rnd() * 0.8);          // sidepull
  if (r < 0.93) return Math.PI + (rnd() - 0.5) * 0.6;                         // undercling
  return (rnd() - 0.5) * 2 * Math.PI;
}

export function makeBoard(seed = 20181212) {
  const rnd = mulberry32(seed);
  const L = LAYOUT;
  const holds = [];
  let id = 0;
  // bolt-ons: types drawn from a shuffled bag per 3x3 block, so every area has a bit of everything
  const grid = [];
  for (let bj = 0; bj < L.rows; bj += 3) for (let bi = 0; bi < L.cols; bi += 3) {
    const cells = [];
    for (let j = bj; j < Math.min(L.rows, bj + 3); j++) for (let i = bi; i < Math.min(L.cols, bi + 3); i++) cells.push([i, j]);
    const low = L.y0 + bj * L.PY < 0.6;
    const bag = typeBag(rnd, low ? LOW_RATIO : TYPE_RATIO, cells.length);
    cells.forEach(([i, j], k) => { grid[j * L.cols + i] = bag[k]; });
  }
  for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) {
    const type = grid[j * L.cols + i];
    holds.push({ id: id++, x: L.x0 + i * L.PX, y: L.y0 + j * L.PY, type, rot: holdRot(rnd, type), size: 0.92 + rnd() * 0.16, col: i, row: j });
  }
  for (let k = 0; k < L.chipRows; k++) for (let m = 0; m < L.chipCols; m++) {
    holds.push({ id: id++, x: L.x0 + L.PX / 2 + (2 * m + (k % 2)) * L.PX, y: L.chipY0 + k * L.PY, type: 'chip', rot: (rnd() - 0.5) * 1.4, size: 0.9 + rnd() * 0.2 });
  }
  // kickboard: y is relative to the hinge in the (vertical) kickboard plane, wy is the world height
  for (let i = 0; i < L.cols; i++) {
    const wy = L.kickBoltY;
    holds.push({ id: id++, kick: true, x: L.x0 + i * L.PX, y: wy - KICK_TOP, wy, type: rnd() < 0.6 ? 'edge' : 'jug', rot: (rnd() - 0.5) * 0.6, size: 0.8 });
  }
  for (let i = 0; i < L.cols - 1; i++) {
    const wy = L.kickChipY;
    holds.push({ id: id++, kick: true, x: L.x0 + L.PX / 2 + i * L.PX, y: wy - KICK_TOP, wy, type: 'chip', rot: (rnd() - 0.5) * 1.4, size: 0.95 });
  }
  return holds;
}

// Point on the vertical kickboard (below the hinge) expressed in board-local coords.
export function kickerPoint(x, worldY, angleDeg) {
  const th = (angleDeg * Math.PI) / 180;
  const ry = worldY - KICK_TOP, rz = 0.03;
  // inverse rotation about X by -th
  return { x, y: ry * Math.cos(th) + rz * Math.sin(th), z: -ry * Math.sin(th) + rz * Math.cos(th) };
}

const NAME_A = ['Ghisa', 'Tacca', 'Svaso', 'Lancio', 'Pinza', 'Magnesite', 'Deadpoint', 'Volo', 'Dyno',
  'Spallata', 'Bidone', 'Tallonata', 'Strapiombo', 'Scivolo', 'Lolotte', 'Bloccaggio', 'Campus', 'Rovescio'];
const NAME_B = ['Gentile', 'Infame', 'Feroce', 'Elegante', 'Instabile', 'al Neon', 'senza Piedi', 'di Velluto',
  'da Bar', 'della Domenica', 'di Mezzanotte', 'per Pochi', 'in Ritardo', 'di Gesso', 'col Botto', 'sul Filo',
  'Sublime', 'a Sorpresa'];

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function generateProblem(board, g, seed) {
  for (let k = 0; k < 60; k++) {
    const p = tryGenerate(board, g, (seed + k * 7919) >>> 0, k > 30);
    if (p) return p;
  }
  throw new Error('generateProblem failed');
}

function pickWeighted(rnd, items, wfn) {
  let sum = 0;
  const ws = items.map((it) => { const w = Math.max(0, wfn(it)); sum += w; return w; });
  if (sum <= 0) return null;
  let r = rnd() * sum;
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

function tryGenerate(board, g, seed, relaxed) {
  const rnd = mulberry32(seed);
  const P = gradeParams(g);
  // hands never go on chips or on the kickboard; sidepulls/underclings are picked less often
  const hands = board.filter((h) => h.type !== 'chip' && !h.kick);
  const used = new Set();
  const facing = (h) => (Math.abs(Math.atan2(Math.sin(h.rot), Math.cos(h.rot))) < 0.9 || h.type === 'pinch' ? 1 : 0.45);
  const startOK = (h) => h.y > 0.5 && h.y < 1.5 && Math.abs(h.x) < 1.1 && facing(h) === 1 && (g >= 4 || h.type === 'jug' || h.type === 'edge');
  const sc = hands.filter(startOK);
  if (!sc.length) return null;
  const s1 = sc[Math.floor(rnd() * sc.length)];
  let L, R;
  if (rnd() < 0.25 && (s1.type === 'jug' || s1.type === 'edge')) { L = R = s1; }
  else {
    const s2c = sc.filter((h) => h !== s1 && h.x - s1.x > 0.15 && h.x - s1.x < 0.6 && Math.abs(h.y - s1.y) < 0.42);
    if (!s2c.length) return null;
    const s2 = s2c[Math.floor(rnd() * s2c.length)];
    L = s1; R = s2;
  }
  used.add(L.id); used.add(R.id);
  const start = { L: L.id, R: R.id };
  const moves = [];
  const stanceHands = [{ L, R }];
  for (let guard = 0; guard < 14; guard++) {
    const top = Math.max(L.y, R.y);
    const midX = (L.x + R.x) / 2;
    const lower = L === R ? null : (L.y <= R.y ? 'L' : 'R');
    const finishing = top >= 2.95;
    let cands;
    if (finishing) {
      // finish on the top row when possible, like most board problems
      cands = hands.filter((h) => !used.has(h.id) && h.y >= 3.5 && h.y - top > 0.08 && Math.abs(h.x - midX) < 0.7 &&
        h.type !== 'crimp' && Math.min(dist2(h, L), dist2(h, R)) < 1.0);
      if (!cands.length) cands = hands.filter((h) => !used.has(h.id) && h.y >= 3.35 && Math.abs(h.x - midX) < 0.8 && Math.min(dist2(h, L), dist2(h, R)) < 1.05);
    } else {
      const gmin = P.gainMin * (relaxed ? 0.5 : 0.7), gmax = P.gainMax * (relaxed ? 1.15 : 1);
      cands = hands.filter((h) => {
        if (used.has(h.id)) return false;
        const gain = h.y - top;
        if (gain < gmin || gain > gmax) return false;
        if (Math.abs(h.x - midX) > 0.72 || Math.abs(h.x) > BOARD_W / 2 - 0.25) return false;
        const d = Math.min(dist2(h, L), dist2(h, R));
        return d >= 0.3 && d <= 1.05;
      });
    }
    // decide the moving hand per candidate and keep only plausible body positions:
    // no crossed hands, reach from the moving hand <= 1.05 m, hand span <= 1.2 m
    const handFor = (h) => (L === R ? (h.x >= L.x ? 'R' : 'L') : (h.x < midX ? 'L' : 'R'));
    cands = cands.filter((h) => {
      const hand = handFor(h);
      const other = hand === 'L' ? R : L, from = hand === 'L' ? L : R;
      if (hand === 'L' && h.x > other.x + 0.1) return false;
      if (hand === 'R' && h.x < other.x - 0.1) return false;
      const d = dist2(from, h);
      return d >= 0.25 && d <= 1.05 && dist2(h, other) <= 1.2;
    });
    if (!cands.length) return null;
    const ideal = (P.gainMin + P.gainMax) / 2;
    const t = pickWeighted(rnd, cands, (h) => {
      let w = (finishing ? 1 : (P.weights[h.type] || 0.05)) * facing(h);
      if (!finishing) w *= Math.exp(-Math.pow(h.y - top - ideal, 2) / (2 * 0.12 * 0.12)) + 0.08;
      if (lower && handFor(h) === lower) w *= 1.7;
      return w;
    });
    if (!t) return null;
    const hand = handFor(t);
    const from = hand === 'L' ? L : R;
    const d = dist2(from, t);
    const dyno = !finishing && g >= 3 && (d > 0.95 || rnd() < P.dyno);
    const feetCut = !finishing && P.angle >= 40 && (dyno ? rnd() < 0.7 : d > 0.8 && rnd() < 0.3);
    moves.push({ hand, from: from.id, to: t.id, d, dyno, feetCut, finish: finishing });
    used.add(t.id);
    if (hand === 'L') L = t; else R = t;
    stanceHands.push({ L, R });
    if (finishing) break;
  }
  if (!moves.length || !moves[moves.length - 1].finish) return null;
  if (moves.length < 3) return null;
  if (!relaxed && moves.length + (start.L === start.R ? 1 : 2) > 9) return null; // 5-9 hand holds, like real board problems

  // Feet for every stance: screw-on chips first, then bolt-ons; low stances use the kickboard.
  // Reusing a foot already in the problem is cheaper, so problems keep a handful of foot holds.
  const handIds = new Set([start.L, start.R, ...moves.map((m) => m.to)]);
  const angle = P.angle;
  const footUsed = new Set();
  const kickHolds = board.filter((h) => h.kick);
  const prevFoot = { L: null, R: null };
  const stances = stanceHands.map(({ L: l, R: r }, si) => {
    const mover = si > 0 ? moves[si - 1].hand : null; // the foot on the other side tends to stay
    const yT = Math.min(l.y, r.y) - 1.0;
    const xm = (l.x + r.x) / 2;
    const footAt = (side) => {
      const tx = xm + (side === 'L' ? -0.22 : 0.22);
      const sideOK = (h) => (side === 'L' ? h.x <= xm + 0.05 : h.x >= xm - 0.05);
      // keep the previous foot while it is still close to where the body wants it
      const pf = prevFoot[side];
      const tol = side === mover ? 0.14 : 0.24;
      if (pf && sideOK(pf.h) && Math.abs(pf.h.x - tx) < 0.32 &&
        (pf.h.kick ? yT < 0.12 + tol : Math.abs(pf.h.y - yT) < tol)) return pf.f;
      let best = null, bd = 1e9;
      if (yT < 0.12) {
        // kickboard: pick by x, and the lower chip row when the hands are low
        const wyT = KICK_TOP - 0.18 + clamp(yT, -0.5, 0.2) * 0.25;
        for (const h of kickHolds) {
          if (!sideOK(h)) continue;
          const dd = Math.abs(h.x - tx) + Math.abs(h.wy - wyT) * 0.8 - (footUsed.has(h.id) ? 0.1 : 0);
          if (dd < bd) { bd = dd; best = h; }
        }
        if (best) { prevFoot[side] = { h: best, f: { ...kickerPoint(best.x, best.wy, angle), id: best.id } }; return prevFoot[side].f; }
        return { ...kickerPoint(tx, wyT, angle), id: null };
      }
      for (const h of board) {
        if (h.kick || Math.abs(h.y - yT) > 0.34 || Math.abs(h.x - tx) > 0.38 || !sideOK(h)) continue;
        const pref = h.type === 'chip' ? 0 : h.type === 'edge' || h.type === 'jug' ? 0.06 : 0.14;
        // old hand holds make good feet (a foot below the target means a stretched leg)
        const reuse = handIds.has(h.id) ? (h.y > yT - 0.12 ? 0.3 : 0.06) : footUsed.has(h.id) ? 0.12 : 0;
        const dd = Math.hypot(h.x - tx, (h.y - yT) * (h.y < yT ? 1.1 : 0.7)) + pref - reuse;
        if (dd < bd) { bd = dd; best = h; }
      }
      if (best) { prevFoot[side] = { h: best, f: { x: best.x, y: best.y, z: best.type === 'chip' ? 0.025 : 0.05, id: best.id } }; return prevFoot[side].f; }
      return { x: tx, y: yT, z: 0.02, id: null };
    };
    const FL = footAt('L'), FR = footAt('R');
    if (FL.id != null) footUsed.add(FL.id);
    if (FR.id != null) footUsed.add(FR.id);
    return { FL, FR };
  });

  const roles = {};
  for (const s of stances) for (const f of [s.FL, s.FR]) if (f.id != null && !handIds.has(f.id)) roles[f.id] = 'foot';
  for (const m of moves) roles[m.to] = m.finish ? 'finish' : 'hand';
  roles[start.L] = 'start'; roles[start.R] = 'start';
  const ia = Math.floor(rnd() * NAME_A.length), ib = Math.floor(rnd() * NAME_B.length);
  const name = NAME_A[ia] + ' ' + NAME_B[ib];
  // nameIdx lets the UI show a translated name (src/i18n.js) without touching the RNG sequence
  return { grade: g, angle, name, nameIdx: [ia, ib], seed, start, moves, stances, roles };
}

// ---------- One attempt on a problem ----------
export class Attempt {
  constructor(session, problem) {
    this.S = session;
    this.P = problem;
    this.g = problem.grade;
    this.angle = problem.angle;
    this.state = 'ready';
    this.t = null;
    this.energy = 100;
    this.maxEnergy = 100;
    this.L = problem.start.L;
    this.R = problem.start.R;
    this.moveIdx = 0;
    this.stanceIdx = 0;
    this.combo = session.combo;
    this.score = 0;
    this.stats = { perfect: 0, good: 0, ok: 0, miss: 0, rest: 0, feetMiss: 0, matchMiss: 0 };
    this.pressing = false;
    this.pressT = 0;
    this.pressState = null;
    this.flight = null;
    this.feet = null;
    this.match = null;
    this.restHand = null;
    this.events = [];
    this.result = null;
    this.fallReason = null;
    this.last = null; // last judgement {q, off}
  }
  hold(id) { return this.S.boardById[id]; }
  type(id) { return HOLD_TYPES[this.hold(id).type]; }
  emit(type, data = {}) { this.events.push({ type, t: this.t, ...data }); }
  get done() { return this.state === 'top' || this.state === 'fall'; }
  nextMove() { return this.P.moves[this.moveIdx] || null; }

  windows(typeKey, mult = 1) {
    const gp = gradeParams(this.g);
    const pump = this.energy >= 40 ? 1 : 0.72 + 0.28 * (this.energy / 40);
    const k = gp.win * HOLD_TYPES[typeKey].win * pump * mult;
    return { perfect: TUNE.win.perfect * k, good: TUNE.win.good * k, ok: TUNE.win.ok * k };
  }
  flightTime(mv) {
    const gp = gradeParams(this.g);
    let T = clamp(0.5 + 0.5 * mv.d, 0.62, 1.1) * gp.speed;
    if (mv.dyno) T *= TUNE.dynoFlight;
    return Math.max(0.5, T);
  }
  moveCost(mv, q) {
    const tt = this.type(mv.to);
    let c = (TUNE.costBase + TUNE.costPerM * mv.d) * TUNE.costAngle(this.angle) * tt.cost * TUNE.timingMult[q];
    if (mv.dyno) c *= TUNE.dynoCost;
    if (this.combo >= TUNE.flowCombo) c *= TUNE.flowCost;
    return c * (1 + TUNE.gradeCost * this.g);
  }
  bestHand() {
    const rl = this.type(this.L).rest, rr = this.type(this.R).rest;
    return rr > rl ? 'R' : 'L';
  }
  energyRate() {
    const base = TUNE.drainBase(this.angle);
    const dL = this.type(this.L).drain, dR = this.type(this.R).drain;
    switch (this.state) {
      case 'hang': return -base * (dL + dR) / 2;
      case 'flight': return -base * (this.flight.mv.hand === 'L' ? dR : dL) * TUNE.flightDrain;
      case 'feet': return -base * (dL + dR) / 2 * TUNE.feetDrain;
      case 'match': return -base * (dL + dR) / 2;
      case 'rest': {
        const T = this.type(this.restHand === 'L' ? this.L : this.R);
        return TUNE.restRate * T.rest - base * T.drain * TUNE.restDrain;
      }
      default: return 0;
    }
  }
  restRateFor(handId) {
    const base = TUNE.drainBase(this.angle);
    const T = this.type(handId);
    return TUNE.restRate * T.rest - base * T.drain * TUNE.restDrain;
  }

  update(t) {
    if (this.t === null) { this.t = t; return; }
    let dt = t - this.t;
    if (dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25;
    this.t = t;
    if (this.done) return;
    if (this.state === 'hang' && this.pressing && this.pressState === 'hang' && t - this.pressT >= TUNE.restHold) {
      this.state = 'rest';
      this.restHand = this.bestHand();
      this.emit('restStart', { hand: this.restHand });
    }
    if (this.state !== 'ready') {
      this.energy += this.energyRate() * dt;
      if (this.state === 'rest') {
        this.stats.rest += dt;
        if (this.energy > this.maxEnergy) this.energy = this.maxEnergy;
      }
      if (this.energy <= 0) { this.energy = 0; this.fall('pump'); return; }
    }
    const lat = this.S.latency;
    if (this.state === 'flight' && t > this.flight.dp + lat + this.flight.w.ok) this.missFlight('late', t - this.flight.dp - lat);
    else if (this.state === 'feet' && t > this.feet.dp + lat + this.feet.w.ok) this.missFeet(t - this.feet.dp - lat);
    else if (this.state === 'match' && t > this.match.dp + lat + this.match.w.ok) this.missMatch(t - this.match.dp - lat);
  }

  press(t) {
    this.update(t);
    if (this.pressing || this.done) return;
    this.pressing = true;
    this.pressT = t;
    this.pressState = this.state;
    if (this.state === 'flight') this.tryCatch(t);
    else if (this.state === 'feet') this.tryFeet(t);
    else if (this.state === 'match') this.tryMatch(t);
  }

  release(t) {
    this.update(t);
    if (!this.pressing) return;
    this.pressing = false;
    if (this.done) return;
    if (this.state === 'rest') { this.state = 'hang'; this.emit('restEnd'); return; }
    if (this.pressState === 'ready' && this.state === 'ready') { this.launch(t); return; }
    if (this.pressState === 'hang' && this.state === 'hang' && t - this.pressT < TUNE.restHold) this.launch(t);
  }

  launch(t) {
    const mv = this.nextMove();
    if (!mv) return;
    const w = this.windows(this.hold(mv.to).type, mv.dyno ? TUNE.dynoWin : 1);
    const T = this.flightTime(mv);
    this.flight = { mv, t0: t, T, dp: t + T, w };
    this.state = 'flight';
    this.emit('launch', { mv, T, w });
  }

  judge(t, dp, w) {
    const off = t - (dp + this.S.latency);
    const a = Math.abs(off);
    const q = a <= w.perfect ? 'perfect' : a <= w.good ? 'good' : a <= w.ok ? 'ok' : null;
    return { q, off };
  }

  points(q, mult = 1) {
    const base = { perfect: 100, good: 50, ok: 20 }[q] || 0;
    return Math.round(base * (1 + 0.1 * Math.min(this.combo, 10)) * (1 + 0.15 * this.g) * mult);
  }

  tryCatch(t) {
    const f = this.flight;
    if (t - f.t0 < TUNE.grace) return;
    const { q, off } = this.judge(t, f.dp, f.w);
    if (!q) { this.missFlight(off < 0 ? 'early' : 'late', off); return; }
    const mv = f.mv;
    const cost = this.moveCost(mv, q);
    this.energy -= cost;
    this.maxEnergy = Math.max(TUNE.minMax, this.maxEnergy - cost * TUNE.fatigue);
    this.stats[q]++;
    if (q === 'perfect') this.combo++;
    else if (q === 'ok') this.combo = 0;
    const pts = this.points(q, mv.dyno ? 1.5 : 1);
    this.score += pts;
    this.S.calibrate(off, q);
    if (mv.hand === 'L') this.L = mv.to; else this.R = mv.to;
    this.moveIdx++;
    this.stanceIdx = this.moveIdx;
    this.last = { q, off };
    this.flight = null;
    this.emit('catch', { q, off, cost, pts, mv, combo: this.combo });
    if (this.energy <= 0) { this.energy = 0; this.fall('pump'); return; }
    if (mv.finish) {
      this.state = 'match';
      this.armMatch(t);
    } else if (mv.feetCut) {
      this.state = 'feet';
      this.feet = { t0: t, dp: t + TUNE.feetT, w: this.windows('edge', TUNE.feetWin) };
      this.emit('feetCut', { T: TUNE.feetT });
    } else {
      this.state = 'hang';
    }
  }

  missFlight(reason, off) {
    this.stats.miss++;
    this.last = { q: 'miss', off };
    this.emit('miss', { reason, off, mv: this.flight && this.flight.mv });
    this.fall(reason);
  }

  tryFeet(t) {
    const f = this.feet;
    if (t - f.t0 < TUNE.grace) return;
    const { q, off } = this.judge(t, f.dp, f.w);
    if (!q) { this.missFeet(off); return; }
    const cost = 2.5 * TUNE.timingMult[q];
    this.energy -= cost;
    if (q === 'perfect') this.combo++;
    else if (q === 'ok') this.combo = 0;
    const pts = this.points(q, 0.5);
    this.score += pts;
    this.stats[q]++;
    this.S.calibrate(off, q);
    this.feet = null;
    this.state = 'hang';
    this.last = { q, off };
    this.emit('feetCatch', { q, off, pts, combo: this.combo });
    if (this.energy <= 0) { this.energy = 0; this.fall('pump'); }
  }

  missFeet(off) {
    this.energy -= TUNE.feetMissCost;
    this.stats.feetMiss++;
    this.combo = 0;
    this.feet = null;
    this.state = 'hang';
    this.last = { q: 'miss', off };
    this.emit('feetMiss', { off, cost: TUNE.feetMissCost });
    if (this.energy <= 0) { this.energy = 0; this.fall('pump'); }
  }

  armMatch(t) {
    const fin = this.hold(this.P.moves[this.P.moves.length - 1].to);
    const t0 = t + TUNE.matchDelay;
    this.match = { t0, dp: t0 + TUNE.matchT, w: this.windows(fin.type, TUNE.matchWin), T: TUNE.matchT };
    this.emit('matchArm', { t0, T: TUNE.matchT });
  }

  tryMatch(t) {
    const m = this.match;
    if (t < m.t0 + 0.08) return;
    const { q, off } = this.judge(t, m.dp, m.w);
    if (!q) { this.missMatch(off); return; }
    if (q === 'perfect') this.combo++;
    const pts = this.points(q, 1);
    this.stats[q]++;
    this.S.calibrate(off, q);
    const flashMult = [2, 1.4, 1][clamp(this.S.attemptNo - 1, 0, 2)];
    const bonus = Math.round((400 + 150 * this.g) * flashMult + this.energy * 4);
    this.score += pts + bonus;
    this.last = { q, off };
    this.match = null;
    this.state = 'top';
    this.result = 'top';
    this.emit('top', { q, off, pts, bonus, flash: this.S.attemptNo === 1, energy: this.energy });
  }

  missMatch(off) {
    this.energy -= TUNE.matchMissCost;
    this.stats.matchMiss++;
    this.combo = 0;
    this.last = { q: 'miss', off };
    this.emit('matchMiss', { off, cost: TUNE.matchMissCost });
    if (this.energy <= 0) { this.energy = 0; this.fall('pump'); return; }
    this.armMatch(this.t + 0.25);
  }

  fall(reason) {
    this.state = 'fall';
    this.result = 'fall';
    this.fallReason = reason;
    this.combo = 0;
    this.flight = null; this.feet = null; this.match = null;
    this.emit('fall', { reason });
  }
}

// ---------- Session: a pyramid of problems, 3 attempts each ----------
export class Session {
  constructor(opts = {}) {
    this.board = opts.board || makeBoard();
    this.boardById = {};
    for (const h of this.board) this.boardById[h.id] = h;
    this.seed = (opts.seed ?? (Date.now() & 0x7fffffff)) >>> 0;
    this.rng = mulberry32(this.seed);
    this.g = opts.startGrade ?? 0;
    this.attemptNo = 1;
    this.score = 0;
    this.combo = 0;
    this.latency = opts.latency ?? TUNE.latency;
    this.log = [];
    this.over = false;
    this.attempt = null;
    this.newProblem();
  }
  newProblem() {
    this.problem = generateProblem(this.board, this.g, Math.floor(this.rng() * 2147483647));
    this.attemptNo = 1;
  }
  startAttempt() {
    this.attempt = new Attempt(this, this.problem);
    return this.attempt;
  }
  calibrate(off, q) {
    if (this.freezeCalib) return;
    if (q !== 'perfect' && q !== 'good') return;
    this.latency = clamp(this.latency + TUNE.latencyRate * off, TUNE.latencyMin, TUNE.latencyMax);
  }
  finishAttempt() {
    const a = this.attempt;
    this.score += a.score;
    if (a.result === 'top') {
      this.combo = a.combo;
      this.log.push({ g: this.g, attempts: this.attemptNo, name: this.problem.name });
      if (this.g >= MAX_G) { this.over = true; this.completed = true; return 'over'; }
      this.g++;
      this.newProblem();
      return 'next';
    }
    this.combo = 0;
    this.attemptNo++;
    if (this.attemptNo > TUNE.attempts) { this.over = true; return 'over'; }
    return 'retry';
  }
  get bestG() { return this.log.length ? this.log[this.log.length - 1].g : -1; }
}
