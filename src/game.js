// DEADPOINT — game flow, input, HUD, camera, and choreography (what the climber does, when).
import * as THREE from 'three';
import { Session, TUNE, HOLD_TYPES, GRADES, gradeLabel, gradeParams, makeBoard, clamp, BOARD_H, BOARD_W, KICK_TOP, MAT_TOP } from './logic.js';
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
const easeOutBack = (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

const Q_TEXT = { perfect: t('perfect'), good: t('good'), ok: t('ok') };
const Q_COLOR = { perfect: '#ffffff', good: '#2ad4e0', ok: '#ffb02e', miss: '#ff5a3c' };
const TIERS = ['high', 'mid', 'low'];

const store = {
  get(k, d) { try { const v = localStorage.getItem('deadpoint:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('deadpoint:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

export function startGame() {
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
  // timing aids: bottom meter, countdown beats, slow-motion while learning
  let timeScale = 1;
  let tutorialLeft = store.get('tutorial', 3); // good/perfect catches still needed before slow-mo stops
  const meter = { src: null, last: null };
  const beat = { key: -1, next: 0 };
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
        tA.copy(Hh);
        gripPos(mv.to, tB);
        // the hand decelerates into the hold: velocity ~0 exactly at the deadpoint (p = 1)
        const e = p <= 1 ? 1 - Math.pow(1 - clamp(p, 0, 1), 1.6) : 1;
        arcPath(Hh, tA, tB, e, mv.dyno ? 0.1 : 0.14);
        if (p > 1) Hh.addScaledVector(g, (p - 1) * 0.9).addScaledVector(NRM, (p - 1) * 0.3);
        setHand(mv.hand, true);
        // body: quick sink (load), then hips drive up and into the wall, apex at the deadpoint
        const k = p <= 1 ? 1 - Math.pow(1 - clamp(p, 0, 1), 2) : Math.max(0, 1 - (p - 1) * 3);
        const dip = p < 0.14 ? Math.sin((Math.PI * Math.max(0, p)) / 0.14) : 0;
        const amp = mv.dyno ? 1.5 : 1;
        CT.driveS.addScaledVector(BUP, 0.05 * k * amp).addScaledVector(NRM, -0.03 * k * amp).addScaledVector(g, 0.035 * dip);
        CT.driveP.addScaledVector(BUP, 0.09 * k * amp).addScaledVector(NRM, -0.09 * k * amp).addScaledVector(g, 0.06 * dip);
        CT.stiff = 1.5;
        if (mv.dyno && p > 0.3) CT.feetOn = false;
        CT.look = gripPos(mv.to, lookV);
        expr = mv.dyno ? 'effort' : 'focus';
        break;
      }
      case 'match': {
        const m = A.match, fin = pr.moves[pr.moves.length - 1];
        const other = fin.hand === 'L' ? 'R' : 'L';
        const Fh = fin.hand === 'L' ? CT.HL : CT.HR;
        Fh.x += fin.hand === 'L' ? -0.06 : 0.06;
        const Ho = other === 'L' ? CT.HL : CT.HR;
        const pm = (simT - m.t0) / m.T;
        if (pm > 0) {
          tA.copy(Ho);
          gripPos(fin.to, tB); tB.x += other === 'L' ? -0.06 : 0.06;
          const e = pm <= 1 ? 1 - Math.pow(1 - pm, 1.6) : 1;
          arcPath(Ho, tA, tB, e, 0.1);
          if (pm > 1) Ho.addScaledVector(g, (pm - 1) * 0.5);
          setHand(other, true);
        }
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
      case 'feet':
        CT.feetOn = false;
        CT.look = footPos(st.FL, lookV);
        expr = 'effort';
        break;
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
    $('hud').hidden = false; $('hint').hidden = false;
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
    $('hud').hidden = true; $('hint').hidden = true; hideCard();
    const best = session.bestG;
    const prevBest = store.get('bestScore', 0), prevG = store.get('bestG', -1);
    const newRecord = session.score > prevBest;
    if (newRecord) store.set('bestScore', session.score);
    if (best > prevG) store.set('bestG', best);
    $('overEyebrow').textContent = session.completed ? t('boardCleared') : t('sessionOver');
    $('overGrade').textContent = best >= 0 ? GRADES[best].f : '—';
    $('overSub').textContent = best >= 0
      ? t('topGrade', GRADES[best].f, GRADES[best].v, gradeParams(best).angle) + (newRecord ? t('newRecord') : '')
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
    paused = false; $('pause').hidden = true;
    mode = 'title';
    clearTimers(); fade = null;
    sfx.stopRest(); sfx.setPump(0); sfx.setLevel(0);
    $('hud').hidden = true; $('hint').hidden = true; $('over').hidden = true; hideCard();
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
        case 'launch':
          sfx.launch(e.mv.dyno, e.T);
          break;
        case 'catch': {
          noteTiming(e.off, e.q);
          const h = HOLD_BY_ID[e.mv.to];
          sfx.catchHold(e.q, e.combo, h.type);
          const pos = gripPos(e.mv.to, new V3());
          popup(pos, Q_TEXT[e.q], e.q === 'perfect' ? (e.combo >= 2 ? `×${e.combo}` : '') : timingNote(e.off), Q_COLOR[e.q], e.q === 'perfect' ? 1.15 : 0.95);
          bursts.push({ pos, t0: simT, color: e.q === 'perfect' ? ROLE_HEX[e.mv.finish ? 'finish' : 'hand'] : Q_COLOR[e.q], big: e.q === 'perfect' });
          world.puff(pos, e.q === 'perfect' ? 9 : 6, e.q === 'ok' ? 1.3 : 1);
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
          popup(footPos(f, new V3()), e.q === 'perfect' ? t('feetBang') : t('feet'), e.q === 'perfect' ? '' : timingNote(e.off), Q_COLOR[e.q], 0.8);
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
          after(2.8, () => { if (mode === 'topped') endAttempt(); });
          break;
        }
        case 'restStart': sfx.startRest(); break;
        case 'restEnd': sfx.stopRest(); break;
      }
    }
  }
  function noteTiming(off, q) {
    if (meter.src) meter.last = { src: meter.src, off, q, at: simT };
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
  function popup(localPos, text, sub, color, scale) {
    const p = projectLocal(localPos);
    popups.push({ x: p.x, y: p.y - 34, text, sub, color, scale, t0: simT });
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
      return { key: A.flight.t0, t0: A.flight.t0, dp: A.flight.dp, w: A.flight.w, color: ROLE_HEX[mv.finish ? 'finish' : 'hand'] };
    }
    if (A.state === 'feet' && A.feet) return { key: A.feet.t0, t0: A.feet.t0, dp: A.feet.dp, w: A.feet.w, color: ROLE_HEX.foot };
    if (A.state === 'match' && A.match) return { key: A.match.t0, t0: A.match.t0, dp: A.match.dp, w: A.match.w, color: ROLE_HEX.finish };
    return null;
  }
  // tic, tic, TAC: the TAC lands exactly on the deadpoint
  function scheduleBeats(src) {
    if (!src) return;
    if (beat.key !== src.key) { beat.key = src.key; beat.next = 0; }
    const b = clamp((src.dp - src.t0) / 3, 0.14, 0.28);
    const times = [src.dp - 2 * b, src.dp - b, src.dp];
    while (beat.next < 3) {
      const bt = times[beat.next];
      const lead = (bt - simT) / Math.max(0.05, timeScale);
      if (bt < src.t0 + 0.03 || lead < -0.03) { beat.next++; continue; }
      if (lead > 0.12) break;
      sfx.tick(beat.next === 2, Math.max(0, lead));
      beat.next++;
    }
  }

  // ===================== Camera =====================
  const camFocus = new V3(0, 2, 1), camPos = new V3(0, 1.4, 5), focusTarget = new V3(), camDesired = new V3(), tmp = new V3(), tmp2 = new V3();
  let camInit = false;
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
    } else {
      if (climber.mode === 'fall' || climber.mode === 'stand') { tmp.copy(climber.P); tmp.y += 0.1; }
      else {
        tmp.copy(climber.S);
        const nm = attempt && attempt.nextMove();
        if (nm && mode === 'climb') { gripPos(nm.to, tmp2); tmp.lerp(tmp2, 0.45); }
        tmp.y = Math.min(tmp.y + 0.22, BOARD_H - 0.8);
      }
      wall.localToWorld(focusTarget.copy(tmp));
      if (climber.mode === 'stand' || climber.mode === 'fall') focusTarget.y = Math.max(focusTarget.y, MAT_TOP + 1.0);
      const dist = portrait ? 3.45 : 3.55;
      camDesired.set(focusTarget.x * 0.55, Math.max(MAT_TOP + 0.6, focusTarget.y - 0.3 - 0.95 * s), focusTarget.z + dist - 1.0 * s);
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
  function mixHex(h1, h2, k) {
    const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    const r = Math.round(((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k);
    const gg = Math.round(((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k);
    const bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
    return `rgb(${r},${gg},${bl})`;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  const outlined = (ctx, text, x, y, fill, lw = 5) => { ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y); };
  // marker on the target hold: a white ring that closes onto it exactly at the deadpoint
  function drawRing(local, src, label, sub) {
    const P = projectLocal(local);
    if (P.z > 1) return;
    const r0 = Math.max(18, screenRadius(local, 0.1));
    const p = (simT - src.t0) / (src.dp - src.t0);
    if (p < 0) return;
    const ctx = fxc;
    const inWin = Math.abs(simT - src.dp) <= src.w.good;
    const r = p <= 1 ? r0 * (1 + 2.2 * (1 - p)) : r0 * Math.max(0.4, 1 - (p - 1) * 2);
    ctx.globalAlpha = clamp(p * 4, 0, 1) * (p > 1 ? Math.max(0, 1 - (p - 1) * 2.5) : 1);
    if (inWin) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(P.x, P.y, r0 * 1.02, 0, Math.PI * 2); ctx.fill(); }
    ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(P.x, P.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 4.5; ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(P.x, P.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    if (inWin) { ctx.textBaseline = 'bottom'; ctx.font = `900 30px ${FONT_D}`; outlined(ctx, t('nowBang'), P.x, P.y - r0 - 8, '#ffffff', 6); }
    if (label) {
      ctx.textBaseline = 'top';
      ctx.font = `800 15px ${FONT_U}`; outlined(ctx, label, P.x, P.y + r0 + 8, '#ffffff', 4);
      if (sub) { ctx.font = `800 13px ${FONT_U}`; outlined(ctx, sub, P.x, P.y + r0 + 26, ROLE_HEX.foot, 4); }
    }
  }
  // the timing meter: the cursor runs left to right and hits the white ORA zone at the deadpoint
  const Q_SHORT = { perfect: t('perfect'), good: t('good'), ok: t('ok'), miss: t('miss') };
  function drawMeter(src, result) {
    const ctx = fxc;
    const w = Math.min(W - 48, 440), h = 22;
    const x = (W - w) / 2, y = H - safeBottom - 152;
    const c = src.dp - src.t0;
    const span = Math.max(0.2, c / 0.78);
    const X = (sec) => x + w * clamp(sec / span, 0, 1);
    const fadeK = result ? clamp(1 - (simT - result.at - 0.45) / 0.3, 0, 1) : 1;
    ctx.globalAlpha = fadeK;
    ctx.fillStyle = 'rgba(8,10,15,0.8)'; rrect(ctx, x - 3, y - 3, w + 6, h + 6, 13); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(239,233,220,0.3)'; ctx.stroke();
    const zone = (half, fill) => { const a = X(c - half), b = X(c + half); ctx.fillStyle = fill; ctx.fillRect(a, y + 2, Math.max(3, b - a), h - 4); };
    zone(src.w.ok, 'rgba(255,176,46,0.55)');
    zone(src.w.good, hexA(src.color, 0.9));
    zone(src.w.perfect, '#ffffff');
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = `900 16px ${FONT_D}`; outlined(ctx, t('now'), X(c), y - 6, '#ffffff', 4);
    if (!result) {
      const mx = X(simT - src.t0);
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(mx - 4.5, y - 9, 9, h + 18);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(mx - 2.5, y - 7, 5, h + 14);
    } else {
      const tx = X(c + clamp(result.off, -c, span - c));
      const col = result.q === 'miss' ? Q_COLOR.miss : Q_COLOR[result.q];
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(tx - 4.5, y - 9, 9, h + 18);
      ctx.fillStyle = col; ctx.fillRect(tx - 2.5, y - 7, 5, h + 14);
      ctx.textBaseline = 'top'; ctx.font = `800 14px ${FONT_U}`;
      const offMs = Math.abs(Math.round(result.off * 1000));
      const note = result.q === 'perfect' ? t('perfect') : `${Q_SHORT[result.q]} · ${result.off < 0 ? t('early', offMs) : t('late', offMs)}`;
      outlined(ctx, note, clamp(tx, x + 70, x + w - 70), y + h + 8, col, 4);
    }
    ctx.globalAlpha = 1;
    // learning overlay
    if (!result && tutorialLeft > 0) {
      const inGood = Math.abs(simT - src.dp) <= src.w.good;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      if (inGood) {
        const pulse = 1 + 0.08 * Math.sin(simT * 40);
        ctx.font = `900 ${Math.round(44 * pulse)}px ${FONT_D}`;
        outlined(ctx, t('tapNow'), W / 2, y - 30, '#ffffff', 7);
      } else if (simT < src.dp) {
        ctx.font = `800 17px ${FONT_U}`;
        outlined(ctx, t('tapWhen'), W / 2, y - 30, '#efe9dc', 4);
      }
    }
  }
  function drawFX() {
    const ctx = fxc;
    ctx.clearRect(0, 0, W, H);
    const A = attempt;
    const src = activeTiming();
    if (src) {
      if (A.state === 'flight') {
        const mv = A.flight.mv;
        const h = HOLD_BY_ID[mv.to];
        drawRing(gripPos(mv.to, tmp), src, holdName(h.type).toUpperCase(), mv.dyno ? t('dyno') : '');
      } else if (A.state === 'feet') {
        drawRing(footPos(A.P.stances[A.stanceIdx].FL, tmp), src, t('feet'), '');
      } else if (A.state === 'match') {
        drawRing(gripPos(A.P.moves[A.P.moves.length - 1].to, tmp), src, t('match'), '');
      }
      drawMeter(src, null);
    } else if (meter.last && simT - meter.last.at < 0.75 && (mode === 'climb' || mode === 'fallen' || mode === 'topped')) {
      drawMeter(meter.last.src, meter.last);
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
  let lastHint = null, lastNext = null, lastScore = -1, lastCombo = -1;
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
    const hint = hintFor(A);
    if (hint !== lastHint) { hud.hint.textContent = hint; lastHint = hint; }
    const nx = nextChipFor(A);
    if (nx !== lastNext) { hud.next.innerHTML = nx; hud.next.style.visibility = nx ? 'visible' : 'hidden'; lastNext = nx; }
  }
  function hintFor(A) {
    if (!A || mode !== 'climb') return '';
    const learning = session.log.length < 2 && session.g <= 2;
    const restRate = A.restRateFor(A.bestHand() === 'L' ? A.L : A.R);
    switch (A.state) {
      case 'ready': return session.log.length === 0 && session.attemptNo === 1 ? t('hintFirst') : t('hintStart');
      case 'flight': return '';
      case 'hang':
        if (A.energy < A.maxEnergy - 22 && restRate > 3) return t('hintRest');
        if (A.energy < 35 && restRate <= 0.5) return t('hintNoRest');
        return learning ? t('hintNext') : '';
      case 'rest': return restRate > 0 ? t('hintShake') : t('hintDrain');
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
    if (mv.dyno) s += `<span class="tag">${t('dyno')}</span>`;
    if (mv.feetCut) s += `<span class="warn">${t('feetCut')}</span>`;
    return s;
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
  const inputEl = $('input');
  function evTime(e) {
    if (LOCK) return simT;
    const now = performance.now();
    const ts = e && e.timeStamp;
    const pt = ts > 0 && Math.abs(now - ts) < 1000 ? ts : now;
    return simT + ((pt - lastFrame) / 1000) * timeScale;
  }
  function onPress(t) {
    if (paused) return;
    if (mode === 'intro') { finishIntro(); return; }
    if (mode === 'climb' && attempt) {
      if (fading() || climber.entering) return;
      attempt.press(t);
    } else if (mode === 'topped' && simT - topT0 > 0.8) { toastEl.hidden = true; endAttempt(); }
  }
  function onRelease(t) { if (mode === 'climb' && attempt) attempt.release(t); }
  inputEl.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(evTime(e)); }, { passive: false });
  window.addEventListener('pointerup', (e) => onRelease(evTime(e)));
  window.addEventListener('pointercancel', (e) => onRelease(evTime(e)));
  inputEl.addEventListener('contextmenu', (e) => e.preventDefault());
  const KEYS = new Set(['Space', 'Enter', 'ArrowUp', 'KeyJ']);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'KeyP') { if (mode === 'climb' || mode === 'intro') togglePause(!paused); return; }
    if (!KEYS.has(e.code) || e.repeat) return;
    if (mode === 'climb' || mode === 'intro' || mode === 'topped') { e.preventDefault(); onPress(evTime(e)); }
  });
  window.addEventListener('keyup', (e) => { if (KEYS.has(e.code)) onRelease(evTime(e)); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (mode === 'climb' || mode === 'intro')) togglePause(true); });

  function togglePause(on) {
    paused = on;
    if (on && session) $('pauseEyebrow').textContent = `${problemName(session.problem)} · ${gradeLabel(session.problem.grade)} · ${session.problem.angle}°`;
    $('pause').hidden = !on;
    $('btnMute').textContent = sfx.muted ? t('soundOff') : t('soundOn');
    if (on && attempt && attempt.pressing) attempt.release(simT);
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
  const sbProbe = document.createElement('div');
  sbProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
  document.body.appendChild(sbProbe);
  let safeBottom = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    safeBottom = sbProbe.getBoundingClientRect().height || 0;
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
    // slow motion around the deadpoint until the player has the rhythm
    const src0 = activeTiming();
    let tsTarget = 1;
    if (src0 && tutorialLeft > 0) {
      const p = (simT - src0.t0) / Math.max(0.05, src0.dp - src0.t0);
      if (p > 0.55 && p < 1.3) tsTarget = 0.33;
    }
    timeScale += (tsTarget - timeScale) * (1 - Math.exp(-dt * 14));
    if (tsTarget === 1 && timeScale > 0.985) timeScale = 1;
    if (session) session.freezeCalib = timeScale < 0.99;
    const sdt = dt * timeScale;
    if (!frozen) simT += sdt;
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
      updateFade();
      if (climber.mode === 'climb' && (mode === 'climb' || mode === 'title' || mode === 'topped')) driveClimber();
      if (climber.mode === 'stand') {
        // now and then glance back at the camera over the shoulder, with a smile
        const glance = (simT % 5.2) > 3.6 || (mode === 'topped');
        climber.stand.lookBack = glance;
        climber.stand.look = glance ? wall.worldToLocal(camLocal.copy(camera.position)) : (climber.stand.boardLook || null);
        climber.setExpr(glance ? 'happy' : 'calm');
      }
      climber.update(sdt, simT, world.angle);
      world.updateChalk(sdt);
      meter.src = activeTiming() || meter.src;
      scheduleBeats(activeTiming());
      const nextId = attempt && mode === 'climb' && !attempt.done && attempt.nextMove() ? attempt.nextMove().to : null;
      world.updateLit(simT, nextId, (L) => { if (mode === 'intro') sfx.ledBlip(L.order); });
      world.updatePads(simT);
    }
    if (mode !== 'title') updateHud(false);
    updateCamera(dt, now / 1000);
    world.render();
    drawFX();
  }

  // test hooks (only when the test harness sets window.__DP_TEST before load)
  if (TEST) {
    window.__DP = {
      get session() { return session; }, get attempt() { return attempt; }, get mode() { return mode; },
      get simT() { return simT; }, get fps() { return fpsAvg; }, get paused() { return paused; },
      get busy() { return fading() || climber.entering; },
      get timeScale() { return timeScale; }, get tutorialLeft() { return tutorialLeft; }, set tutorialLeft(v) { tutorialLeft = v; },
      get quality() { return world.quality; },
      start: (g) => startSession(g || 0), skip: () => finishIntro(), sfx, Sound, climber, world,
      TUNE, HOLD_TYPES,
    };
  }

  world.setAngle(30);
  showDemo();
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
}
