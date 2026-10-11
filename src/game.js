// DEADPOINT — game flow, input, HUD, camera, and choreography (what the climber does, when).
import * as THREE from 'three';
import { Session, TUNE, HOLD_TYPES, GRADES, gradeLabel, gradeParams, makeBoard, clamp, BOARD_H, BOARD_W, KICK_TOP, MAT_TOP, LADDER, migrateGrade } from './logic.js';
import { Sound } from './audio.js';
import { createWorld, gripPos as holdGrip, footPos, ROLE_HEX } from './world.js';
import { Climber } from './climber.js';
import { t, holdName, problemName, fmtLocale } from './i18n.js';

const V3 = THREE.Vector3;
const $ = (id) => document.getElementById(id);
const TEST = !!window.__DP_TEST;
const LOCK = TEST && !!window.__DP_LOCKSTEP; // test-only: fixed 1/60 s per frame
const TQ = (TEST && window.__DP_Q) || null;  // test-only quality override {tier, dpr, noRender}
const deg = (d) => (d * Math.PI) / 180;
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const smoothstep = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const easeOutBack = (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

const Q_TEXT = { perfect: t('perfect'), good: t('good'), ok: t('ok') };
const Q_COLOR = { perfect: '#ffffff', good: '#2ad4e0', ok: '#ffb02e', miss: '#ff5a3c' };
const TIERS = ['high', 'mid', 'low'];

const store = {
  get(k, d) { try { const v = localStorage.getItem('deadpoint:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('deadpoint:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

// grade indices in localStorage follow the ladder of the day they were written: 7b was added at
// index 8 (ladder 2), so older bests from 7b+ up move one step to keep their label
function migrateStore() {
  const from = store.get('ladder', 1);
  if (from >= LADDER) return;
  for (const k of ['bestG', 'startG']) { const g = store.get(k, null); if (typeof g === 'number') store.set(k, migrateGrade(g, from)); }
  store.set('ladder', LADDER);
}

export function startGame() {
  migrateStore();
  const sfx = new Sound();
  sfx.muted = !!store.get('muted', false);
  const BOARD_HOLDS = makeBoard();
  const HOLD_BY_ID = {};
  for (const h of BOARD_HOLDS) HOLD_BY_ID[h.id] = h;
  const gripPos = (id, out) => holdGrip(HOLD_BY_ID[id], out);

  // ===================== World + climber =====================
  let world;
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  let tierIdx = TIERS.indexOf((TQ && TQ.tier) || (coarse ? 'mid' : 'high'));
  sfx.tier = TIERS[tierIdx]; // before sfx.init(): the score drops layers on the low tier
  try {
    world = createWorld({
      canvas: $('scene'), holds: BOARD_HOLDS, quality: TIERS[tierIdx],
      test: { noRender: !!(TQ && TQ.noRender), quality: TQ && TQ.dpr ? { dpr: TQ.dpr } : null },
    });
  } catch (e) {
    $('fatal').hidden = false; $('title').hidden = true;
    return;
  }
  const { camera, wall } = world;
  const climber = new Climber(wall, { kickTop: KICK_TOP, matTop: MAT_TOP });

  // ===================== State =====================
  let angleFrom = 30, angleTo = 30, tiltT0 = 0, tiltDur = 0;
  let session = null, attempt = null;
  let mode = 'title'; // title | intro | climb | fallen | topped | over
  let paused = false;
  let simT = 0, lastFrame = performance.now();
  let introEnd = Infinity;
  let startG = store.get('startG', 0);
  let shakeAmp = 0, fovPunch = 0;
  let W = 1, H = 1;
  let feetOff = false, feetBackAt = 0, topT0 = 0, fallEndAt = Infinity;
  // timing aids: the body is the metronome (rock, rock, drive, apex), countdown beats on the rocks,
  // a glint + hand flash at the deadpoint, slow motion (and a first-time freeze) while learning
  let timeScale = 1;
  let tutorialLeft = store.get('tutorial', 3); // good/perfect catches still needed before slow-mo stops
  const TEACH = !TEST || !!window.__DP_TEACH;  // first catch ever: time stops at the apex until the tap
  let teachHold = false;
  let hitstop = 0, snapUntil = 0;
  let chalkAnim = null; // chalk bubble tapped: { t0, hand, puffed } (a hand goes to the bag)
  const beat = { key: -1, next: 0 };
  const cue = { key: -1, drive: false, hush: false };
  const apex = { key: -1, dp: 0, y: 0, t: 0, last: 0, log: [] }; // test: when the pelvis stops rising vs the deadpoint
  let timers = [];
  let fade = null;
  const demo = new Session({ board: BOARD_HOLDS, startGrade: 6, seed: 4242 });

  const after = (sec, fn) => timers.push({ at: simT + sec, fn });
  const clearTimers = () => { timers = []; };

  // climber callbacks → sound + juice
  climber.onStep = () => { if (mode === 'climb') sfx.footstep(); };
  climber.onChalk = (pos) => world.puff(pos, 4, 0.35);
  climber.onLand = (kind, v, pos) => {
    sfx.land(kind === 'drop' ? 0.55 : 1);
    world.padHit(simT);
    shake(kind === 'drop' ? 0.025 : 0.065);
    vibrate(kind === 'drop' ? 15 : 35);
    world.puff(pos, 8, 0.8);
    if (kind === 'fall') fallEndAt = Math.min(fallEndAt, simT + 0.85);
  };

  // ===================== Choreography =====================
  const CT = climber.input;
  const tA = new V3(), tB = new V3(), tC = new V3(), lookV = new V3(), camLocal = new V3();
  const BUP = new V3(0, 1, 0), NRM = new V3(0, 0, 1);
  // cubic bezier from a to b that arcs away from the wall
  function arcPath(out, a, b, e, lift = 0.14) {
    const u = 1 - e;
    tC.subVectors(b, a);
    const c1x = a.x + tC.x * 0.2, c1y = a.y + tC.y * 0.2, c1z = a.z + tC.z * 0.2 + lift;
    const c2x = b.x - tC.x * 0.15, c2y = b.y - tC.y * 0.15, c2z = b.z - tC.z * 0.15 + lift * 0.7;
    const w0 = u * u * u, w1 = 3 * u * u * e, w2 = 3 * u * e * e, w3 = e * e * e;
    return out.set(w0 * a.x + w1 * c1x + w2 * c2x + w3 * b.x, w0 * a.y + w1 * c1y + w2 * c2y + w3 * b.y, w0 * a.z + w1 * c1z + w2 * c2z + w3 * b.z);
  }
  // Deadpoint grammar, on the phase p of a timed move (0 = tap, 1 = deadpoint), beats at 1/3, 2/3, 1:
  //   ROCK 1 (bottom at 1/3, tic) → rebound → ROCK 2 (deepest at 2/3, tic) → DRIVE (hand lets go)
  //   → RISE: a parabola with zero velocity exactly at p = 1, the weightless apex (TAC).
  // The hips are springs (stiffer in flight), so the curve is sampled LEAD seconds ahead to put their
  // apex on the deadpoint (checked by the e2e flow test: median within 15 ms).
  const DRIVE = 2 / 3, LEAD = 0.12, FLIGHT_STIFF = 3.5;
  const _sinkP = new V3(), _sinkS = new V3();
  function bodyCurve(p, amp) {
    let s = 0, r = 0;
    if (p <= 0) return;
    if (p < 1 / 3) s = 0.64 * easeInOut(p * 3);
    else if (p < 0.5) s = 0.64 - 0.38 * easeInOut((p - 1 / 3) * 6);
    else if (p < DRIVE) s = 0.26 + 0.74 * easeInOut((p - 0.5) * 6);
    else { const u = (p - DRIVE) * 3; r = Math.max(-0.4, 1 - (1 - u) * (1 - u)); s = 1 - r; }
    const g = climber.g;
    // sink: down along gravity and away from the wall (arms straighten, knees bend)
    _sinkP.copy(g).multiplyScalar(0.11).addScaledVector(NRM, 0.1);
    _sinkS.copy(g).multiplyScalar(0.08).addScaledVector(NRM, 0.06);
    CT.driveP.addScaledVector(_sinkP, s * amp).addScaledVector(BUP, 0.12 * r * amp).addScaledVector(NRM, -0.09 * r * amp);
    CT.driveS.addScaledVector(_sinkS, s * amp).addScaledVector(BUP, 0.07 * r * amp).addScaledVector(NRM, -0.04 * r * amp);
  }
  // the reaching hand: stays on its hold through the rocks, shoots out at the drive, slows to a hover
  // just short of the hold and settles on it exactly at p = 1. Past the deadpoint it slides off.
  function reachHand(out, from, to, p, lift) {
    const u = (p - DRIVE) * 3;
    if (u <= 0) { out.copy(from); return; }
    tC.subVectors(from, to); tC.z = 0;
    const l = tC.length();
    if (l > 1e-4) tC.multiplyScalar(0.025 / l);
    lookV.copy(to).add(tC).addScaledVector(NRM, 0.035); // hover point, ~3-4 cm short
    // fast out of the drive (ease-out), the last 3-4 cm settle onto the hold exactly at p = 1,
    // when the whole body stops: hand, shoulders and hips come to rest together on the deadpoint
    if (u <= 1) {
      arcPath(out, from, lookV, Math.min(1, 1 - Math.pow(1 - u / 0.92, 2)), lift);
      out.addScaledVector(tC.subVectors(to, lookV), smoothstep((u - 0.8) / 0.2));
    } else out.copy(to).addScaledVector(climber.g, (u - 1) * 0.3).addScaledVector(NRM, (u - 1) * 0.1);
  }
  // the shoulders aim at the midpoint of the hands: feed them the reaching hand's path LEAD seconds
  // ahead too, so the body's springs settle on the deadpoint instead of trailing the hand
  const _hl = new V3(), _hn = new V3();
  function leadHand(from, to, pL, p, lift) {
    if (pL <= DRIVE) return;
    reachHand(_hl, from, to, Math.min(pL, 1), lift);
    reachHand(_hn, from, to, Math.min(p, 1), lift); // where the hand is now (`from` before the drive)
    CT.driveS.addScaledVector(_hl.sub(_hn), 0.5);
  }
  const splayAt = (p) => { const u = (p - DRIVE) * 3; return u <= 1 ? smoothstep((u - 0.72) / 0.18) : Math.max(0, 1 - (u - 1) * 4); };
  // flash intensity: builds over the good window before the deadpoint, peaks on it, fades in ~120 ms
  const cueAt = (tt, dp, wg) => (tt < dp - wg ? 0 : tt <= dp ? smoothstep((tt - dp + wg) / wg) : Math.exp(-(tt - dp) / 0.12));
  const floatAt = (p, tt, dp) => { const u = (p - DRIVE) * 3; return u < 1 ? smoothstep((u - 0.5) / 0.4) : Math.max(0, 1 - (tt - dp) / 0.25); };
  const setSplay = (side, v) => { if (side === 'L') CT.splayL = v; else CT.splayR = v; };
  const setFlash = (side, v) => { if (side === 'L') CT.flashL = v; else CT.flashR = v; };

  function driveClimber() {
    const A = attempt;
    if (!A) return;
    const pr = A.P, g = climber.g;
    gripPos(A.L, CT.HL); gripPos(A.R, CT.HR);
    if (A.L === A.R) { CT.HL.x -= 0.05; CT.HR.x += 0.05; }
    CT.drivenL = CT.drivenR = false; CT.gripL = CT.gripR = 1;
    const st = pr.stances[Math.min(A.stanceIdx, pr.stances.length - 1)];
    footPos(st.FL, CT.FL); footPos(st.FR, CT.FR);
    if (feetBackAt && simT >= feetBackAt) { feetBackAt = 0; feetOff = false; climber.E.FL.speed = climber.E.FR.speed = 0.6; }
    CT.feetOn = !feetOff;
    CT.driveS.set(0, 0, 0); CT.driveP.set(0, 0, 0); CT.stiff = 1; CT.lookBack = false;
    CT.splayL = CT.splayR = CT.flashL = CT.flashR = CT.flashF = CT.tailFloat = CT.feetSwing = 0;
    CT.gripRate = simT < snapUntil ? 40 : 18; CT.hipDrive = false;
    const nm = A.nextMove();
    CT.look = nm ? gripPos(nm.to, lookV) : null;
    let expr = A.energy < 30 ? 'effort' : A.energy < 55 ? 'focus' : 'calm';
    const setHand = (side, driven) => { if (side === 'L') { CT.drivenL = driven; CT.gripL = 0; } else { CT.drivenR = driven; CT.gripR = 0; } };
    if (mode === 'topped') {
      const fin = pr.moves[pr.moves.length - 1].to;
      gripPos(fin, CT.HL); CT.HL.x -= 0.06; gripPos(fin, CT.HR); CT.HR.x += 0.06;
      CT.look = wall.worldToLocal(camLocal.copy(camera.position));
      CT.lookBack = true;
      climber.setExpr('happy');
      return;
    }
    switch (A.state) {
      case 'flight': {
        const f = A.flight, mv = f.mv;
        const p = (simT - f.t0) / f.T;
        const Hh = mv.hand === 'L' ? CT.HL : CT.HR;
        bodyCurve((simT + LEAD - f.t0) / f.T, mv.jump ? 1.8 : mv.dyno ? 1.5 : 1);
        CT.stiff = FLIGHT_STIFF;
        tA.copy(Hh); gripPos(mv.to, tB);
        leadHand(tA, tB, (simT + LEAD - f.t0) / f.T, p, mv.dyno ? 0.1 : 0.14);
        if (p >= DRIVE) {
          reachHand(Hh, tA, tB, p, mv.dyno ? 0.1 : 0.14);
          setHand(mv.hand, true);
          setSplay(mv.hand, splayAt(p));
          if (mv.dyno) { CT.feetOn = false; CT.hipDrive = true; }
        }
        setFlash(mv.hand, cueAt(simT, f.dp, f.w.good));
        CT.tailFloat = floatAt(p, simT, f.dp);
        CT.look = gripPos(mv.to, lookV);
        expr = p > 1.04 ? 'ouch' : p >= DRIVE && mv.dyno ? 'effort' : 'focus';
        break;
      }
      case 'match': {
        const m = A.match, fin = pr.moves[pr.moves.length - 1];
        const other = fin.hand === 'L' ? 'R' : 'L';
        const Fh = fin.hand === 'L' ? CT.HL : CT.HR;
        Fh.x += fin.hand === 'L' ? -0.06 : 0.06;
        const Ho = other === 'L' ? CT.HL : CT.HR;
        const pm = (simT - m.t0) / m.T;
        // same grammar, smaller: two little rocks, the free hand rides a short hip rise to the top
        bodyCurve((simT + LEAD - m.t0) / m.T, 0.5);
        CT.stiff = FLIGHT_STIFF;
        tA.copy(Ho);
        gripPos(fin.to, tB); tB.x += other === 'L' ? -0.06 : 0.06;
        leadHand(tA, tB, (simT + LEAD - m.t0) / m.T, pm, 0.1);
        if (pm >= DRIVE) {
          reachHand(Ho, tA, tB, pm, 0.1);
          setHand(other, true);
          setSplay(other, splayAt(pm));
        }
        setFlash(other, cueAt(simT, m.dp, m.w.good));
        CT.tailFloat = floatAt(pm, simT, m.dp);
        CT.look = gripPos(fin.to, lookV);
        expr = 'focus';
        break;
      }
      case 'rest': {
        const holdHand = A.restHand, shake = holdHand === 'L' ? 'R' : 'L';
        const Hs = shake === 'L' ? CT.HL : CT.HR;
        const sg = shake === 'L' ? -1 : 1;
        Hs.copy(climber.S).addScaledVector(climber.right, sg * 0.26).addScaledVector(g, 0.5).addScaledVector(NRM, 0.12);
        Hs.addScaledVector(climber.right, Math.sin(simT * 24) * 0.035).addScaledVector(g, Math.cos(simT * 31) * 0.03);
        setHand(shake, true);
        CT.look = null;
        expr = 'rest';
        break;
      }
      case 'feet': {
        // feet cut: the legs swing out like a pendulum, turn at mid-time and come back to the wall
        // exactly on the deadpoint (sampled ahead: the dangling feet are soft springs)
        const ft = A.feet, T = ft.dp - ft.t0;
        const pf = (simT + 0.12 - ft.t0) / T;
        CT.feetOn = false;
        CT.feetSwing = 0.26 * Math.abs(Math.sin(Math.PI * clamp(pf, 0, 2)));
        CT.flashF = cueAt(simT, ft.dp, ft.w.good);
        CT.look = footPos(st.FL, lookV);
        expr = 'effort';
        break;
      }
      case 'hang': {
        // chalk up: one hand dips into the bag behind the hips, a pat and a puff, back on the hold
        const ca = chalkAnim, k = ca ? (simT - ca.t0) / 0.8 : 1;
        if (k < 1) {
          const Hc = ca.hand === 'L' ? CT.HL : CT.HR;
          const reach = Math.sin(Math.PI * clamp(k, 0, 1));
          tA.copy(climber.bagPos).addScaledVector(NRM, 0.03).addScaledVector(climber.g, -0.06);
          tA.addScaledVector(climber.right, Math.sin(simT * 30) * 0.015 * reach);
          Hc.lerp(tA, smoothstep(reach * 1.6));
          setHand(ca.hand, true);
          if (!ca.puffed && k > 0.45) { ca.puffed = true; world.puff(tA.clone(), 7, 0.6); }
        }
        break;
      }
    }
    climber.setExpr(expr);
  }

  // ===================== Flow =====================
  function fadeCut(fn) { fade = { t0: simT, fn, fired: false }; }
  function updateFade() {
    const el = $('fade');
    if (!fade) { if (el.style.opacity !== '0') el.style.opacity = '0'; return; }
    const t = simT - fade.t0;
    if (!fade.fired && t >= 0.18) { fade.fired = true; fade.fn(); }
    const o = t < 0.18 ? t / 0.18 : t < 0.26 ? 1 : Math.max(0, 1 - (t - 0.26) / 0.3);
    el.style.opacity = String(o);
    if (t >= 0.56) fade = null;
  }
  const fading = () => !!fade && simT - fade.t0 < 0.4;

  function safeStandZ(angleDeg) { return clamp((1.95 - KICK_TOP) * Math.tan(deg(angleDeg)) + 0.4, 0.5, 4.2); }
  function standWorld() { return wall.localToWorld(tA.copy(climber.stand.mid)); }
  function placeStandingAt(x, z) {
    const mid = wall.worldToLocal(tB.set(x, MAT_TOP, z));
    climber.placeStanding(mid);
    climber.stand.boardLook = new V3(0, BOARD_H * 0.5, 0.2);
    climber.stand.lookBack = false;
    climber.setExpr('calm');
  }

  function startSession(g) {
    sfx.init();
    sfx.setLevel(1);
    clearTimers(); fade = null;
    session = new Session({ board: BOARD_HOLDS, startGrade: g });
    startG = g; store.set('startG', g);
    $('title').hidden = true; $('over').hidden = true;
    $('hud').hidden = false; $('hint').hidden = false; $('controls').hidden = false;
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* not available */ }
    beginProblem(true);
  }

  function beginProblem(instant) {
    const pr = session.problem;
    const wasStanding = climber.mode === 'stand';
    mode = 'intro';
    attempt = null;
    world.lightProblem(pr, false);
    angleFrom = world.angle; angleTo = pr.angle;
    tiltT0 = simT; tiltDur = Math.abs(angleTo - angleFrom) < 0.5 ? 0 : clamp(Math.abs(angleTo - angleFrom) / 28, 0.5, 1.6);
    world.scheduleSweep(simT + tiltDur + 0.15);
    introEnd = simT + tiltDur + 0.15 + Object.keys(pr.roles).length * 0.065 + 0.45;
    // stand on the mat, clear of the board at both the old and the new angle
    const zSafe = safeStandZ(Math.max(angleFrom, angleTo));
    const sx = clamp((HOLD_BY_ID[pr.start.L].x + HOLD_BY_ID[pr.start.R].x) / 2 + 0.35, -1.6, 1.6);
    climber.faceWall();
    if (!wasStanding || instant) placeStandingAt(sx, zSafe + 0.15);
    else {
      const w = standWorld();
      if (w.z < zSafe || w.z > 4.4 || Math.abs(w.x) > 2.3) fadeCut(() => placeStandingAt(sx, zSafe + 0.15));
      else climber.stand.boardLook = new V3(0, BOARD_H * 0.5, 0.2);
    }
    showCard(pr);
    updateHud(true);
  }
  function finishIntro() {
    if (mode !== 'intro') return;
    tiltTo(angleTo);
    world.revealAll(simT);
    hideCard();
    beginAttempt();
  }
  function beginAttempt() {
    attempt = session.startAttempt();
    attempt.update(simT);
    mode = 'climb';
    feetOff = false; feetBackAt = 0; fallEndAt = Infinity;
    sfx.setLevel(session.combo >= TUNE.flowCombo ? 2 : 1);
    updateHud(true);
    fadeCut(() => placeAtStart());
  }
  function placeAtStart() {
    if (!attempt) return;
    driveClimber();
    climber.placeClimbing(CT);
    // settle into the start: body starts a little low and springs into place
    climber.P.addScaledVector(climber.g, 0.12);
    climber.S.addScaledVector(climber.g, 0.07);
    climber.enterUntil = simT + 0.4;
  }

  function endAttempt() {
    sfx.stopRest();
    clearTimers();
    const prevAttempt = attempt;
    const r = session.finishAttempt();
    if (r === 'over') { gameOver(); return; }
    if (r === 'retry') {
      const why = prevAttempt.fallReason === 'pump' ? t('whyPump') : prevAttempt.fallReason === 'early' ? t('whyEarly') : t('whyLate');
      toast(t('fell'), `${why} · ${t('attemptOf', session.attemptNo, TUNE.attempts)}`, '#ff5a3c', 1.4);
      updateHud(true);
      beginAttempt();
      return;
    }
    beginProblem(false);
  }

  function gameOver() {
    mode = 'over';
    sfx.setLevel(3);
    sfx.setPump(0);
    sfx.over();
    $('hud').hidden = true; $('hint').hidden = true; $('controls').hidden = true; hideCard();
    const best = session.bestG;
    const prevBest = store.get('bestScore', 0), prevG = store.get('bestG', -1);
    const newRecord = session.score > prevBest;
    if (newRecord) store.set('bestScore', session.score);
    if (best > prevG) store.set('bestG', best);
    $('overEyebrow').textContent = session.completed ? t('boardCleared') : t('sessionOver');
    $('overGrade').textContent = best >= 0 ? GRADES[best].f : '—';
    $('overSub').textContent = best >= 0
      ? t('topGrade', GRADES[best].f, gradeParams(best).angle) + (newRecord ? t('newRecord') : '')
      : t('noSends');
    $('overSends').innerHTML = session.log.map((l) => `<span class="${l.attempts === 1 ? 'fl' : ''}" title="${l.attempts === 1 ? 'Flash' : t('attemptsN', l.attempts)}">${GRADES[l.g].f}<small>${l.attempts === 1 ? 'flash' : t('attemptShort', l.attempts)}</small></span>`).join('');
    $('overScore').textContent = fmt(session.score);
    $('overFlash').textContent = String(session.log.filter((l) => l.attempts === 1).length);
    $('overBest').textContent = fmt(Math.max(prevBest, session.score));
    setSeg('overSeg', startG);
    $('over').hidden = false;
    updateRecordLine();
  }

  function goTitle() {
    paused = false; $('pause').hidden = true; tipEl.hidden = true; clearBubbles();
    mode = 'title';
    clearTimers(); fade = null;
    sfx.stopRest(); sfx.setPump(0); sfx.setLevel(0);
    $('hud').hidden = true; $('hint').hidden = true; $('controls').hidden = true; $('over').hidden = true; hideCard();
    $('title').hidden = false;
    showDemo();
  }
  function showDemo() {
    attempt = demo.startAttempt();
    const P = demo.problem, k = Math.min(2, P.moves.length - 2);
    for (let i = 0; i < k; i++) { const m = P.moves[i]; if (m.hand === 'L') attempt.L = m.to; else attempt.R = m.to; }
    attempt.moveIdx = k; attempt.stanceIdx = k;
    world.lightProblem(P, true);
    world.setAngle(P.angle);
    feetOff = false; feetBackAt = 0;
    driveClimber();
    climber.placeClimbing(CT);
  }

  // board tilt that keeps a standing climber upright in world space
  const _before = new THREE.Matrix4(), _rebase = new THREE.Matrix4();
  function tiltTo(a) {
    if (Math.abs(a - world.angle) < 1e-4) return;
    _before.copy(wall.matrixWorld);
    world.setAngle(a);
    if (climber.mode === 'stand') {
      _rebase.copy(wall.matrixWorld).invert().multiply(_before);
      climber.applyMatrix(_rebase);
    }
  }

  // ===================== Events → feedback =====================
  const popups = [], bursts = [];
  let ghostE = 100, ghostHold = 0, lastEnergyShown = -1;
  function processEvents() {
    if (!attempt || mode === 'title') { if (attempt) attempt.events.length = 0; return; }
    const evs = attempt.events.splice(0);
    const g = climber.g;
    for (const e of evs) {
      switch (e.type) {
        case 'launch': break; // the whoosh starts at the drive (see moveCues), not on the tap
        case 'catch': {
          noteTiming(e.off, e.q);
          const h = HOLD_BY_ID[e.mv.to];
          sfx.catchHold(e.q, e.combo, h.type);
          const pos = gripPos(e.mv.to, new V3());
          popup(pos, Q_TEXT[e.q], e.q === 'perfect' ? (e.combo >= 2 ? `×${e.combo}` : '') : timingNote(e.off), Q_COLOR[e.q], e.q === 'perfect' ? 1.15 : 0.95);
          // white/amber only: an LED-coloured ring on the hold reads as an LED (see CLAUDE.md)
          bursts.push({ pos, t0: simT, color: e.q === 'ok' ? Q_COLOR.ok : '#ffffff', big: e.q === 'perfect' });
          world.puff(pos, e.q === 'perfect' ? 9 : 6, e.q === 'ok' ? 1.3 : 1);
          climber.flash(e.mv.hand, e.q === 'perfect' ? 1 : 0.5);
          // perfect: the hand snaps shut and time sticks for a few frames (hitstop)
          if (e.q === 'perfect') { snapUntil = simT + 0.2; hitstop = 0.06; }
          // the catch loads the arms: the body sags and swings, more on a sloppy catch
          const sag = e.q === 'perfect' ? 0.35 : e.q === 'good' ? 0.7 : 1.3;
          tA.copy(g).multiplyScalar(sag);
          if (e.q === 'ok') tA.x += (e.mv.hand === 'L' ? 1 : -1) * 0.6;
          climber.kick(tA, 0.4);
          costFloat(-e.cost);
          if (e.q === 'perfect') { flash(0.16); fovPunch = 2.2; vibrate(16); } else vibrate(8);
          if (e.q === 'ok') shake(0.035);
          if (e.combo >= TUNE.flowCombo) sfx.setLevel(2);
          else if (e.q === 'ok') sfx.setLevel(1);
          break;
        }
        case 'miss': {
          noteTiming(e.off, 'miss');
          sfx.miss(e.reason);
          // too early: the hand closes into a fist in the air, short of the hold
          if (e.reason === 'early' && e.mv) climber.grip[e.mv.hand] = 1;
          const pos = e.mv ? gripPos(e.mv.to, new V3()) : climber.J.hR.clone();
          popup(pos, e.reason === 'early' ? t('tooEarly') : t('tooLate'), `${Math.round(Math.abs(e.off) * 1000)} ms`, Q_COLOR.miss, 1);
          vibrate(40);
          break;
        }
        case 'fall':
          climber.fall('fall', e.reason === 'early' ? tA.copy(BUP).multiplyScalar(0.3) : null);
          climber.setExpr('ouch');
          if (e.reason === 'pump') { popup(climber.S.clone(), t('pumped'), t('outOfEnergy'), Q_COLOR.miss, 1.1); sfx.miss('pump'); }
          sfx.fallWhoosh();
          sfx.stopRest();
          sfx.setLevel(1);
          mode = 'fallen';
          fallEndAt = simT + 3.5;
          break;
        case 'feetCut':
          feetOff = true;
          break;
        case 'feetCatch': {
          noteTiming(e.off, e.q);
          sfx.feet(e.q);
          feetOff = false;
          climber.E.FL.speed = climber.E.FR.speed = 0.45;
          const f = attempt.P.stances[attempt.stanceIdx].FL;
          const fp = footPos(f, new V3());
          popup(fp, e.q === 'perfect' ? t('feetBang') : t('feet'), e.q === 'perfect' ? '' : timingNote(e.off), Q_COLOR[e.q], 0.8);
          world.puff(fp, e.q === 'perfect' ? 8 : 5, 0.8);
          climber.flash('F', e.q === 'perfect' ? 1 : 0.5);
          climber.kick(tA.copy(g).multiplyScalar(0.25), 0.2);
          if (e.combo >= TUNE.flowCombo) sfx.setLevel(2);
          break;
        }
        case 'feetMiss': {
          noteTiming(e.off, 'miss');
          sfx.feetMiss();
          const f = attempt.P.stances[attempt.stanceIdx].FL;
          popup(footPos(f, new V3()), t('feetMissed'), t('energyCost', e.cost), Q_COLOR.miss, 0.8);
          costFloat(-e.cost);
          climber.kick(tA.copy(g).multiplyScalar(0.8).addScaledVector(NRM, 0.35), 0.3);
          shake(0.04);
          sfx.setLevel(1);
          feetBackAt = simT + 0.45;
          break;
        }
        case 'matchArm': sfx.matchCue(); break;
        case 'matchMiss': {
          noteTiming(e.off, 'miss');
          const fin = attempt.P.moves[attempt.P.moves.length - 1].to;
          popup(gripPos(fin, new V3()), t('matchMissed'), t('energyCost', e.cost), Q_COLOR.miss, 0.85);
          costFloat(-e.cost);
          sfx.miss('late');
          break;
        }
        case 'top': {
          noteTiming(e.off, e.q);
          sfx.top(e.flash);
          sfx.stopRest();
          const fin = attempt.P.moves[attempt.P.moves.length - 1].to;
          const pos = gripPos(fin, new V3());
          bursts.push({ pos, t0: simT, color: ROLE_HEX.finish, big: true });
          world.puff(pos, 14, 1.4);
          flash(0.22);
          vibrate([20, 40, 30]);
          mode = 'topped';
          topT0 = simT;
          feetOff = false;
          const st = attempt.stats;
          const moves = st.perfect + st.good + st.ok;
          const edge = e.energy < 15 ? t('onTheEdge') : '';
          toast(e.flash ? 'FLASH!' : 'TOP!', t('topLine', fmt(attempt.score), st.perfect, moves, edge), e.flash ? ROLE_HEX.foot : ROLE_HEX.finish, 2.4);
          after(0.95, () => { if (mode === 'topped') climber.fall('drop'); });
          // back on the mat she turns round and celebrates (climber 'celebrate'), then the next problem
          after(4.5, () => { if (mode === 'topped') endAttempt(); });
          break;
        }
        case 'bubble': sfx.bubble(e.b.kind); break;
        case 'bubbleTap': {
          sfx.pop(e.kind);
          vibrate(10);
          if (e.kind === 'chalk') {
            const st = attempt.state;
            if (st === 'hang') {
              // the hand on the worse hold goes to the bag (the other one holds on)
              const r = (id) => HOLD_TYPES[HOLD_BY_ID[id].type].win;
              chalkAnim = { t0: simT, hand: r(attempt.L) < r(attempt.R) ? 'L' : 'R', puffed: false };
            } else for (const h of ['hL', 'hR']) world.puff(climber.J[h].clone(), 4, 0.5);
            popup(climber.S.clone().addScaledVector(BUP, 0.25), t('chalkUp'), t('chalkSub', attempt.chalk), '#ffffff', 0.85);
          }
          if (e.kind === 'jump') {
            popup(climber.S.clone().addScaledVector(BUP, 0.3), t('jumpArmed'), t('jumpSub'), '#ffffff', 1.05);
            flash(0.1); fovPunch = 1.5;
            climber.kick(tA.copy(climber.g).multiplyScalar(0.4), 0.3); // she sinks, loading the jump
          }
          break;
        }
        case 'restStart': sfx.startRest(); break;
        case 'restEnd': sfx.stopRest(); break;
      }
    }
  }
  function noteTiming(off, q) {
    if (tutorialLeft > 0 && (q === 'perfect' || q === 'good')) {
      tutorialLeft--;
      store.set('tutorial', tutorialLeft);
      if (tutorialLeft === 0) toast(t('rhythm'), t('noSlowmo'), ROLE_HEX.start, 1.6);
    }
  }
  function timingNote(off) {
    const ms = Math.round(off * 1000);
    if (Math.abs(ms) < 12) return '';
    return ms < 0 ? t('early', -ms) : t('late', ms);
  }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* not allowed */ } }
  function shake(a) { shakeAmp = Math.max(shakeAmp, a); }
  const flashEl = $('flash');
  function flash(o) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    flashEl.style.transition = 'none'; flashEl.style.opacity = String(o);
    requestAnimationFrame(() => { flashEl.style.transition = 'opacity .28s ease-out'; flashEl.style.opacity = '0'; });
  }
  // popups stay attached to their spot on the board (re-projected every frame as the camera moves)
  function popup(localPos, text, sub, color, scale) {
    popups.push({ pos: localPos.clone(), text, sub, color, scale, t0: simT });
  }
  const costLayer = $('costLayer');
  function costFloat(v) {
    const bar = $('eBar').getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'cost' + (v > 0 ? ' plus' : '');
    el.textContent = (v > 0 ? '+' : '−') + Math.abs(Math.round(v));
    const x = bar.left + bar.width * clamp(attempt ? attempt.energy / 100 : 0.5, 0.05, 0.95);
    el.style.left = Math.round(x - 10) + 'px';
    el.style.top = Math.round(bar.bottom + 2) + 'px';
    costLayer.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  function activeTiming() {
    const A = attempt;
    if (!A || mode !== 'climb' || A.done) return null;
    if (A.state === 'flight' && A.flight) {
      const mv = A.flight.mv;
      return { kind: 'flight', key: A.flight.t0, t0: A.flight.t0, dp: A.flight.dp, w: A.flight.w, mv, hand: mv.hand, from: mv.hand === 'L' ? A.L : A.R };
    }
    if (A.state === 'feet' && A.feet) return { kind: 'feet', key: A.feet.t0, t0: A.feet.t0, dp: A.feet.dp, w: A.feet.w };
    if (A.state === 'match' && A.match) {
      const fin = A.P.moves[A.P.moves.length - 1], other = fin.hand === 'L' ? 'R' : 'L';
      return { kind: 'match', key: A.match.t0, t0: A.match.t0, dp: A.match.dp, w: A.match.w, hand: other, from: other === 'L' ? A.L : A.R };
    }
    return null;
  }
  // tic, tic, TAC on an even count from the tap (beat 0): the tics land on the bottoms of the two
  // rocks, the TAC exactly on the deadpoint (the apex). The second tic carries a short exhale (the drive).
  function scheduleBeats(src) {
    if (!src) return;
    if (beat.key !== src.key) { beat.key = src.key; beat.next = 0; }
    const b = (src.dp - src.t0) / 3;
    const times = [src.t0 + b, src.t0 + 2 * b, src.dp];
    while (beat.next < 3) {
      const bt = times[beat.next];
      const lead = (bt - simT) / Math.max(0.05, timeScale);
      if (bt < src.t0 + 0.03 || lead < -0.03) { beat.next++; continue; }
      if (lead > 0.12) break;
      sfx.tick(beat.next === 2, Math.max(0, lead));
      if (beat.next === 1 && sfx.ctx && !(src.mv && src.mv.dyno)) sfx.grunt(sfx.ctx.currentTime + Math.max(0, lead) + 0.004, 1.12, 0.05, 0.16);
      beat.next++;
    }
  }
  // one-shot cues of a timed move: at the drive the hand lets go (chalk puff, whoosh that builds
  // through the rise), and 40 ms before the deadpoint the whoosh cuts: silence, then the TAC
  function moveCues(src) {
    if (!src || src.kind === 'feet') return;
    if (cue.key !== src.key) { cue.key = src.key; cue.drive = false; cue.hush = false; }
    const T = src.dp - src.t0;
    if (!cue.drive && simT >= src.t0 + T * DRIVE) {
      cue.drive = true;
      const realLeft = (src.dp - simT) / (tutorialLeft > 0 ? 0.4 : 1);
      sfx.launch(!!(src.mv && src.mv.dyno), Math.max(0.1, realLeft - 0.04));
      if (src.from != null) world.puff(gripPos(src.from, new V3()), 4, 0.5);
    }
    if (!cue.hush && simT >= src.dp - 0.04) { cue.hush = true; sfx.stopWhoosh(); }
  }

  // ===================== Camera =====================
  const camFocus = new V3(0, 2, 1), camPos = new V3(0, 1.4, 5), focusTarget = new V3(), camDesired = new V3(), tmp = new V3(), tmp2 = new V3();
  let camInit = false, camSide = 1, camOrbit = 0;
  function updateCamera(dt, now) {
    const th = deg(world.angle), s = Math.sin(th);
    const portrait = W / H < 0.85;
    if (mode === 'title' || mode === 'over') {
      tmp.set(0, 1.7, 0.2); wall.localToWorld(focusTarget.copy(tmp));
      const a = Math.sin(now * 0.12) * 0.35;
      const dist = portrait ? 5.2 : 4.6;
      camDesired.set(focusTarget.x + Math.sin(a) * dist, Math.max(MAT_TOP + 0.7, focusTarget.y - 0.9 * s - 0.2), focusTarget.z + Math.cos(a) * dist);
    } else if (mode === 'intro') {
      tmp.set(0, BOARD_H * 0.52, 0.2); wall.localToWorld(focusTarget.copy(tmp));
      const dist = portrait ? 6.2 : 4.8;
      camDesired.set(0.3, Math.max(MAT_TOP + 0.7, focusTarget.y - 0.45 - 1.0 * s), focusTarget.z + dist - 1.0 * s);
    } else if (mode === 'topped' && climber.celebrating) {
      // celebration: frame her from the front, chest height, close enough to read the face
      wall.localToWorld(focusTarget.copy(climber.S));
      focusTarget.y -= 0.12;
      const dist = portrait ? 2.9 : 2.4;
      camDesired.set(focusTarget.x * 0.85 + 0.25, focusTarget.y + 0.05, focusTarget.z + dist);
    } else {
      if (climber.mode === 'fall' || climber.mode === 'stand') { tmp.copy(climber.P); tmp.y += 0.1; }
      else {
        tmp.copy(climber.S);
        const nm = attempt && attempt.nextMove();
        if (nm && mode === 'climb') { gripPos(nm.to, tmp2); tmp.lerp(tmp2, 0.4); }
        tmp.y = Math.min(tmp.y - 0.05, BOARD_H - 0.9);
      }
      wall.localToWorld(focusTarget.copy(tmp));
      if (climber.mode === 'stand' || climber.mode === 'fall') focusTarget.y = Math.max(focusTarget.y, MAT_TOP + 1.0);
      // far enough back that the whole body, the target hold and some board fit a portrait phone
      const dist = portrait ? 4.25 : 3.95;
      camDesired.set(focusTarget.x * 0.55, Math.max(MAT_TOP + 0.9, focusTarget.y - 0.15 - 0.75 * s), focusTarget.z + dist - 1.0 * s);
      // learning slow motion: dolly in and orbit to a 3/4 side view, on the side away from the
      // reaching hand, so the hips' sink-and-drive toward the wall is visible
      const src = activeTiming();
      if (src && src.hand) camSide = src.hand === 'L' ? 1 : -1;
      camOrbit += ((tutorialLeft > 0 && timeScale < 0.9 ? 1 : 0) - camOrbit) * (1 - Math.exp(-dt * 3));
      if (camOrbit > 0.001) {
        const a = deg(32) * camOrbit * camSide;
        const dx = camDesired.x - focusTarget.x, dz = camDesired.z - focusTarget.z;
        const k = 1 - 0.22 * camOrbit;
        camDesired.x = focusTarget.x + (dx * Math.cos(a) + dz * Math.sin(a)) * k;
        camDesired.z = focusTarget.z + (-dx * Math.sin(a) + dz * Math.cos(a)) * k;
      }
    }
    if (!camInit) { camFocus.copy(focusTarget); camPos.copy(camDesired); camInit = true; }
    camFocus.lerp(focusTarget, 1 - Math.exp(-dt * 4.5));
    camPos.lerp(camDesired, 1 - Math.exp(-dt * 3));
    camera.position.copy(camPos);
    if (shakeAmp > 0.0005) {
      camera.position.x += (Math.random() - 0.5) * shakeAmp;
      camera.position.y += (Math.random() - 0.5) * shakeAmp;
      shakeAmp *= Math.exp(-dt * 9);
    }
    camera.lookAt(camFocus);
    const baseFov = portrait ? 60 : 50;
    fovPunch *= Math.exp(-dt * 8);
    const fov = baseFov - fovPunch;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  // ===================== FX overlay (rings, popups) =====================
  const fx = $('fx'), fxc = fx.getContext('2d');
  let fxDpr = 1;
  const _pr = new V3(), _pr2 = new V3(), _camRight = new V3();
  function projectLocal(local) {
    _pr.copy(local); wall.localToWorld(_pr);
    _pr.project(camera);
    return { x: (_pr.x + 1) * 0.5 * W, y: (1 - _pr.y) * 0.5 * H, z: _pr.z };
  }
  function screenRadius(local, meters) {
    _pr.copy(local); wall.localToWorld(_pr);
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _pr2.copy(_pr).addScaledVector(_camRight, meters);
    _pr.project(camera); _pr2.project(camera);
    return Math.hypot((_pr2.x - _pr.x) * 0.5 * W, (_pr2.y - _pr.y) * 0.5 * H);
  }
  const FONT_D = '"Big Shoulders Display", "Arial Narrow", sans-serif';
  const FONT_U = '"Barlow Semi Condensed", "Segoe UI", sans-serif';
  const outlined = (ctx, text, x, y, fill, lw = 5) => { ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y); };
  // label under the target (hold type, LANCIO): no ring, no meter. The timing lives on the body.
  function drawLabel(local, label, sub) {
    const P = projectLocal(local);
    if (P.z > 1) return;
    const r0 = Math.max(16, screenRadius(local, 0.09));
    const ctx = fxc;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = `800 15px ${FONT_U}`; outlined(ctx, label, P.x, P.y + r0 + 6, '#ffffff', 4);
    if (sub) { ctx.font = `800 13px ${FONT_U}`; outlined(ctx, sub, P.x, P.y + r0 + 24, '#ffffff', 4); }
  }
  // deadpoint glint: a white 4-point sparkle with a dark outline on the top edge of the target.
  // Not a circle or a ring (LEDs are glows) and not an LED colour; readable on pale holds too.
  function drawGlint(local, k) {
    if (k < 0.02) return;
    const P = projectLocal(local);
    if (P.z > 1) return;
    const R = Math.max(14, screenRadius(local, 0.07)) * (0.55 + 0.6 * k), r = R * 0.22;
    const ctx = fxc;
    ctx.save();
    ctx.translate(P.x, P.y); ctx.rotate(0.12 + simT * 0.6);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, rr = i % 2 ? r : R;
      ctx.lineTo(Math.sin(a) * rr, -Math.cos(a) * rr);
    }
    ctx.closePath();
    ctx.globalAlpha = clamp(k * 1.4, 0, 1);
    ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(12,10,8,0.85)'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // learning overlay, anchored on the climber: "1", "2" at the hips on the tics, then the rule
  // during the rise, then "TOCCA ORA!" above the open hand
  function drawCoach(src) {
    const ctx = fxc;
    const T = src.dp - src.t0, p = (simT - src.t0) / T;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const hip = projectLocal(climber.P);
    for (const n of [1, 2]) {
      // fade out before the next beat, so the "2" is gone by the TAC
      const dt = simT - (src.t0 + (n * T) / 3), fade = Math.min(0.22, T / 4);
      if (dt < -0.04 || dt > fade) continue;
      const k = dt < 0 ? 1 + dt / 0.04 : 1 - dt / fade;
      ctx.globalAlpha = clamp(k, 0, 1);
      ctx.font = `900 ${Math.round(46 + 14 * clamp(1 - dt / 0.1, 0, 1))}px ${FONT_D}`;
      outlined(ctx, String(n), hip.x + (n === 1 ? -54 : 54), hip.y, '#ffffff', 7);
    }
    ctx.globalAlpha = 1;
    const inWin = Math.abs(simT - src.dp) <= src.w.good || teachHold;
    if (p >= DRIVE && simT < src.dp - src.w.good && !teachHold) {
      ctx.font = `800 18px ${FONT_U}`;
      outlined(ctx, t('tapApex'), hip.x, hip.y + 64, '#efe9dc', 5);
    }
    if (inWin && src.hand) {
      const hp = projectLocal(src.hand === 'L' ? climber.J.hL : climber.J.hR);
      const pulse = 1 + 0.08 * Math.sin(simT * 40 + performance.now() * 0.02);
      ctx.font = `900 ${Math.round(40 * pulse)}px ${FONT_D}`;
      ctx.textBaseline = 'bottom';
      outlined(ctx, t('tapNow'), clamp(hp.x, 110, W - 110), hp.y - 26, '#ffffff', 7);
    } else if (inWin && src.kind === 'feet') {
      ctx.font = `900 40px ${FONT_D}`;
      outlined(ctx, t('tapNow'), hip.x, hip.y + 70, '#ffffff', 7);
    }
  }
  function drawFX() {
    const ctx = fxc;
    ctx.clearRect(0, 0, W, H);
    const A = attempt;
    const src = activeTiming();
    if (src) {
      const k = cueAt(simT, src.dp, src.w.good);
      if (src.kind === 'flight') {
        const mv = A.flight.mv;
        const h = HOLD_BY_ID[mv.to];
        gripPos(mv.to, tmp);
        drawLabel(tmp, holdName(h.type).toUpperCase(), mv.jump ? t('jump') : mv.dyno ? t('dyno') : '');
        drawGlint(tmp.addScaledVector(BUP, 0.05).addScaledVector(NRM, 0.05), teachHold ? 1 : k);
      } else if (src.kind === 'feet') {
        footPos(A.P.stances[A.stanceIdx].FL, tmp);
        drawLabel(tmp, t('feet'), '');
        drawGlint(tmp.addScaledVector(BUP, 0.04).addScaledVector(NRM, 0.04), k);
      } else if (src.kind === 'match') {
        gripPos(A.P.moves[A.P.moves.length - 1].to, tmp);
        drawLabel(tmp, t('match'), '');
        drawGlint(tmp.addScaledVector(BUP, 0.05).addScaledVector(NRM, 0.05), k);
      }
      if (tutorialLeft > 0) drawCoach(src);
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i], k = (simT - b.t0) / (b.big ? 0.45 : 0.32);
      if (k >= 1) { bursts.splice(i, 1); continue; }
      const P = projectLocal(b.pos);
      const r0 = Math.max(16, screenRadius(b.pos, 0.085));
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = (b.big ? 7 : 4) * (1 - k) + 1;
      ctx.strokeStyle = b.color;
      ctx.beginPath(); ctx.arc(P.x, P.y, r0 * (1 + k * (b.big ? 2.6 : 1.6)), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const p = popups[i], k = (simT - p.t0) / 0.9;
      if (k >= 1) { popups.splice(i, 1); continue; }
      const pp = projectLocal(p.pos);
      p.x = pp.x; p.y = pp.y - 34;
      const sc = p.scale * (k < 0.15 ? easeOutBack(k / 0.15) : 1);
      const y = p.y - k * 26;
      ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = `900 ${Math.round(34 * sc)}px ${FONT_D}`;
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.fillStyle = p.color;
      const x = clamp(p.x, 90, W - 90);
      ctx.strokeText(p.text, x, y); ctx.fillText(p.text, x, y);
      if (p.sub) {
        ctx.font = `700 ${Math.round(14 * Math.max(1, sc * 0.9))}px ${FONT_U}`;
        ctx.lineWidth = 4; ctx.fillStyle = '#efe9dc';
        ctx.strokeText(p.sub, x, y + 18); ctx.fillText(p.sub, x, y + 18);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ===================== HUD =====================
  const hud = {
    grade: $('hudGrade'), angle: $('hudAngle'), score: $('hudScore'), combo: $('hudCombo'), name: $('hudName'),
    eNum: $('hudEnergyNum'), eFill: $('eFill'), eCap: $('eCap'), eGhost: $('eGhost'), pumpTag: $('pumpTag'),
    tries: $('tries').children, hint: $('hintText'), next: $('nextChip'), vignette: $('vignette'),
  };
  const fmt = (n) => Math.round(n).toLocaleString(fmtLocale);
  let lastHint = null, lastNext = null, lastScore = -1, lastCombo = -1, restLit = null;
  let frameDt = 0.016;
  function updateHud(force) {
    if (!session) return;
    const pr = session.problem;
    if (force) {
      hud.grade.textContent = gradeLabel(pr.grade);
      hud.angle.textContent = pr.angle + '°';
      hud.name.innerHTML = `${t('problemN', session.log.length + 1)} · <b>${problemName(pr)}</b>`;
      for (let i = 0; i < hud.tries.length; i++) {
        hud.tries[i].className = i + 1 < session.attemptNo ? 'used' : i + 1 === session.attemptNo ? 'now' : '';
      }
    }
    const A = attempt;
    const score = session.score + (A ? A.score : 0);
    if (score !== lastScore) { hud.score.textContent = fmt(score); lastScore = score; }
    const combo = A ? A.combo : session.combo;
    if (combo !== lastCombo) {
      hud.combo.textContent = combo >= TUNE.flowCombo ? `FLOW ×${combo}` : combo >= 2 ? `COMBO ×${combo}` : '';
      hud.combo.className = combo >= TUNE.flowCombo ? 'flow' : '';
      lastCombo = combo;
    }
    const e = A ? A.energy : 100, mx = A ? A.maxEnergy : 100;
    if (e < ghostE) { if (ghostHold <= 0) ghostE = Math.max(e, ghostE - 40 * frameDt); else ghostHold -= frameDt; }
    else { ghostE = e; ghostHold = 0.45; }
    if (Math.abs(e - lastEnergyShown) > 0.05 || force) {
      hud.eFill.style.transform = `scaleX(${clamp(e / 100, 0, 1)})`;
      hud.eGhost.style.transform = `scaleX(${clamp(ghostE / 100, 0, 1)})`;
      hud.eCap.style.width = `${clamp(100 - mx, 0, 100)}%`;
      hud.eFill.className = e < 25 ? 'crit' : e < 45 ? 'warn' : '';
      hud.eNum.textContent = Math.max(0, Math.ceil(e));
      lastEnergyShown = e;
    } else hud.eGhost.style.transform = `scaleX(${clamp(ghostE / 100, 0, 1)})`;
    const pump = A && mode === 'climb' && A.state !== 'ready' ? clamp((35 - e) / 35, 0, 1) : 0;
    hud.vignette.style.opacity = String(pump * 0.85);
    hud.pumpTag.style.opacity = pump > 0.15 ? String(0.6 + 0.4 * Math.sin(simT * 9)) : '0';
    sfx.setPump(pump);
    if (A && mode === 'climb') {
      // music follows the climb: progress, crux (last quarter, or the next move is a dyno / the longest)
      const mvs = A.P.moves, nm = mvs[A.moveIdx];
      if (A.P.maxD == null) A.P.maxD = Math.max(...mvs.map((m) => m.d));
      const crux = A.moveIdx >= mvs.length * 0.75 || !!(nm && (nm.dyno || nm.d >= A.P.maxD));
      sfx.setIntensity({ progress: A.moveIdx / mvs.length, crux, combo: A.combo, pump });
    }
    const canRest = !!(A && mode === 'climb' && A.canRest);
    if (canRest !== restLit) { restLit = canRest; restBtn.classList.toggle('lit', canRest); restBtn.setAttribute('aria-disabled', String(!canRest)); }
    if (canRest && A.energy < A.maxEnergy - 15) tip('rest', restBtn, t('tipRest'));
    if (A && mode === 'climb' && A.state === 'ready' && !fading()) tip('main', mainBtn, t('tipMain'));
    const hint = hintFor(A);
    if (hint !== lastHint) { hud.hint.textContent = hint; lastHint = hint; }
    const nx = nextChipFor(A);
    if (nx !== lastNext) { hud.next.innerHTML = nx; hud.next.style.visibility = nx ? 'visible' : 'hidden'; lastNext = nx; }
  }
  function hintFor(A) {
    if (!A || mode !== 'climb') return '';
    const learning = session.log.length < 2 && session.g <= 2;
    switch (A.state) {
      case 'ready': return session.log.length === 0 && session.attemptNo === 1 ? t('hintFirst') : t('hintStart');
      case 'flight': return '';
      case 'hang':
        if (A.energy < A.maxEnergy - 22 && A.canRest) return t('hintRest');
        if (A.energy < 35 && !A.canRest) return t('hintNoRest');
        return learning ? t('hintNext') : '';
      case 'rest': return t('hintShake');
      case 'feet': return t('hintFeet');
      case 'match': return t('hintMatch');
      default: return '';
    }
  }
  function nextChipFor(A) {
    if (!A || mode !== 'climb' || A.done) return '';
    const mv = A.nextMove();
    if (!mv) return '';
    const h = HOLD_BY_ID[mv.to];
    let s = `${mv.finish ? t('nextTop') : t('nextHold')}: <b>${holdName(h.type).toUpperCase()}</b>`;
    if (mv.jump) s += `<span class="tag">${t('jump')}</span>`;
    else if (mv.dyno) s += `<span class="tag">${t('dyno')}</span>`;
    if (mv.feetCut) s += `<span class="warn">${t('feetCut')}</span>`;
    return s;
  }

  // ===================== Bubbles (chalk, jump, allez) =====================
  // DOM buttons over the scene, kept inside the free area between the HUD and the bottom controls.
  // A bubble tap is its own input: it never reaches the main button.
  const bubLayer = $('bubbles');
  const bubEls = new Map(); // bubble object -> element
  const BUB_R = { chalk: 36, jump: 38 };
  const BUB_SPEED = { chalk: 22, jump: 170 }; // px/s
  function bubbleArea() {
    let bottom = Math.min(mainBtn.getBoundingClientRect().top, restBtn.getBoundingClientRect().top);
    for (const id of ['hintText', 'nextChip']) {
      const el = $(id), r = el.getBoundingClientRect();
      if (r.height > 0 && el.textContent && el.style.visibility !== 'hidden') bottom = Math.min(bottom, r.top);
    }
    return { left: 12, right: W - 12, top: $('hud').getBoundingClientRect().bottom + 10, bottom: bottom - 10 };
  }
  // random start (u, v) in the area, straight drift that bounces off its edges
  const bounce = (v, m) => { v = ((v % (2 * m)) + 2 * m) % (2 * m); return v > m ? 2 * m - v : v; };
  function bubbleXY(b, R, A) {
    const w = Math.max(1, A.right - A.left - 2 * R), h = Math.max(1, A.bottom - A.top - 2 * R);
    const age = Math.max(0, simT - b.t0), sp = BUB_SPEED[b.kind] || 0;
    return { x: A.left + R + bounce(b.u * w + Math.cos(b.a) * sp * age, w), y: A.top + R + bounce(b.v * h + Math.sin(b.a) * sp * age, h) };
  }
  const BUB_HTML = {
    // jump: a white arc that empties and a fast 3-2-1 inside (white = timing, never an LED colour)
    jump: () => `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="36" class="trk"/><circle cx="40" cy="40" r="36" class="arc" pathLength="100"/></svg><b>3</b><span>${t('bubJump')}</span>`,
    chalk: () => `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 12h14l-1.5 13a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8z"/><path d="M8 12c0-2 2-3 8-3s8 1 8 3"/><circle cx="12" cy="6" r="1.4"/><circle cx="17" cy="4.5" r="1.1"/><circle cx="21" cy="6.5" r="1.3"/></svg><span>${t('bubChalk')}</span>`,
  };
  function makeBubble(b) {
    const el = document.createElement('button');
    el.className = 'bubble ' + b.kind;
    el.tabIndex = -1;
    el.setAttribute('aria-label', t('bubAria_' + b.kind));
    el.innerHTML = BUB_HTML[b.kind] ? BUB_HTML[b.kind](b) : '';
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (paused || !attempt || el.dataset.popped) return;
      if (attempt.tapBubble(b.kind, evTime(e))) { el.dataset.popped = '1'; el.classList.add('pop'); }
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    bubLayer.appendChild(el);
    return el;
  }
  function dropBubble(b, el) {
    bubEls.delete(b);
    if (el.dataset.popped) setTimeout(() => el.remove(), 260); // the pop animation plays out
    else el.remove();
  }
  function syncBubbles() {
    const A = attempt;
    const live = A && mode === 'climb' && !A.done ? A.bubbles : {};
    for (const [b, el] of bubEls) if (live[b.kind] !== b || el.dataset.popped) dropBubble(b, el);
    let area = null;
    for (const k in live) {
      const b = live[k];
      let el = bubEls.get(b), fresh = false;
      if (!el) { el = makeBubble(b); bubEls.set(b, el); fresh = true; }
      area = area || bubbleArea();
      const R = BUB_R[k] || 36, p = bubbleXY(b, R, area);
      el.style.transform = `translate(${Math.round(p.x - R)}px, ${Math.round(p.y - R)}px)`;
      const left = b.t0 + b.life - simT;
      if (k === 'jump') {
        const f = clamp(left / b.life, 0, 1), n = Math.max(1, Math.ceil(f * 3));
        el.querySelector('.arc').style.strokeDashoffset = String(100 * (1 - f));
        if (el.dataset.n !== String(n)) { el.dataset.n = String(n); el.querySelector('b').textContent = String(n); if (!fresh) sfx.countTick(n); }
        el.style.opacity = String(clamp(left / 0.12, 0, 1));
      } else el.style.opacity = String(clamp(left / 0.35, 0, 1));
      if (fresh) tip('bubble_' + k, el, t('tip_' + k));
    }
  }
  function clearBubbles() { for (const [b, el] of bubEls) { el.remove(); bubEls.delete(b); } }

  // ===================== One-time tips (new controls and bubbles) =====================
  // a small callout next to the thing it explains, shown once ever per key (localStorage deadpoint:tips)
  const tipEl = $('tip'), tipsSeen = store.get('tips', {});
  let tipUntil = 0;
  function tip(key, anchor, text) {
    if (tipsSeen[key] || (TEST && !window.__DP_TIPS) || !tipEl.hidden) return; // one at a time: the next waits
    tipsSeen[key] = 1; store.set('tips', tipsSeen);
    tipEl.textContent = text;
    tipEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const tw = Math.min(240, W - 32);
    tipEl.style.width = tw + 'px';
    const th = tipEl.offsetHeight || 60, hudB = $('hud').getBoundingClientRect().bottom + 6;
    tipEl.style.left = Math.round(clamp(r.left + r.width / 2 - tw / 2, 16, W - 16 - tw)) + 'px';
    // above the anchor, or below it when that would cover the HUD
    tipEl.style.top = Math.round(r.top - th - 10 >= hudB ? r.top - th - 10 : r.bottom + 10) + 'px';
    tipEl.classList.remove('show'); void tipEl.offsetWidth; tipEl.classList.add('show');
    tipUntil = simT + 3.2;
  }

  // ===================== Cards & toasts =====================
  const cardEl = $('card'), toastEl = $('toast');
  function showCard(pr) {
    const num = session.log.length + 1;
    cardEl.innerHTML = `<div class="card-in"><div class="n">${t('cardHead', num, session.attemptNo, TUNE.attempts)}</div>`
      + `<div class="t">${problemName(pr)}</div><div class="s">${gradeLabel(pr.grade)} <span>${t('cardSub', pr.angle, pr.moves.length)}</span></div>`
      + `<div class="tap">${t('tapToStart')}</div></div>`;
    cardEl.hidden = false;
    hud.name.style.visibility = 'hidden';
  }
  function hideCard() { cardEl.hidden = true; hud.name.style.visibility = 'visible'; }
  let toastUntil = 0;
  function toast(big, small, color, dur) {
    $('toastBig').textContent = big; $('toastBig').style.color = color;
    $('toastSmall').textContent = small || '';
    toastEl.hidden = false;
    toastEl.classList.remove('show'); void toastEl.offsetWidth; toastEl.classList.add('show');
    toastUntil = simT + dur;
  }

  // ===================== Input =====================
  const mainBtn = $('btnMain');
  function evTime(e) {
    if (LOCK) return simT;
    const now = performance.now();
    const ts = e && e.timeStamp;
    const pt = ts > 0 && Math.abs(now - ts) < 1000 ? ts : now;
    return simT + ((pt - lastFrame) / 1000) * (hitstop > 0 || teachHold ? 0 : timeScale);
  }
  function onPress(t) {
    if (paused) return;
    if (mode === 'intro') { finishIntro(); return; }
    if (mode === 'climb' && attempt) {
      if (fading() || climber.entering) return;
      attempt.press(t);
    } else if (mode === 'topped' && simT - topT0 > 0.8) { toastEl.hidden = true; endAttempt(); }
  }
  // one big button does one thing: launch / catch / feet / match (and starts the problem, skips the top)
  mainBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    mainBtn.classList.remove('hit'); void mainBtn.offsetWidth; mainBtn.classList.add('hit');
    onPress(evTime(e));
  }, { passive: false });
  mainBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  // rest button: lit only while hanging with a hand on a jug; mash it to shake out
  const restBtn = $('btnRest');
  restBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (paused || mode !== 'climb' || !attempt || fading() || climber.entering) return;
    if (attempt.shake(evTime(e)) > 0 || attempt.state === 'rest') { restBtn.classList.remove('hit'); void restBtn.offsetWidth; restBtn.classList.add('hit'); }
  }, { passive: false });
  restBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  const KEYS = new Set(['Space', 'Enter', 'ArrowUp', 'KeyJ']);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'KeyP') { if (mode === 'climb' || mode === 'intro') togglePause(!paused); return; }
    if (!KEYS.has(e.code) || e.repeat) return;
    if (mode === 'climb' || mode === 'intro' || mode === 'topped') { e.preventDefault(); onPress(evTime(e)); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (mode === 'climb' || mode === 'intro')) togglePause(true); });

  function togglePause(on) {
    paused = on;
    if (on && session) $('pauseEyebrow').textContent = `${problemName(session.problem)} · ${gradeLabel(session.problem.grade)} · ${session.problem.angle}°`;
    $('pause').hidden = !on;
    $('btnMute').textContent = sfx.muted ? t('soundOff') : t('soundOn');
    sfx.pause(on);
  }
  function setSeg(id, g) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.g === g));
  }
  for (const id of ['startSeg', 'overSeg']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      startG = +b.dataset.g; setSeg('startSeg', startG); setSeg('overSeg', startG);
      sfx.init(); sfx.ui();
    });
  }
  $('btnStart').addEventListener('click', () => { sfx.init(); sfx.ui(); startSession(startG); });
  $('btnAgain').addEventListener('click', () => { sfx.init(); sfx.ui(); startSession(startG); });
  $('btnPause').addEventListener('click', (e) => { e.stopPropagation(); togglePause(true); });
  $('btnResume').addEventListener('click', () => { togglePause(false); sfx.ui(); });
  $('btnMute').addEventListener('click', () => {
    sfx.init(); sfx.setMuted(!sfx.muted); store.set('muted', sfx.muted);
    $('btnMute').textContent = sfx.muted ? t('soundOff') : t('soundOn');
  });
  $('btnQuit').addEventListener('click', () => { sfx.pause(false); goTitle(); });
  function updateRecordLine() {
    const bs = store.get('bestScore', 0), bg = store.get('bestG', -1);
    $('recordLine').innerHTML = bs > 0
      ? t('recordLine', bg >= 0 ? gradeLabel(bg) : '—', fmt(bs))
      : t('introLine');
  }
  setSeg('startSeg', startG); setSeg('overSeg', startG);
  updateRecordLine();

  // ===================== Resize & loop =====================
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    world.resize(W, H);
    fxDpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = Math.round(W * fxDpr); fx.height = Math.round(H * fxDpr);
    fxc.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  let fpsAcc = 0, fpsN = 0, fpsAvg = 60;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;
    if (LOCK) dt = 1 / 60;
    frameDt = dt;
    const frozen = paused || (TEST && window.__DP_FREEZE);
    // slow motion from just before the drive to the end of the window, until the player has the
    // rhythm; the very first catch ever freezes on the apex pose until the tap
    const src0 = activeTiming();
    let tsTarget = 1, holdAt = null;
    if (src0 && tutorialLeft > 0) {
      const p = (simT - src0.t0) / Math.max(0.05, src0.dp - src0.t0);
      if (p > 0.6 && simT < src0.dp + src0.w.ok) tsTarget = 0.4;
      if (TEACH && tutorialLeft >= 3 && src0.kind === 'flight' && mode === 'climb') holdAt = src0.dp + session.latency;
    }
    timeScale += (tsTarget - timeScale) * (1 - Math.exp(-dt * 14));
    if (tsTarget === 1 && timeScale > 0.985) timeScale = 1;
    let sdt = dt * timeScale;
    if (hitstop > 0) { if (!frozen) hitstop -= dt; sdt = 0; }
    if (!frozen) simT += sdt;
    teachHold = holdAt !== null && simT >= holdAt;
    if (teachHold) { simT = holdAt; timeScale = 0; }
    if (session) session.freezeCalib = timeScale < 0.99;
    // performance guard: step quality down while playing if the device struggles
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 3) {
      fpsAvg = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
      if (!TEST && fpsAvg < 45 && tierIdx < TIERS.length - 1 && (mode === 'climb' || mode === 'intro')) {
        tierIdx++;
        world.setQuality(TIERS[tierIdx]);
        resize();
      }
    }
    if (!frozen) {
      if (mode === 'intro') {
        const k = tiltDur > 0 ? clamp((simT - tiltT0) / tiltDur, 0, 1) : 1;
        tiltTo(angleFrom + (angleTo - angleFrom) * easeInOut(k));
        if (simT >= introEnd) finishIntro();
      }
      if (attempt && (mode === 'climb' || mode === 'title')) attempt.update(simT);
      processEvents();
      for (let i = 0; i < timers.length; i++) {
        const tm = timers[i];
        if (simT >= tm.at) { timers.splice(i, 1); i--; tm.fn(); }
      }
      if (mode === 'fallen' && simT >= fallEndAt) { fallEndAt = Infinity; endAttempt(); }
      if (!toastEl.hidden && simT >= toastUntil) toastEl.hidden = true;
      if (!tipEl.hidden && simT >= tipUntil) tipEl.hidden = true;
      updateFade();
      if (climber.mode === 'climb' && (mode === 'climb' || mode === 'title' || mode === 'topped')) driveClimber();
      if (climber.mode === 'stand') {
        // now and then glance back at the camera over the shoulder, with a smile; after a top she
        // has turned round and looks straight at it
        const cel = climber.celebrating;
        const glance = !cel && (simT % 5.2) > 3.6;
        climber.stand.lookBack = glance;
        climber.stand.look = cel || glance ? wall.worldToLocal(camLocal.copy(camera.position)) : (climber.stand.boardLook || null);
        climber.setExpr(cel || glance ? 'happy' : 'calm');
      }
      climber.update(sdt, simT, world.angle);
      if (TEST) trackApex();
      world.updateChalk(sdt);
      const src1 = activeTiming();
      scheduleBeats(src1);
      moveCues(src1);
      const nextId = attempt && mode === 'climb' && !attempt.done && attempt.nextMove() ? attempt.nextMove().to : null;
      world.updateLit(simT, nextId, (L) => { if (mode === 'intro') sfx.ledBlip(L.order); });
      world.updatePads(simT);
    }
    if (mode !== 'title') updateHud(false);
    syncBubbles();
    updateCamera(dt, now / 1000);
    world.render();
    drawFX();
  }

  // test: when the pelvis stops rising (highest board y, i.e. velocity zero) relative to the deadpoint.
  // Logged for flights still running 40 ms past the deadpoint, so a catch does not cut the curve.
  function trackApex() {
    const A = attempt;
    const f = A && mode === 'climb' && A.state === 'flight' && climber.mode === 'climb' ? A.flight : null;
    if (apex.key !== -1 && (!f || f.t0 !== apex.key)) {
      if (apex.last >= apex.dp + 0.04) {
        apex.log.push(+(apex.t - apex.dp).toFixed(4));
        if (apex.log.length > 200) apex.log.shift();
      }
      apex.key = -1;
    }
    if (!f) return;
    const p = (simT - f.t0) / f.T, y = climber.P.y;
    if (apex.key !== f.t0) { apex.key = f.t0; apex.dp = f.dp; apex.y = -Infinity; apex.t = 0; }
    if (p > 0.75 && y > apex.y) { apex.y = y; apex.t = simT; }
    apex.last = simT;
  }

  // test hooks (only when the test harness sets window.__DP_TEST before load)
  if (TEST) {
    window.__DP = {
      get session() { return session; }, get attempt() { return attempt; }, get mode() { return mode; },
      get simT() { return simT; }, get fps() { return fpsAvg; }, get paused() { return paused; },
      get busy() { return fading() || climber.entering; },
      get timeScale() { return timeScale; }, get tutorialLeft() { return tutorialLeft; }, set tutorialLeft(v) { tutorialLeft = v; },
      get quality() { return world.quality; }, get apexLog() { return apex.log; }, get teachHold() { return teachHold; },
      start: (g) => startSession(g || 0), skip: () => finishIntro(), sfx, Sound, climber, world,
      TUNE, HOLD_TYPES,
    };
  }

  world.setAngle(30);
  showDemo();
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
}
