// End-to-end tests on the built page (dist/index.html) in headless Chromium.
//   node test/e2e.mjs smoke            load, start a session, check for errors
//   node test/e2e.mjs flow             real-time bot plays with pointer events (no WebGL draw)
//   node test/e2e.mjs visual [mobile|desktop] [outdir]   lockstep screenshots of key moments
// Env: DSF (device scale factor for visual), TIER (high|mid|low), QUICK=1 (stop after next-problem intro)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = process.argv[2] || 'smoke';
const VIEW = process.argv[3] || 'mobile';
const OUT = path.resolve(process.argv[4] || path.join(ROOT, 'test', 'shots'));
const DIST = process.env.DIST ? path.resolve(process.env.DIST) : path.join(ROOT, 'dist', 'index.html');
if (!fs.existsSync(DIST)) { console.error('dist/index.html missing: run `npm run build` first'); process.exit(1); }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(DIST).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const URL = `http://127.0.0.1:${server.address().port}/`;

// In-page bot: schedules presses against the game's own clock and dispatches real pointer events.
const BOT = String.raw`(() => {
  const B = window.__bot = { on: false, sigma: 0.015, bias: 0, busy: false, pend: null, taps: 0, rests: 0, miss: false, rest: true };
  const input = document.getElementById('input');
  const fire = (type) => input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true }));
  B.fire = fire;
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  B.schedule = (at, hold = 0.05, until = null) => { B.busy = true; B.pend = { at, hold, until, down: null }; };
  B.stop = () => { if (B.pend && B.pend.down !== null) fire('pointerup'); B.pend = null; B.busy = false; B.on = false; };
  function step() {
    requestAnimationFrame(step);
    const D = window.__DP; if (!D || D.paused) return;
    if (B.pend) {
      const p = B.pend;
      if (p.down === null) { if (D.simT >= p.at - 1 / 120) { fire('pointerdown'); p.down = D.simT; } }
      else if (p.until ? p.until() : D.simT >= p.down + p.hold) { fire('pointerup'); B.pend = null; B.busy = false; B.taps++; }
      return;
    }
    if (!B.on || B.busy) return;
    const A = D.attempt; if (D.mode !== 'climb' || !A || A.done || D.busy) return;
    const S = D.session;
    if (A.state === 'ready') return B.schedule(D.simT + 0.3);
    if (A.state === 'hang') {
      const hid = A.bestHand() === 'L' ? A.L : A.R;
      if (B.rest && A.energy < 55 && A.restRateFor(hid) > 3) {
        B.rests++;
        const target = Math.min(A.maxEnergy - 2, 88);
        return B.schedule(D.simT + 0.05, 0, () => A.done || A.energy >= target || (A.state !== 'rest' && A.state !== 'hang'));
      }
      return B.schedule(D.simT + 0.25);
    }
    const ev = A.state === 'flight' ? A.flight : A.state === 'feet' ? A.feet : A.state === 'match' ? A.match : null;
    if (ev) {
      const err = B.miss ? -0.26 : B.bias + gauss() * B.sigma;
      return B.schedule(ev.dp + S.latency + err);
    }
  }
  requestAnimationFrame(step);
})();`;

const JUMP_TO_LAST = `(() => {
  const A = __DP.attempt, P = A.P, k = P.moves.length - 1;
  for (let i = 0; i < k; i++) { const m = P.moves[i]; if (m.hand === 'L') A.L = m.to; else A.R = m.to; }
  A.moveIdx = k; A.stanceIdx = k; A.state = 'hang';
})()`;

const report = { run: RUN, view: VIEW };
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const mobile = VIEW === 'mobile';
  const dsf = RUN === 'visual' ? Number(process.env.DSF || 1) : 1;
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: dsf, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let init = 'window.__DP_TEST = true;';
  if (RUN === 'visual') init += `window.__DP_LOCKSTEP = true; window.__DP_Q = { tier: '${process.env.TIER || 'mid'}', dpr: ${process.env.DPR || dsf} };`;
  else init += "window.__DP_Q = { tier: 'low', noRender: true, dpr: 0.5 };";
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  const T0 = Date.now();
  const vlog = (m) => { if (process.env.VERBOSE) console.error(`[e2e ${((Date.now() - T0) / 1000).toFixed(1)}s]`, m); };
  await page.goto(URL, { waitUntil: 'domcontentloaded' }); vlog('dom loaded');
  await page.waitForFunction(() => window.__DP && window.__DP.simT > 0.5, null, { timeout: 120000 }); vlog('game running');
  await page.evaluate(BOT); vlog('bot injected');
  const ev = (js) => page.evaluate(js);
  const frames = (n) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const wait = (js, opts = {}) => page.waitForFunction(js, null, { polling: 'raf', ...opts });
  fs.mkdirSync(OUT, { recursive: true });
  let shotCount = 0;
  const MAX_SHOTS = Number(process.env.SHOTS || 99);
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${VIEW}_${name}.png`) });
    if (++shotCount >= MAX_SHOTS) throw new Error('SHOTS_DONE');
  };
  const freeze = (on) => ev(`window.__DP_FREEZE = ${on}`);

  const log = (m) => { if (process.env.VERBOSE) console.error('[e2e]', m); };
  if (RUN === 'smoke') {
    await page.click('#btnStart'); log('clicked start');
    await wait('__DP.mode === "intro"', { timeout: 20000 }); log('intro');
    await ev('__bot.fire("pointerdown"); __bot.fire("pointerup")');
    await wait('__DP.mode === "climb" && !__DP.busy', { timeout: 20000 }); log('climb ready');
    await ev('__bot.on = true; __bot.sigma = 0.01');
    for (let i = 0; i < 60 && !(await ev('__DP.session.log.length >= 1 || __DP.mode === "over"')); i++) {
      log(JSON.stringify(await ev('({ m: __DP.mode, s: __DP.attempt && __DP.attempt.state, mi: __DP.attempt && __DP.attempt.moveIdx, busy: __DP.busy, cm: __DP.climber.mode, t: __DP.simT.toFixed(1), taps: __bot.taps })')));
      await page.waitForTimeout(1000);
    }
    report.after = await ev('({ mode: __DP.mode, log: __DP.session.log.length, climber: __DP.climber.mode, q: __DP.quality })');
  } else if (RUN === 'flow') {
    await page.click('#btnStart');
    await ev('__bot.on = true; __bot.sigma = 0.02');
    report.raf_per_s = await ev('new Promise(r => { let n = 0; const t0 = performance.now(); function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); } requestAnimationFrame(f); })');
    const t0 = Date.now();
    const states = new Set();
    while (Date.now() - t0 < 150000) {
      const st = await ev('({ mode: __DP.mode, g: __DP.session.g, s: __DP.attempt && __DP.attempt.state, c: __DP.climber.mode })');
      states.add(`${st.mode}/${st.s}/${st.c}`);
      if (st.g >= 7 || st.mode === 'over') break;
      await page.waitForTimeout(100);
    }
    report.states_seen = [...states].sort();
    report.reached_g = await ev('__DP.session.g');
    report.log = await ev('__DP.session.log.map(l => [l.g, l.attempts])');
    report.taps = await ev('__bot.taps');
    report.rests = await ev('__bot.rests');
    await ev('__bot.miss = true');
    await page.waitForFunction('__DP.mode === "over"', null, { timeout: 90000 });
    report.over_text = await ev('document.getElementById("overGrade").textContent + " | " + document.getElementById("overSub").textContent');
    await page.click('#btnAgain');
    await page.waitForFunction('__DP.mode === "intro"');
    report.restart = true;
    await page.waitForFunction('__DP.mode === "climb"', null, { timeout: 15000 });
    await page.click('#btnPause');
    report.paused = await ev('__DP.paused');
    await page.click('#btnQuit');
    report.after_quit = await ev('__DP.mode');
  } else if (RUN === 'visual') {
    await frames(3);
    await shot('01_title');
    await page.click('#sg6');
    await page.click('#btnStart');
    await frames(50);
    await shot('02_intro');
    await ev('__bot.fire("pointerdown"); __bot.fire("pointerup")');
    await wait('__DP.mode === "climb" && !__DP.busy');
    await frames(30);
    await shot('03_ready');
    await ev('__bot.schedule(__DP.simT)');
    await wait('__DP.attempt.state === "flight" && (__DP.simT - __DP.attempt.flight.t0) / __DP.attempt.flight.T > 0.6');
    await freeze(true); await shot('04_flight'); await freeze(false);
    await ev('__bot.sigma = 0.004; __bot.on = true; __bot.rest = false');
    await wait('__DP.attempt.moveIdx >= 1');
    await frames(8);
    await freeze(true); await shot('05_catch'); await freeze(false);
    await ev('__bot.stop()');
    await wait('__DP.attempt.state === "hang" || __DP.attempt.done');
    if (await ev('__DP.attempt.state') === 'hang') {
      await ev('__DP.attempt.energy = 48');
      await ev('__bot.schedule(__DP.simT, 1.3)');
      await wait('__DP.attempt.state === "rest"');
      await frames(20);
      await freeze(true); await shot('06_rest'); await freeze(false);
      await wait('!__bot.busy');
    }
    await ev(JUMP_TO_LAST);
    await frames(40);
    await shot('07_last_move');
    await ev('__bot.on = true');
    await wait('__DP.mode === "topped"');
    await frames(30);
    await freeze(true); await shot('08_top'); await freeze(false);
    await frames(110);
    await shot('09_drop_cheer');
    await wait('__DP.mode === "intro" || __DP.mode === "climb"');
    await frames(40);
    await shot('10_next_intro');
    if (process.env.QUICK) { report.visual = 'quick-ok'; }
    else {
      await ev('__bot.fire("pointerdown"); __bot.fire("pointerup")');
      await wait('__DP.mode === "climb" && !__DP.busy');
      await ev('__DP.session.attemptNo = 3; __bot.miss = true; __bot.on = true');
      await wait('__DP.mode === "fallen"');
      await frames(14);
      await freeze(true); await shot('11_fall'); await freeze(false);
      await frames(40);
      await shot('12_landed');
      await wait('__DP.mode === "over"');
      await frames(30);
      await shot('13_over');
      report.visual = 'ok';
    }
  }
} catch (e) {
  if (String(e && e.message).startsWith('SHOTS_DONE')) report.visual = 'partial-ok';
  else report.exception = String(e && e.message || e).split('\n')[0];
} finally {
  report.errors = errors.slice(0, 20);
  await browser.close();
  server.close();
}
console.log(JSON.stringify(report, null, 1));
if (report.exception || report.errors.length) process.exitCode = 1;
