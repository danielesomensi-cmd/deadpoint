// Sanity stats for the problem generator + reachability of feet with the body solver geometry.
import { makeBoard, generateProblem, gradeParams, MAX_G } from '../src/logic.js';
const board = makeBoard(); const byId = Object.fromEntries(board.map(h => [h.id, h]));
const v = (x, y, z) => ({ x, y, z }); const add = (a, b, k = 1) => v(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z); const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a) || 1; return v(a.x / l, a.y / l, a.z / l); };
const grip = (id) => { const h = byId[id]; return v(h.x, h.y + 0.012, 0.06); };
const foot = (f) => v(f.x, f.y + 0.03, (f.z ?? 0.04) + 0.075);
for (let g = 0; g <= MAX_G; g += 1) {
  const P = gradeParams(g); const th = P.angle * Math.PI / 180; const gL = v(0, -Math.cos(th), Math.sin(th)); const n = v(0, 0, 1);
  let N = 0, moves = 0, dyno = 0, cut = 0, cross = 0, unreach = 0, stances = 0, maxd = 0, armOver = 0;
  for (let s = 0; s < 300; s++) {
    const pr = generateProblem(board, g, 1000 + s * 13); N++; moves += pr.moves.length;
    let L = pr.start.L, R = pr.start.R;
    pr.moves.forEach((m) => { if (m.dyno) dyno++; if (m.feetCut) cut++; maxd = Math.max(maxd, m.d);
      if (m.hand === 'L') L = m.to; else R = m.to;
      if (byId[L].x > byId[R].x + 0.3) cross++; });
    // replay stances
    L = pr.start.L; R = pr.start.R;
    for (let i = 0; i < pr.stances.length; i++) {
      if (i > 0) { const m = pr.moves[i - 1]; if (m.hand === 'L') L = m.to; else R = m.to; }
      const HL = grip(L), HR = grip(R); const H = v((HL.x + HR.x) / 2, (HL.y + HR.y) / 2, (HL.z + HR.z) / 2);
      let S = add(add(H, gL, 0.3), n, 0.1);
      let ax = norm(v(HR.x - HL.x, HR.y - HL.y, 0)); if (ax.x < 0.35) ax = norm(v(0.35, ax.y, 0)); ax = norm(v(ax.x * 0.65 + 0.35, ax.y * 0.65, 0));
      for (let it = 0; it < 4; it++) for (const [side, Hh] of [[-1, HL], [1, HR]]) {
        const sh = add(S, ax, side * 0.18); const d = len(sub(Hh, sh)); const max = 0.61 * 0.985;
        if (d > max) S = add(S, sub(Hh, sh), (d - max) / d);
      }
      const shL = add(S, ax, -0.18), shR = add(S, ax, 0.18);
      if (len(sub(HL, shL)) > 0.61 * 1.01 || len(sub(HR, shR)) > 0.61 * 1.01) armOver++;
      const FL = foot(pr.stances[i].FL), FR = foot(pr.stances[i].FR); const Fm = v((FL.x + FR.x) / 2, (FL.y + FR.y) / 2, (FL.z + FR.z) / 2);
      const dir = norm(add(add(v(0, 0, 0), norm(sub(Fm, S)), 0.8), gL, 0.2));
      const Pp = add(add(S, dir, 0.5), n, 0.03 + 0.1 * Math.sin(th));
      for (const [side, F] of [[-1, FL], [1, FR]]) { stances++; const hip = v(Pp.x + side * 0.1, Pp.y, Pp.z); if (len(sub(F, hip)) > 0.88) unreach++; }
    }
  }
  console.log(`V${g} ${P.angle}°  moves/problem ${(moves / N).toFixed(1)}  dyno ${(100 * dyno / moves).toFixed(0)}%  feetCut ${(100 * cut / moves).toFixed(0)}%  cross ${(100 * cross / moves).toFixed(0)}%  maxReach ${maxd.toFixed(2)}m  feetUnreachable ${(100 * unreach / stances).toFixed(0)}%  armsOverstretched ${(100 * armOver / (stances / 2)).toFixed(0)}%`);
}
