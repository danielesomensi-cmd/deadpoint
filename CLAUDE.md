# Deadpoint: guide for Claude Code

3D climbing game on an adjustable LED board (Kilter-style). Plain JS + three.js, built with Vite into
**one self-contained `dist/index.html`** (JS and CSS inlined). UI copy is Italian; code, comments and
commits are English. The owner (Daniele) prefers short, direct answers and hates scope creep.

## Commands

```bash
npm run dev            # Vite dev server (--host: open it from the phone on the same Wi-Fi)
npm run build          # dist/index.html (single file, base './': works on any path or from disk)
npm run check:gen      # problem generator sanity: reachability, crosses, feet
npm run sim            # balance report: 5 simulated player profiles x 400 sessions
node test/sim.mjs 250 all --check          # same, exits 1 if a profile leaves its band (CI)
node test/sim.mjs 300 all costPerM=8       # try TUNE overrides without editing code
npm run test:e2e       # build first. Real-time bot plays through problems with pointer events (no WebGL draw)
node test/e2e.mjs smoke                    # quicker: one problem, errors only
QUICK=1 DPR=0.75 node test/e2e.mjs visual mobile   # lockstep screenshots into test/shots/
npm run test:audio     # renders every sound offline, prints peak/RMS dBFS
npm test               # check:gen + sim + build + e2e flow
```

Headless Chromium renders WebGL in software (SwiftShader): about 2-3 fps with bloom. The visual test
runs in lockstep (fixed 1/60 s per frame) so screenshots are deterministic but slow (minutes).
Use `QUICK=1`, `DPR=0.75` and `TIER=low` to iterate faster. `flow` and `smoke` skip drawing.

## Architecture (src/)

| File | Role |
| --- | --- |
| `logic.js` | **Pure game rules**, no DOM/three. Board layout, problem generator, grades, `TUNE`, `Attempt` (state machine: ready → flight → hang/rest/feet/match → top/fall), `Session` (pyramid, 3 tries). Shared with the Node simulator. |
| `climber.js` | The character: stylized model from primitives + physics-lite rig. Shoulders (S) and pelvis (P) are springs + position constraints; hands/feet are effectors that tween on arcs; two-bone IK; ponytail verlet chain; face expressions drawn on canvas. Modes: `climb`, `stand`, `fall`, `hidden`. |
| `world.js` | Renderer, gym, board (tilts 20°-70°), sculpted holds (instanced), Kilter-style LED rims + glow, chalk particles, bloom, quality tiers (`high`/`mid`/`low`). |
| `game.js` | Flow (title/intro/climb/fallen/topped/over), choreography (`driveClimber`: maps the attempt state to climber targets: hand arcs, deadpoint drive, feet cut, rest shake, match), events → sound/juice, camera, HUD, FX canvas (timing rings, popups), input, perf guard. |
| `audio.js` | Procedural Web Audio: layered lo-fi score that follows the climb, foley (catch, whoosh, land, heartbeat when pumped). No samples. |
| `style.css`, `index.html` | HUD and screens. Keep the `[hidden] { display: none !important }` rule: several overlays set `display` and would otherwise cover the game. |

### Conventions
- Climber and holds live in **board-local coordinates** (child of the `wall` group): x right, y up the
  board, z out of the wall. Gravity in local coords is `(0, -cos θ, sin θ)` (`climber.g`).
- The rules clock is `simT` (seconds, pauses with the game). Input timestamps are mapped onto it in
  `evTime`. Timing windows: `TUNE.win` × grade × hold type × pump; latency auto-calibrates.
- Game rules change → run `npm run sim` and keep the bands in `test/sim.mjs` (`BANDS`) green.
  Current medians: novice V3, casual V6, good V8, good-without-resting V6, expert V10.
- Visual change → take screenshots (`test:shots`) and look at them before committing.
- Test hooks exist only when the page is loaded with `window.__DP_TEST = true` (see `test/e2e.mjs`).

## Deploy
- Push to `main` → GitHub Actions (`deploy.yml`) runs generator + balance checks, builds, publishes to
  GitHub Pages: https://danielesomensi-cmd.github.io/deadpoint/
- climbritz.app/gioco can proxy that URL through a Vercel rewrite in the climbritz repo.

## Ideas not done yet
- Pull-on animation from standing (now a short fade cut to the start holds).
- Character customization (colours, hair), more expressions visible from behind (shoulder look-back).
- Daily problem with a shared seed; leaderboard needs a backend.
- Real Kilter problems are out of scope (their database and layout are Kilter's).
