// Renders every procedural sound offline (OfflineAudioContext) in Chromium and prints peak/RMS in dBFS.
// Catches silent sounds, clipping and NaNs after audio changes. Run `npm run build` first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'index.html');
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(DIST).pipe(r); }).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const JS = async () => {
  const SR = 44100;
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -999).toFixed(1);
  function stats(buf, t0, t1) {
    let peak = 0, sum = 0, n = 0, bad = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = Math.floor(t0 * SR); i < Math.min(d.length, Math.floor(t1 * SR)); i++) {
        const v = d[i]; if (!Number.isFinite(v)) { bad++; continue; }
        const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; n++;
      }
    }
    return `${db(peak)} / ${db(Math.sqrt(sum / Math.max(1, n)))}${bad ? ` NaN:${bad}` : ''}`;
  }
  const ctx = new OfflineAudioContext(2, SR * 20, SR);
  const S = new window.__DP.Sound(); S.init(ctx); S.setLevel(3, true);
  const at = (t, fn) => { S.now = () => t; fn(); S.whooshNode = null; };
  const plan = [
    ['launch+whoosh', 0.3, () => S.launch(true, 0.8)], ['catch perfect', 1.6, () => S.catchHold('perfect', 3, 'edge')],
    ['catch good', 2.6, () => S.catchHold('good', 0, 'jug')], ['catch ok', 3.6, () => S.catchHold('ok', 0, 'sloper')],
    ['feet', 4.6, () => S.feet('perfect')], ['footstep', 5.2, () => S.footstep()], ['miss', 5.8, () => S.miss('late')],
    ['fall whoosh', 6.8, () => S.fallWhoosh()], ['land', 7.8, () => S.land(1)], ['top flash', 8.8, () => S.top(true)],
    ['game over', 12.4, () => S.over()], ['led blips', 14.6, () => { for (let i = 0; i < 8; i++) { S.now = () => 14.6 + i * 0.065; S.ledBlip(i); } }],
    ['match cue', 15.6, () => S.matchCue()], ['ui', 16.2, () => S.ui()], ['grunt', 16.8, () => S.grunt(16.8, 1, 0.16, 0.26)],
  ];
  for (const [, t, fn] of plan) at(t, fn);
  const buf = await ctx.startRendering();
  const out = {};
  plan.forEach(([name, t0], i) => { out[name] = stats(buf, t0, i + 1 < plan.length ? plan[i + 1][1] : 20); });
  out['room tone'] = stats(buf, 18.5, 19.9);
  for (const level of [0, 1, 2]) {
    const mctx = new OfflineAudioContext(2, SR * 12, SR);
    const M = new window.__DP.Sound(); M.init(mctx); M.setLevel(level, true);
    const sd = 60 / M.bpm / 4;
    for (let st = 0; st < 64; st++) M.scheduleStep(st, 0.05 + st * sd, sd);
    out['music L' + level] = stats(await mctx.startRendering(), 0.5, 11.5);
  }
  return out;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript("window.__DP_TEST = true; window.__DP_Q = { tier: 'low', noRender: true, dpr: 0.5 };");
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DP && window.__DP.simT > 0.3, null, { timeout: 60000 });
  const res = await page.evaluate(JS);
  console.log('sound                 peak / rms (dBFS)');
  for (const [k, v] of Object.entries(res)) console.log(k.padEnd(22), v);
} finally {
  if (errors.length) { console.log('errors:', errors); process.exitCode = 1; }
  await browser.close();
  server.close();
}
