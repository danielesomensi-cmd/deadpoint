// Renders the procedural score and every sound offline (OfflineAudioContext) in Chromium and prints
// peak/RMS in dBFS, then checks loudness bands. Loads src/audio.js directly (no build needed).
// Deterministic: Sound takes a seed. Exits 1 on NaN, clipping or a level outside its band.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { Sound } from '/src/audio.js'; window.Sound = Sound; window.ready = true;</script>`;
const server = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); return; }
  const f = path.join(ROOT, u);
  if (!f.startsWith(path.join(ROOT, 'src')) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(f).pipe(r);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const JS = async () => {
  const SR = 44100;
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -999);
  function stats(buf, t0, t1) {
    let peak = 0, sum = 0, n = 0, bad = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = Math.floor(t0 * SR); i < Math.min(d.length, Math.floor(t1 * SR)); i++) {
        const v = d[i]; if (!Number.isFinite(v)) { bad++; continue; }
        const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; n++;
      }
    }
    return { peak: db(peak), rms: db(Math.sqrt(sum / Math.max(1, n))), bad };
  }
  const make = (secs, tier = 'high') => {
    const ctx = new OfflineAudioContext(2, SR * secs, SR);
    const S = new window.Sound({ seed: 7, tier }); S.init(ctx);
    return { ctx, S };
  };
  // drive the look-ahead scheduler offline, calling `events` at their times
  const play = (S, secs, events = []) => {
    const ev = events.slice().sort((a, b) => a[0] - b[0]);
    for (let now = 0; now < secs; now += 0.025) {
      while (ev.length && ev[0][0] <= now + 0.14) { const [t, fn] = ev.shift(); S.now = () => t; fn(t, now); }
      S.run(now + 0.14, now);
    }
  };
  const out = {};

  // ---- foley, music muted ----
  {
    const { ctx, S } = make(22);
    S.music.gain.value = 0; S.mwet.gain.value = 0;
    S.setLevel(1, true);
    // flight 0.3 -> deadpoint 1.1: tic 0.57, tic 0.83, TAC 1.1 (tick() schedules relative to currentTime = 0)
    const plan = [
      ['launch', 0.3, () => S.launch(true, 0.8)],
      ['tic', 0.56, () => { S.tick(false, 0.567); S.tick(false, 0.833); }],
      ['TAC', 1.08, () => S.tick(true, 1.1)],
      ['catch perfect', 2.0, () => S.catchHold('perfect', 3, 'edge')],
      ['catch good', 3.0, () => S.catchHold('good', 0, 'jug')],
      ['catch ok', 4.0, () => S.catchHold('ok', 0, 'sloper')],
      ['feet', 5.0, () => S.feet('perfect')], ['footstep', 5.5, () => S.footstep()], ['miss', 6.0, () => S.miss('late')],
      ['fall', 7.0, () => S.fallWhoosh()], ['land', 8.0, () => S.land(1)], ['top flash', 9.0, () => S.top(true)],
      ['game over', 13.5, () => { S.setLevel(3); S.over(); }],
      ['led blips', 17.0, () => { for (let i = 0; i < 8; i++) { S.now = () => 17 + i * 0.065; S.ledBlip(i); } }],
      ['match cue', 18.0, () => S.matchCue()], ['ui', 18.6, () => S.ui()], ['grunt', 19.2, () => S.grunt(19.2, 1, 0.16, 0.26)],
    ];
    for (const [, t, fn] of plan) { S.now = () => t; fn(); }
    const buf = await ctx.startRendering();
    plan.forEach(([name, t0], i) => { out[name] = stats(buf, t0, i + 1 < plan.length ? plan[i + 1][1] : 20); });
    out['room tone'] = stats(buf, 20.5, 21.9);
  }
  // ---- score at each intensity ----
  const setups = [
    ['music I0', (S) => S.setLevel(0, true)],
    ['music I1', (S) => { S.setLevel(1, true); S.setIntensity({ progress: 0.1, crux: false, combo: 0 }); }],
    ['music I2', (S) => { S.setLevel(1, true); S.setIntensity({ progress: 0.5, crux: false, combo: 0 }); }],
    ['music I3', (S) => { S.setLevel(1, true); S.setIntensity({ progress: 0.9, crux: true, combo: 0 }); }],
  ];
  for (const [name, setup] of setups) {
    const { ctx, S } = make(14); setup(S); play(S, 14);
    out[name] = stats(await ctx.startRendering(), 2.5, 13.5);
  }
  {
    const { ctx, S } = make(10, 'low'); S.setLevel(1, true); S.setIntensity({ progress: 0.9, crux: true }); play(S, 10);
    out['music I3 low tier'] = stats(await ctx.startRendering(), 2, 9.5);
  }
  // ---- flight over the score: riser, countdown, TAC, catch -> downbeat ----
  {
    const { ctx, S } = make(10); S.setLevel(1, true); S.setIntensity({ progress: 0.5 });
    play(S, 10, [
      [4.0, () => S.launch(false, 0.9)],
      [4.25, () => { S.ctx = ctx; S.tick(false, 4.3); S.tick(false, 4.6); S.tick(true, 4.9); }],
      [4.92, () => S.catchHold('perfect', 4, 'crimp')],
    ]);
    const buf = await ctx.startRendering();
    out['flight riser'] = stats(buf, 4.0, 4.88);
    out['flight TAC+catch'] = stats(buf, 4.88, 5.3);
    out['after catch'] = stats(buf, 5.3, 8);
  }
  // ---- top stinger and fall over the score ----
  {
    const { ctx, S } = make(12); S.setLevel(1, true); S.setIntensity({ progress: 0.9, crux: true });
    play(S, 12, [[3, () => S.top(false)], [8, () => S.setIntensity({ progress: 0.1 })]]);
    const buf = await ctx.startRendering();
    out['top stinger'] = stats(buf, 3, 6);
  }
  {
    const { ctx, S } = make(10); S.setLevel(1, true); S.setIntensity({ progress: 0.5 });
    play(S, 10, [[3, () => S.fallWhoosh()]]);
    const buf = await ctx.startRendering();
    out['fall silence'] = stats(buf, 4.4, 5.0);
    out['fall drone back'] = stats(buf, 7, 9.5);
  }
  return out;
};

// [rmsMin, rmsMax, peakTarget] (dBFS); peaks must stay <= -1 everywhere
const BANDS = {
  'music I0': [-32, -28], 'music I1': [-27, -23], 'music I2': [-24, -20], 'music I3': [-22, -18],
  'TAC': [null, null, -6], 'catch perfect': [null, null, -6], 'top stinger': [-19, -13],
};
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const res = await page.evaluate(JS);
  console.log('sound                  peak /  rms (dBFS)');
  for (const [k, v] of Object.entries(res)) {
    const b = BANDS[k], bad = [];
    if (v.bad) bad.push(`NaN:${v.bad}`);
    if (v.peak > -1) bad.push('peak > -1');
    if (b && b[0] != null && (v.rms < b[0] || v.rms > b[1])) bad.push(`rms outside ${b[0]}..${b[1]}`);
    if (b && b[2] != null && Math.abs(v.peak - b[2]) > 3) bad.push(`peak not ~${b[2]}`);
    if (v.peak < -60 && !/silence|room/.test(k)) bad.push('silent');
    if (bad.length) errors.push(`${k}: ${bad.join(', ')}`);
    console.log(k.padEnd(22), v.peak.toFixed(1).padStart(6), '/', v.rms.toFixed(1).padStart(6), bad.length ? '  <- ' + bad.join(', ') : '');
  }
} finally {
  if (errors.length) { console.log('FAIL:', errors); process.exitCode = 1; } else console.log('OK');
  await browser.close();
  server.close();
}
