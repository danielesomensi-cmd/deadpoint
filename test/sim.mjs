// Balance simulator: plays full sessions with simulated players of different skill,
// using the exact game rules from src/logic.js.
import { Session, TUNE, mulberry32, GRADES, MAX_G } from '../src/logic.js';

// Usage: node test/sim.mjs [sessions=500] [profiles=all|novice,good] [TUNE overrides k=v,k=v] [--check]
//   --check: exit 1 if the median best grade of a profile leaves its target band (used in CI)
//   --nobubbles: nobody taps the chalk / jump / allez bubbles
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHECK = process.argv.includes('--check');
const NO_BUBBLES = process.argv.includes('--nobubbles'); // players ignore every bubble (for comparison)
const N = +(ARGS[0] || 500);
const ONLY = ARGS[1] && ARGS[1] !== 'all' ? ARGS[1] : null;
if (ARGS[2]) for (const kv of ARGS[2].split(',')) { const [k, v] = kv.split('='); TUNE[k] = +v; }
// target bands for the median best grade (index into GRADES: 0 = V0 ... 13 = V13)
const BANDS = { novice: [1, 5], casual: [4, 8], good: [6, 10], goodNoRest: [3, 8], expert: [8, 13] };
const MEDIANS = {};

export const PROFILES = {
  // rest: when to mash the rest button (only lit with a hand on a jug) and how fast (taps/s)
  // bub: chance of going for a bubble at all, and the reaction time to reach it [mean, sd] (s)
  novice:     { sigma: 0.085, bias: 0.015, think: [0.8, 0.3],  rest: { below: 35, until: 75, tps: 5 }, bub: { p: 0.5, react: [1.0, 0.3] } },
  casual:     { sigma: 0.062, bias: 0.008, think: [0.6, 0.2],  rest: { below: 45, until: 85, tps: 6 }, bub: { p: 0.7, react: [0.8, 0.25] } },
  good:       { sigma: 0.045, bias: 0.0,   think: [0.45, 0.15], rest: { smart: true, tps: 7 }, bub: { p: 0.85, react: [0.65, 0.2] } },
  goodNoRest: { sigma: 0.045, bias: 0.0,   think: [0.45, 0.15], rest: null, bub: { p: 0.85, react: [0.65, 0.2] } },
  expert:     { sigma: 0.030, bias: 0.0,   think: [0.35, 0.1],  rest: { smart: true, tps: 8 }, bub: { p: 0.92, react: [0.55, 0.15] } },
};

function gaussFactory(rnd) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

const DT = 1 / 90;
const TRUE_LAT = TUNE.latency;

function estRemaining(A) {
  let c = 0;
  const hang = TUNE.drainBase(A.angle) * 0.6;
  for (let i = A.moveIdx; i < A.P.moves.length; i++) {
    const mv = A.P.moves[i];
    c += A.moveCost(mv, 'good') + hang + (mv.feetCut ? 5 : 0);
  }
  return c;
}

function restPlan(A, prof) {
  if (!prof.rest || !A.canRest) return null;
  if (prof.rest.smart) {
    const need = estRemaining(A);
    if (A.energy < Math.min(A.maxEnergy - 4, need * 1.15)) return Math.min(A.maxEnergy - 1, need * 1.3 + 6);
    return null;
  }
  if (A.energy < prof.rest.below) return Math.min(A.maxEnergy - 1, prof.rest.until);
  return null;
}

function decide(A, prof, gauss, t) {
  const st = A.state;
  if (st === 'flight') return { kind: 'tap', at: A.flight.dp + TRUE_LAT + prof.bias + gauss() * prof.sigma };
  if (st === 'feet') return { kind: 'tap', at: A.feet.dp + TRUE_LAT + prof.bias + gauss() * prof.sigma * 1.1 };
  if (st === 'match') return { kind: 'tap', at: A.match.dp + TRUE_LAT + prof.bias + gauss() * prof.sigma };
  if (st === 'hang') {
    const target = restPlan(A, prof);
    if (target != null) return { kind: 'rest', at: t + 0.15, target };
  }
  return { kind: 'tap', at: t + Math.max(0.15, prof.think[0] + gauss() * prof.think[1]) };
}

export function runSession(prof, seed) {
  const S = new Session({ seed });
  const gauss = gaussFactory(mulberry32(seed ^ 0x5bd1e995));
  const bubRnd = mulberry32(seed ^ 0x2545f491);
  let t = 0;
  const rec = { attempts: [], time: 0 };
  while (!S.over) {
    const A = S.startAttempt();
    // bubbles: decide once per bubble whether and when to tap it (the bubble's own life decides if in time)
    const seen = new Set(), taps = [];
    const step = (tt) => {
      A.update(tt);
      for (const k in A.bubbles) {
        const b = A.bubbles[k];
        if (seen.has(b)) continue;
        seen.add(b);
        if (!NO_BUBBLES && prof.bub && bubRnd() < prof.bub.p) taps.push({ k, at: b.t0 + Math.max(0.2, prof.bub.react[0] + gauss() * prof.bub.react[1]) });
      }
      for (let i = taps.length - 1; i >= 0; i--) if (taps[i].at <= tt) { A.tapBubble(taps[i].k, tt); taps.splice(i, 1); }
    };
    step(t);
    let plan = null;
    let guard = 0;
    while (!A.done && guard++ < 200000) {
      if (!plan) { plan = decide(A, prof, gauss, t); plan.state = A.state; plan.phase = 'pending'; }
      if (plan.phase === 'pending') {
        const at = Math.max(plan.at, t);
        while (t + DT < at && !A.done && A.state === plan.state) { t += DT; step(t); }
        if (A.done) break;
        if (A.state !== plan.state) { plan = null; continue; }
        t = at;
        if (plan.kind === 'tap') { A.press(t); plan = null; } else { A.shake(t); plan.phase = 'mashing'; plan.n = 0; }
      } else {
        // mashing the rest button: one tap every 1/tps s (with some jitter) until the target
        const next = t + Math.max(0.05, (1 + 0.15 * gauss()) / prof.rest.tps);
        while (t + DT < next && !A.done) { t += DT; step(t); }
        if (A.done) break;
        t = next;
        if (A.energy >= plan.target || A.energy >= A.maxEnergy - 0.5 || ++plan.n > 90 || !A.canRest) { plan = null; continue; }
        A.shake(t);
      }
    }
    rec.attempts.push({
      g: S.g, attemptNo: S.attemptNo, result: A.result, reason: A.fallReason, energy: A.energy,
      stats: { ...A.stats }, moves: A.P.moves.length, moveIdx: A.moveIdx,
    });
    t += A.result === 'top' ? 3.5 : 2.5;
    S.finishAttempt();
  }
  rec.time = t;
  rec.best = S.bestG;
  rec.score = S.score;
  return rec;
}

function pct(a, b) { return b ? ((100 * a) / b).toFixed(0) + '%' : '-'; }
function quant(arr, q) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
const gl = (g) => (g < 0 ? '—' : GRADES[g].v);

function report(name, prof) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(runSession(prof, 1000 + i * 7));
  const best = runs.map((r) => r.best);
  const times = runs.map((r) => r.time / 60);
  const J = { perfect: 0, good: 0, ok: 0, miss: 0 };
  const falls = { early: 0, late: 0, pump: 0 };
  const perG = {};
  for (let g = 0; g <= MAX_G; g++) perG[g] = { reached: 0, sent: 0, flash: 0, att: 0, falls: { early: 0, late: 0, pump: 0 }, eTop: [], rest: 0 };
  for (const r of runs) {
    const reachedG = new Set();
    for (const a of r.attempts) {
      J.perfect += a.stats.perfect; J.good += a.stats.good; J.ok += a.stats.ok; J.miss += a.stats.miss;
      const P = perG[a.g];
      P.att++;
      P.rest += a.stats.rest;
      if (!reachedG.has(a.g)) { reachedG.add(a.g); P.reached++; }
      if (a.result === 'top') { P.sent++; if (a.attemptNo === 1) P.flash++; P.eTop.push(a.energy); }
      else { falls[a.reason] = (falls[a.reason] || 0) + 1; P.falls[a.reason] = (P.falls[a.reason] || 0) + 1; }
    }
  }
  const tj = J.perfect + J.good + J.ok + J.miss;
  const tf = falls.early + falls.late + falls.pump;
  console.log(`\n=== ${name}  (σ=${(prof.sigma * 1000).toFixed(0)}ms, n=${N})`);
  console.log(`best grade: p10 ${gl(quant(best, 0.1))} | median ${gl(quant(best, 0.5))} | p90 ${gl(quant(best, 0.9))}   session: median ${quant(times, 0.5).toFixed(1)} min`);
  MEDIANS[name] = quant(best, 0.5);
  console.log(`judgements: perfect ${pct(J.perfect, tj)} good ${pct(J.good, tj)} ok ${pct(J.ok, tj)} miss ${pct(J.miss, tj)}   falls: early ${pct(falls.early, tf)} late ${pct(falls.late, tf)} pump ${pct(falls.pump, tf)}`);
  console.log('grade  reached  send/att  flash  pumpFalls  eTop(med)  close(<20)  rest/att');
  for (let g = 0; g <= MAX_G; g++) {
    const P = perG[g];
    if (!P.reached) continue;
    const pf = P.falls.pump || 0, af = (P.falls.pump || 0) + (P.falls.early || 0) + (P.falls.late || 0);
    const close = P.eTop.filter((e) => e < 20).length;
    console.log(
      `${GRADES[g].v.padEnd(5)}  ${pct(P.reached, N).padStart(6)}  ${pct(P.sent, P.att).padStart(8)}  ${pct(P.flash, P.reached).padStart(5)}  ${pct(pf, af).padStart(9)}  ${(P.eTop.length ? quant(P.eTop, 0.5).toFixed(0) : '-').padStart(9)}  ${pct(close, P.eTop.length).padStart(10)}  ${(P.rest / P.att).toFixed(1).padStart(7)}s`
    );
  }
}

for (const [name, prof] of Object.entries(PROFILES)) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  report(name, prof);
}

if (CHECK) {
  const bad = [];
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    if (!(name in MEDIANS)) continue;
    const m = MEDIANS[name];
    if (m < lo || m > hi) bad.push(`${name}: median ${gl(m)} outside ${gl(lo)}..${gl(hi)}`);
  }
  if ('good' in MEDIANS && 'goodNoRest' in MEDIANS && MEDIANS.goodNoRest >= MEDIANS.good) bad.push('resting no longer helps (goodNoRest >= good)');
  console.log(bad.length ? `\nBALANCE CHECK FAILED\n- ${bad.join('\n- ')}` : '\nbalance check: ok');
  if (bad.length) process.exitCode = 1;
}
