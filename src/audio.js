// DEADPOINT — procedural audio (Web Audio API, no samples).
// Epic adaptive score in D minor (taiko, string pad, ostinato, low brass, formant choir) that follows
// the climb, plus synthesized foley. During a flight the rhythm steps aside and a riser builds to the
// deadpoint; the tic-tic-TAC is in key (A4, C5, then D) and the catch restarts the bar.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const BPM = 90;
const FLOW_COMBO = 3; // mirrors TUNE.flowCombo (audio stays free of game imports)

// A chord: low root (brass/stab), third (3 = minor, 4 = major) and a 4-voice string pad voicing.
const C = (root, third, pad) => ({ root, third, pad });
const MAIN = [C(38, 3, [50, 57, 62, 65]), C(34, 4, [50, 58, 62, 65]), C(41, 4, [48, 57, 60, 65]), C(36, 4, [48, 55, 60, 64])]; // Dm Bb F C
const CRUX = [C(38, 3, [50, 57, 62, 65]), C(34, 4, [50, 58, 62, 65]), C(43, 3, [50, 58, 62, 67]), C(33, 4, [49, 57, 61, 64])]; // Dm Bb Gm A
const TOP = [C(34, 4, [50, 58, 62, 65]), C(36, 4, [48, 55, 60, 64]), C(38, 4, [50, 57, 62, 66])]; // Bb C D
// crux motif (high strings/horn), per crux bar: [step, midi, length in steps]
const MOTIF = [
  [[0, 74, 4], [4, 77, 4], [8, 81, 8]],
  [[0, 82, 8], [8, 81, 4], [12, 77, 4]],
  [[0, 79, 4], [4, 77, 4], [8, 76, 4], [12, 74, 4]],
  [[0, 76, 4], [4, 73, 4], [8, 76, 8]],
];
// layer mix per intensity (0 drone, 1 pulse, 2 drive, 3 crux, 4 top stinger, 5 game over)
const MIX = [
  { pad: 0.25, choir: 0.2, ost: 0.0001, drums: 0.0001, brass: 0.0001, motif: 0.0001 },
  { pad: 0.5, choir: 0.3, ost: 0.6, drums: 0.85, brass: 0.0001, motif: 0.0001 },
  { pad: 0.5, choir: 0.3, ost: 0.6, drums: 0.9, brass: 0.55, motif: 0.0001 },
  { pad: 0.55, choir: 0.6, ost: 0.6, drums: 1, brass: 0.6, motif: 0.55 },
  { pad: 0.6, choir: 0.6, ost: 0.0001, drums: 0.0001, brass: 0.0001, motif: 0.0001 },
  { pad: 0.35, choir: 0.15, ost: 0.0001, drums: 0.0001, brass: 0.0001, motif: 0.0001 },
];
const PAD_LP = [900, 1300, 1800, 2400, 2400, 700];
const PAD_ATTACK = [1.2, 0.8, 0.6, 0.4, 0.3, 1.5];
const VOWEL = { oo: [300, 870, 2240], ah: [800, 1150, 2900] };

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function softClip(c, drive, ceil = 1) {
  const ws = c.createWaveShaper(), n = 2048, curve = new Float32Array(n), k = Math.tanh(drive);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = ceil * Math.tanh(drive * x) / k; }
  ws.curve = curve;
  return ws;
}

export class Sound {
  constructor(opts = {}) {
    this.ctx = null;
    this.muted = false;
    this.level = 0;
    this.pumpLevel = 0;
    this.step = 0;
    this.nextT = 0;
    this.hbNext = 0;
    this.breathNext = 0;
    this.thudNext = 0;
    this.timer = null;
    this.bpm = BPM;
    this.whooshNode = null;
    this.restNode = null;
    this.rnd = mulberry32(opts.seed ?? ((Math.random() * 4294967296) >>> 0));
    this.tier = opts.tier || null;
    this.catches = 0;      // catches in this attempt: drives intensity when the game gives no progress
    this.ext = null;       // setIntensity() input, when the game provides it
    this.I = -1;           // applied intensity
    this.fallUntil = 0; this.topUntil = 0;
    this.chord = MAIN[0];
    this.perfectN = 0;
    this.tickN = 0; this.lastTickT = -9;
    this.skipHitT = -1;
  }

  // Must be called from a user gesture (or with an OfflineAudioContext for tests).
  init(ctx) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      return;
    }
    try { if (!ctx && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!ctx && !AC) return;
    let c;
    try { c = this.ctx = ctx || new AC({ latencyHint: 'interactive' }); } catch (e) { this.ctx = null; return; }
    this.offline = !!ctx;
    if (!this.tier) {
      let low = false;
      try { low = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2; } catch (e) { /* unknown */ }
      this.tier = low ? 'low' : 'high';
    }
    const low = this.low = this.tier === 'low';

    // master: mute gain -> soft clip -> compressor
    this.out = c.createGain();
    this.out.gain.value = this.muted ? 0 : 1;
    const clip = softClip(c, 1, 0.92);
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3.2;
    comp.attack.value = 0.003; comp.release.value = 0.22;
    this.out.connect(clip); clip.connect(comp); comp.connect(c.destination);
    this.master = c.createGain(); this.master.gain.value = 0.85; this.master.connect(this.out);

    this.white = this.noiseBuf('white', 2.5);
    this.pink = this.noiseBuf('pink', 4);
    this.brown = this.noiseBuf('brown', 4);

    this.verb = c.createConvolver();
    this.verb.buffer = this.impulse(low ? 2 : 3.4, 3.2);
    const verbRet = c.createGain(); verbRet.gain.value = 0.5;
    this.verb.connect(verbRet); verbRet.connect(this.master);

    this.sfx = c.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    const sfxSend = c.createGain(); sfxSend.gain.value = 0.15;
    this.sfx.connect(sfxSend); sfxSend.connect(this.verb);
    // big hits (TAC, catch taiko, top, fall boom): saturated so phone speakers hear the low end
    this.hits = c.createGain(); this.hits.gain.value = 0.2;
    const hitClip = softClip(c, 2.5);
    this.hits.connect(hitClip); hitClip.connect(this.sfx);
    const hitSend = c.createGain(); hitSend.gain.value = 0.35; hitClip.connect(hitSend); hitSend.connect(this.verb);
    this.far = c.createGain(); this.far.gain.value = 1; // distant gym sounds: mostly reverb
    const farLP = c.createBiquadFilter(); farLP.type = 'lowpass'; farLP.frequency.value = 900;
    this.far.connect(farLP); farLP.connect(this.verb);
    const farDry = c.createGain(); farDry.gain.value = 0.25; farLP.connect(farDry); farDry.connect(this.master);

    // music: layers -> music -> pump lowpass -> duck -> tape (fall) -> master (+ reverb send)
    this.music = c.createGain(); this.music.gain.value = 0.3;
    this.musicLP = c.createBiquadFilter(); this.musicLP.type = 'lowpass';
    this.musicLP.frequency.value = 16000; this.musicLP.Q.value = 0.6;
    this.duck = c.createGain(); this.duck.gain.value = 1;
    this.tape = c.createGain(); this.tape.gain.value = 1;
    this.music.connect(this.musicLP); this.musicLP.connect(this.duck); this.duck.connect(this.tape); this.tape.connect(this.master);
    // music reverb sends: their own bus, faded together with `tape` on a fall
    this.mwet = c.createGain(); this.mwet.gain.value = 0.3;
    this.wetTape = c.createGain(); this.wetTape.gain.value = 1;
    this.mwet.connect(this.wetTape); this.wetTape.connect(this.verb);

    this.layers = {};
    for (const k of ['pad', 'choir', 'ost', 'drums', 'brass', 'motif']) {
      const g = c.createGain(); g.gain.value = 0.0001; this.layers[k] = g;
    }
    // rhythm sub-bus (drums + ostinato) dips during a flight so the free-timed countdown never clashes
    this.rhythm = c.createGain(); this.rhythm.gain.value = 1; this.rhythm.connect(this.music);
    const drumClip = softClip(c, 2.5);
    this.drumIn = c.createGain(); this.drumIn.gain.value = 0.4;
    this.drumIn.connect(drumClip); drumClip.connect(this.layers.drums); this.layers.drums.connect(this.rhythm);
    const drumSend = c.createGain(); drumSend.gain.value = 0.35; drumClip.connect(drumSend); drumSend.connect(this.mwet);
    this.layers.ost.connect(this.rhythm);
    this.ostIn = this.layers.ost;
    if (low) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1500; f.connect(this.layers.ost); this.ostIn = f; }
    const brassClip = softClip(c, 1.6);
    this.brassIn = c.createGain(); this.brassIn.gain.value = 0.6;
    this.brassIn.connect(brassClip); brassClip.connect(this.layers.brass); this.layers.brass.connect(this.music);
    const brassSend = c.createGain(); brassSend.gain.value = 0.4; brassClip.connect(brassSend); brassSend.connect(this.mwet);
    this.layers.motif.connect(this.music);
    const motifSend = c.createGain(); motifSend.gain.value = 0.35; this.layers.motif.connect(motifSend); motifSend.connect(this.mwet);

    this.buildPad();
    if (!low) this.buildChoir();

    // Room tone: ventilation hum, always on, very quiet.
    const room = c.createBufferSource(); room.buffer = this.brown; room.loop = true;
    const roomLP = c.createBiquadFilter(); roomLP.type = 'lowpass'; roomLP.frequency.value = 320;
    const roomG = c.createGain(); roomG.gain.value = 0.014;
    room.connect(roomLP); roomLP.connect(roomG); roomG.connect(this.master); room.start();

    this.applyIntensity(this.intensity(0), 0, true);
    if (!this.offline) {
      // iOS unlock: a silent buffer started inside the gesture.
      const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
      if (c.resume) c.resume();
      this.nextT = c.currentTime + 0.1;
      this.thudNext = c.currentTime + 4;
      this.timer = setInterval(() => this.schedule(), 25);
    }
  }

  // ---------- persistent voices ----------
  buildPad() {
    const c = this.ctx, low = this.low;
    this.padLP = c.createBiquadFilter(); this.padLP.type = 'lowpass'; this.padLP.Q.value = 0.7; this.padLP.frequency.value = 900;
    // pump tremolo: 7 Hz LFO on the pad level, depth = pump
    this.padTrem = c.createGain(); this.padTrem.gain.value = 1;
    this.padLP.connect(this.padTrem); this.padTrem.connect(this.layers.pad); this.layers.pad.connect(this.music);
    const padSend = c.createGain(); padSend.gain.value = 0.3; this.layers.pad.connect(padSend); padSend.connect(this.mwet);
    this.tremLfo = c.createOscillator(); this.tremLfo.frequency.value = 7;
    this.tremDepth = c.createGain(); this.tremDepth.gain.value = 0;
    this.tremLfo.connect(this.tremDepth); this.tremDepth.connect(this.padTrem.gain); this.tremLfo.start();
    const vib = c.createOscillator(); vib.frequency.value = 5.2;
    const vibG = c.createGain(); vibG.gain.value = 5; vib.connect(vibG); vib.start();
    // pitch bend for the fall "tape stop" (cents on every pad oscillator)
    this.bend = c.createConstantSource ? c.createConstantSource() : null;
    if (this.bend) { this.bend.offset.value = 0; this.bend.start(); }
    this.pad = [];
    const det = low ? [-10, 10] : [-12, 0, 11];
    MAIN[0].pad.forEach((m, i) => {
      const g = c.createGain(); g.gain.value = 0.1;
      let dst = g;
      if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = [-0.35, 0.35, -0.15, 0.15][i]; g.connect(p); dst = p; }
      dst.connect(this.padLP);
      const oscs = [];
      for (const d of det) oscs.push({ o: c.createOscillator(), mul: 1, d, gain: 1 });
      if (!low) oscs.push({ o: c.createOscillator(), mul: 0.5, d: 0, gain: 0.3 });
      for (const v of oscs) {
        v.o.type = 'sawtooth'; v.o.frequency.value = mtof(m) * v.mul; v.o.detune.value = v.d;
        vibG.connect(v.o.detune); if (this.bend) this.bend.connect(v.o.detune);
        let src = v.o;
        if (v.gain !== 1) { const sg = c.createGain(); sg.gain.value = v.gain; v.o.connect(sg); src = sg; }
        src.connect(g); v.o.start();
      }
      this.pad.push(oscs);
    });
  }
  buildChoir() {
    const c = this.ctx;
    const vib = c.createOscillator(); vib.frequency.value = 4.8;
    const vibG = c.createGain(); vibG.gain.value = 8; vib.connect(vibG); vib.start();
    const sum = c.createGain(); sum.gain.value = 0.5;
    sum.connect(this.layers.choir); this.layers.choir.connect(this.music);
    const send = c.createGain(); send.gain.value = 0.6; this.layers.choir.connect(send); send.connect(this.mwet);
    this.formants = [];
    this.choir = [0, 7].map((iv) => {
      const g = c.createGain(); g.gain.value = 1;
      const oscs = [0, 6].map((d) => {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(62 + iv); o.detune.value = d;
        vibG.connect(o.detune); o.connect(g); o.start(); return o;
      });
      VOWEL.oo.forEach((f, k) => {
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = [10, 12, 14][k];
        const fg = c.createGain(); fg.gain.value = [1, 0.5, 0.25][k];
        g.connect(bp); bp.connect(fg); fg.connect(sum); this.formants.push({ bp, k });
      });
      return { oscs, iv };
    });
  }
  setChord(ch, t) {
    this.chord = ch;
    if (this.pad) ch.pad.forEach((m, i) => { for (const v of this.pad[i]) v.o.frequency.setTargetAtTime(mtof(m) * v.mul, t, 0.08); });
    if (this.choir) {
      const r = 57 + ((((ch.root - 57) % 12) + 12) % 12);
      for (const v of this.choir) for (const o of v.oscs) o.frequency.setTargetAtTime(mtof(r + v.iv), t, 0.12);
    }
  }

  // ---------- building blocks ----------
  noiseBuf(kind, secs) {
    const c = this.ctx, n = Math.floor(c.sampleRate * secs);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = this.rnd() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }
  // dark hall: 25 ms pre-delay, decorrelated L/R, lowpass sweeping ~8 kHz -> ~1.5 kHz along the tail
  impulse(secs, decay) {
    const c = this.ctx, sr = c.sampleRate, n = Math.floor(sr * secs);
    const buf = c.createBuffer(2, n, sr);
    const pre = Math.floor(sr * 0.025);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = pre; i < n; i++) {
        const x = (i - pre) / (n - pre);
        const fc = 8000 * Math.pow(1500 / 8000, x);
        const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        y += a * ((this.rnd() * 2 - 1) - y);
        d[i] = y * Math.sqrt((2 - a) / a) * Math.pow(1 - x, decay) * (x < 0.02 ? 0.6 : 1);
      }
    }
    return buf;
  }
  env(g, t, peak, a, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.005, dur));
  }
  noise(o) {
    const c = this.ctx; if (!c) return null;
    const t = o.t ?? c.currentTime, dur = o.dur ?? 0.1;
    const src = c.createBufferSource(); src.buffer = this[o.buf || 'white'];
    const f = c.createBiquadFilter(); f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f ?? 1000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep ?? dur));
    f.Q.value = o.Q ?? 1;
    const g = c.createGain(); this.env(g, t, o.g ?? 0.3, o.a ?? 0.002, dur);
    src.connect(f); f.connect(g);
    let last = g;
    if (o.pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = o.pan; g.connect(p); last = p; }
    last.connect(o.dest || this.sfx);
    const maxOff = Math.max(0, src.buffer.duration - dur - 0.1);
    src.start(t, this.rnd() * maxOff, dur + 0.05);
    return { src, g, f };
  }
  tone(o) {
    const c = this.ctx; if (!c) return null;
    const t = o.t ?? c.currentTime, dur = o.dur ?? 0.2;
    const osc = c.createOscillator(); osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide ?? dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = c.createGain(); this.env(g, t, o.g ?? 0.2, o.a ?? 0.003, dur);
    osc.connect(g);
    let last = g;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); last = f; }
    last.connect(o.dest || this.sfx);
    osc.start(t); osc.stop(t + dur + 0.05);
    return osc;
  }
  // saw voices -> one lowpass with a sweep -> one gain envelope (attack, sustain, release)
  saws(o) {
    const c = this.ctx;
    const t = o.t, dur = o.dur;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = o.Q ?? 0.8;
    f.frequency.setValueAtTime(o.f0, t);
    f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sweep ?? 0.2));
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep ?? 0.2) + 0.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.g, t + (o.a ?? 0.01));
    g.gain.exponentialRampToValueAtTime(o.g * (o.sus ?? 0.6), t + Math.max((o.a ?? 0.01) + 0.005, Math.min((o.a ?? 0.01) + 0.25, dur * 0.8)));
    g.gain.setValueAtTime(o.g * (o.sus ?? 0.6), t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + (o.rel ?? 0.2));
    f.connect(g); g.connect(o.dest);
    for (const m of o.notes) for (const d of o.det) {
      const osc = c.createOscillator(); osc.type = o.wave || 'sawtooth';
      osc.frequency.setValueAtTime(mtof(m), t);
      if (o.bend) osc.frequency.exponentialRampToValueAtTime(mtof(m + o.bend), t + dur);
      osc.detune.value = d; osc.connect(f);
      osc.start(t); osc.stop(t + dur + (o.rel ?? 0.2) + 0.05);
    }
    return g;
  }
  taiko(t, kind, g = 1, dest = this.drumIn, stick = false) {
    const P = { low: [115, 68, 0.7, 500], mid: [170, 105, 0.4, 700], frame: [240, 170, 0.12, 1200] }[kind];
    this.tone({ t, f: P[0], f2: P[1], glide: 0.09, dur: P[2], g: 0.9 * g, a: 0.002, dest });
    if (kind === 'low') this.tone({ t, f: 190, f2: 120, glide: 0.1, dur: 0.25, g: 0.25 * g, wave: 'triangle', dest });
    this.noise({ t, dur: 0.1, buf: 'brown', type: kind === 'frame' ? 'bandpass' : 'lowpass', f: P[3], g: 0.35 * g, a: 0.002, dest });
    if (stick) this.noise({ t, dur: 0.012, buf: 'white', type: 'bandpass', f: 2500, Q: 1, g: 0.12 * g, dest });
  }
  // formant "ah" voice for one-shot swells (perfect catch, top)
  voice(t, midi, g, dur, dest = this.sfx) {
    const c = this.ctx;
    if (this.low) { this.tone({ t, f: mtof(midi), dur, g, a: 0.1, wave: 'triangle', lp: 1600, dest }); return; }
    const out = c.createGain(); this.env(out, t, g, Math.min(0.15, dur * 0.3), dur);
    out.connect(dest);
    const send = c.createGain(); send.gain.value = 0.6; out.connect(send); send.connect(this.verb);
    const src = c.createOscillator(); src.type = 'sawtooth'; src.frequency.value = mtof(midi);
    VOWEL.ah.slice(0, 2).forEach((f, k) => {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 8 + 2 * k;
      const fg = c.createGain(); fg.gain.value = k ? 1.6 : 3; src.connect(bp); bp.connect(fg); fg.connect(out);
    });
    src.start(t); src.stop(t + dur + 0.05);
  }
  grunt(t, pitch = 1, gain = 0.16, dur = 0.24) {
    // formant "uh!" — sawtooth through two vowel formants
    const c = this.ctx; if (!c) return;
    const src = c.createOscillator(); src.type = 'sawtooth';
    src.frequency.setValueAtTime(150 * pitch, t);
    src.frequency.exponentialRampToValueAtTime(108 * pitch, t + dur);
    const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 640; f1.Q.value = 5;
    const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1180; f2.Q.value = 7;
    const g = c.createGain(); this.env(g, t, gain, 0.02, dur);
    const mix = c.createGain(); mix.gain.value = 1;
    src.connect(f1); src.connect(f2); f1.connect(mix); f2.connect(mix); mix.connect(g); g.connect(this.sfx);
    src.start(t); src.stop(t + dur + 0.05);
    this.noise({ t, dur: dur * 0.8, buf: 'pink', type: 'bandpass', f: 1400, Q: 0.9, g: gain * 0.45, a: 0.015 });
  }

  // ---------- intensity ----------
  // Old API: 0 title, 1 climbing, 2 flow combo, 3 game over. Kept so game.js needs no change.
  setLevel(level, instant) {
    if (level === this.level && !instant) return;
    this.level = level;
    if (level === 0 || level === 3) { this.catches = 0; this.ext = null; if (this.ctx) this.stopWhoosh(); }
    if (this.ctx) this.applyIntensity(this.intensity(this.ctx.currentTime), this.ctx.currentTime, instant);
  }
  // Optional precise drive from the game: {progress: moveIdx/moves, crux, combo, pump}
  setIntensity(o) {
    this.ext = o;
    if (o && o.pump != null) this.setPump(o.pump);
  }
  intensity(now) {
    if (this.level === 3) return 5;
    if (now < this.topUntil) return 4;
    if (this.level === 0 || now < this.fallUntil) return 0;
    if (this.ext) {
      const p = this.ext.progress || 0;
      if (this.ext.crux || p >= 0.75) return 3;
      return p >= 1 / 3 || (this.ext.combo || 0) >= FLOW_COMBO ? 2 : 1;
    }
    if (this.catches >= 6) return 3;
    return this.catches >= 2 || this.level >= 2 ? 2 : 1;
  }
  applyIntensity(I, t, instant) {
    if (I === this.I && !instant) return;
    this.I = I;
    const mix = MIX[I], tau = PAD_ATTACK[I] / 3;
    for (const k in mix) {
      const p = this.layers[k].gain, v = k === 'pad' ? mix[k] : mix[k] * this.highCut(k);
      if (instant) p.setValueAtTime(v, t); else p.setTargetAtTime(v, t, k === 'pad' || k === 'choir' ? tau : 0.3);
    }
    if (!this.flying) this.padLP.frequency.setTargetAtTime(PAD_LP[I], t, instant ? 0.001 : 0.6);
    if (this.formants) {
      const v = I === 3 || I === 4 ? VOWEL.ah : VOWEL.oo;
      for (const fm of this.formants) fm.bp.frequency.setTargetAtTime(v[fm.k], t, 0.4);
    }
    if (I === 0 || I >= 4) this.setChord(I === 4 ? TOP[2] : MAIN[0], t);
  }
  // pump strips the high layers
  highCut(k) { return k === 'choir' || k === 'motif' || k === 'ost' ? 1 - 0.75 * this.pumpLevel : 1; }
  setPump(p) {
    if (Math.abs(p - this.pumpLevel) < 0.01 && !(p === 0 && this.pumpLevel !== 0)) return;
    this.pumpLevel = p;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const f = 650 * Math.pow(16000 / 650, 1 - Math.min(1, p * 1.1));
    this.musicLP.frequency.setTargetAtTime(f, now, 0.25);
    this.tremDepth.gain.setTargetAtTime(0.5 * p, now, 0.2);
    if (this.I >= 0) { const I = this.I; this.I = -1; this.applyIntensity(I, now); }
  }
  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.03);
  }
  pause(on) {
    if (!this.ctx || this.offline) return;
    if (on) this.ctx.suspend && this.ctx.suspend();
    else this.ctx.resume && this.ctx.resume();
  }

  // ---------- scheduler ----------
  // Look-ahead scheduler (25 ms timer, 140 ms ahead). Not named `tick`: that is the countdown cue.
  schedule() {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    this.run(c.currentTime + 0.14, c.currentTime);
  }
  run(ahead, now) {
    const sd = 60 / this.bpm / 4;
    if (this.nextT < now - 0.2) this.nextT = now + 0.02;
    this.applyIntensity(this.intensity(now), now);
    while (this.nextT < ahead) { this.scheduleStep(this.step, this.nextT, sd); this.nextT += sd; this.step++; }
    // heartbeat (pitched to D) & breathing when pumped
    if (this.pumpLevel > 0.05) {
      if (this.hbNext < now) this.hbNext = now + 0.05;
      while (this.hbNext < ahead) {
        const p = this.pumpLevel;
        this.tone({ t: this.hbNext, f: 73.4, f2: 55, dur: 0.16, g: 0.45 * p, glide: 0.12 });
        this.tone({ t: this.hbNext, f: 146.8, f2: 110, dur: 0.11, g: 0.2 * p, glide: 0.09 });
        this.noise({ t: this.hbNext, dur: 0.09, buf: 'brown', type: 'bandpass', f: 190, Q: 1.2, g: 0.22 * p, a: 0.006 });
        this.tone({ t: this.hbNext + 0.2, f: 65.4, f2: 49, dur: 0.14, g: 0.3 * p, glide: 0.1 });
        this.tone({ t: this.hbNext + 0.2, f: 130.8, f2: 98, dur: 0.1, g: 0.13 * p, glide: 0.08 });
        this.hbNext += 60 / (68 + 80 * p);
      }
      if (this.breathNext < now) {
        const p = this.pumpLevel;
        this.noise({ t: now + 0.05, dur: 0.42, buf: 'pink', type: 'bandpass', f: 750, f2: 520, Q: 1.2, g: 0.07 * p, a: 0.12 });
        this.breathNext = now + 1.4 - 0.6 * p;
      }
    }
    // distant gym: someone else falls on a pad
    if (!this.offline && now > this.thudNext) {
      const t = now + 0.05;
      this.tone({ t, f: 70, f2: 40, dur: 0.3, g: 0.22, dest: this.far });
      this.noise({ t, dur: 0.25, buf: 'brown', type: 'lowpass', f: 380, g: 0.3, dest: this.far });
      this.thudNext = now + 7 + this.rnd() * 12;
    }
  }
  scheduleStep(step, t, sd) {
    const I = this.I < 0 ? 0 : this.I;
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    const prog = I === 3 ? CRUX : MAIN;
    if (s === 0 && I >= 1 && I <= 3) this.setChord(prog[bar], t);
    if (I < 1 || I > 3) return;
    const ch = this.chord, L = this;
    const skipHit = Math.abs(t - this.skipHitT) < 0.05; // the catch already played this downbeat
    const brassBar = I === 3 || (I === 2 && bar % 2 === 0);
    // taiko: half-time feel, hits on the bar
    if (s === 0 && !skipHit) L.taiko(t, 'low', I === 1 ? 0.8 : 1, this.drumIn, I >= 2);
    if (I >= 2) {
      if (s === 8) L.taiko(t, 'low', 0.75);
      if (s === 6 || s === 12) L.taiko(t, 'mid', s === 12 ? 0.75 : 0.6);
      if (s === 11) L.taiko(t, 'mid', 0.3);            // flam into beat 4
      if (s === 13 && bar === 3) L.taiko(t, 'mid', 0.45);
    }
    if (I === 3) {
      if (s % 2 === 0 && s !== 0 && s !== 8) L.taiko(t, 'frame', 0.35);
      if (s === 14 || s === 15) L.taiko(t, 'mid', s === 15 ? 0.6 : 0.45); // tom fill into the next bar
    }
    // string ostinato on chord tones: r r 5 r 3 r 5 r (8ths at I1, 16ths from I2)
    const sixteenths = I >= 2 && !this.low;
    if ((sixteenths || s % 2 === 0) && !(s === 0 && brassBar)) {
      const k = sixteenths ? s % 8 : (s / 2) % 8;
      const base = ch.root + (ch.root < 41 ? 12 : 0) + 12;
      const iv = [0, 0, 7, 0, ch.third, 0, 7, 0][k] + (k % 2 === 1 && sixteenths ? 12 : 0);
      L.ost(t, base + iv, sixteenths ? 0.12 : 0.16, k === 0 ? 0.32 : 0.24);
    }
    // low brass braam on the downbeat
    if (s === 0 && brassBar) {
      const r = ch.root < 36 ? ch.root + 12 : ch.root;
      this.saws({ t, notes: [r, r + 7, r + 12], det: this.low ? [0] : [-8, 8], f0: 220, f1: 1600, f2: 800, sweep: 0.28, Q: 2,
        g: 0.22, a: 0.08, sus: 0.6, dur: sd * 12, rel: 0.9, dest: this.brassIn });
    }
    // crux motif (high strings/horn)
    if (I === 3) {
      for (const [st, m, len] of MOTIF[bar]) {
        if (st !== s) continue;
        this.saws({ t, notes: [m], det: this.low ? [0] : [-5, 5], f0: 1200, f1: 2600, f2: 1800, sweep: 0.15,
          g: 0.07, a: 0.06, sus: 0.8, dur: sd * len - 0.04, rel: 0.25, dest: this.layers.motif });
      }
    }
  }
  ost(t, midi, dur, g) {
    const c = this.ctx;
    const out = c.createGain(); this.env(out, t, g, 0.004, dur);
    let dest = out;
    if (!this.low) {
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1;
      f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.12);
      f.connect(out); dest = f;
    }
    out.connect(this.ostIn);
    for (const d of [-7, 7]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(midi); o.detune.value = d;
      o.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  // Restart the groove on the player's move: the catch becomes the downbeat of the next bar.
  downbeat(t) {
    if (!this.ctx) return;
    this.step = (Math.floor(this.step / 16) + 1) * 16;
    this.nextT = t;
    this.skipHitT = t;
  }

  // ---------- flight: rhythm steps aside, a riser peaks on the deadpoint ----------
  flight(T, t = this.now()) {
    const c = this.ctx; if (!c) return;
    this.stopWhoosh(t);
    this.flying = true;
    this.rhythm.gain.cancelScheduledValues(t);
    this.rhythm.gain.setTargetAtTime(0.316, t, 0.013);
    this.padLP.frequency.cancelScheduledValues(t);
    this.padLP.frequency.setTargetAtTime(2400, t, Math.max(0.05, T / 3));
    const hold = T + 1.6; // slow motion stretches the real flight: hold the peak until the TAC cuts it
    const cut = c.createGain(); cut.gain.value = 1; cut.connect(this.music);
    const a = this.noise({ t, dur: hold, buf: 'pink', type: 'bandpass', f: 400, f2: 5000, sweep: T, Q: 1.6, g: 0.0002, dest: cut });
    const b = this.noise({ t, dur: hold, buf: 'white', type: 'highpass', f: 6000, Q: 0.7, g: 0.0002, dest: cut });
    for (const [n, peak] of [[a, 0.5], [b, 0.22]]) {
      const g = n.g.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(peak, t + T);
      g.setValueAtTime(peak, t + hold - 0.15);
      g.exponentialRampToValueAtTime(0.0001, t + hold);
    }
    this.whooshNode = { cut, t0: t };
  }
  stopWhoosh(at) {
    const c = this.ctx; if (!c) return;
    const t = at ?? c.currentTime;
    if (this.whooshNode) {
      const g = this.whooshNode.cut.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(0, t, 0.008);
      this.whooshNode = null;
    }
    if (this.flying) {
      this.flying = false;
      this.rhythm.gain.cancelScheduledValues(t);
      this.rhythm.gain.setTargetAtTime(1, t + 0.03, 0.1);
      this.padLP.frequency.cancelScheduledValues(t);
      this.padLP.frequency.setTargetAtTime(PAD_LP[Math.max(0, this.I)], t, 0.5);
    }
  }
  duckMusic(t, depth = 0.6) {
    const g = this.duck.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(depth, t); g.setTargetAtTime(1, t + 0.02, 0.12);
  }

  // ---------- game foley ----------
  now() { return this.ctx ? this.ctx.currentTime + 0.004 : 0; }
  ui() { if (!this.ctx) return; this.tone({ t: this.now(), f: 880, f2: 1320, dur: 0.05, g: 0.06, glide: 0.04 }); }
  launch(dyno, T) {
    if (!this.ctx) return;
    const t = this.now();
    this.noise({ t, dur: 0.16, buf: 'pink', type: 'bandpass', f: 1150, Q: 1, g: 0.14, a: 0.012 });
    this.noise({ t, dur: 0.05, buf: 'white', type: 'highpass', f: 4200, g: 0.05 });
    if (dyno) this.grunt(t + 0.02, 0.95 + this.rnd() * 0.15, 0.17, 0.26);
    this.tickN = 0;
    this.flight(T, t);
  }
  catchHold(q, combo, holdType) {
    if (!this.ctx) return;
    const t = this.now();
    this.stopWhoosh(t);
    this.catches++;
    const k = q === 'perfect' ? 1 : q === 'good' ? 0.85 : 0.78;
    const bright = holdType === 'jug' ? 0.85 : holdType === 'sloper' ? 0.7 : 1.15;
    // hand slap
    this.noise({ t, dur: 0.07, buf: 'white', type: 'bandpass', f: (2000 + this.rnd() * 500) * bright, Q: 0.8, g: 0.5 * k, a: 0.001 });
    this.tone({ t, f: 430 + this.rnd() * 50, f2: 300, dur: 0.06, g: 0.1, wave: 'triangle' });
    this.noise({ t: t + 0.015, dur: 0.3, buf: 'pink', type: 'highpass', f: 2600, Q: 0.5, g: 0.09, a: 0.03 });
    if (q === 'ok') {
      this.tone({ t, f: 150, f2: 60, dur: 0.17, g: 0.7, glide: 0.1 });
      this.grunt(t + 0.03, 0.9, 0.13, 0.22);
    } else {
      this.taiko(t, 'low', q === 'perfect' ? 1 : 0.8, this.hits, true);
      this.duckMusic(t);
    }
    if (q === 'perfect') {
      // choir swell: the chord's fifth, then the root on the next perfect
      const r = 57 + ((((this.chord.root - 57) % 12) + 12) % 12);
      this.voice(t + 0.01, this.perfectN++ % 2 ? r + 12 : r + 7, combo >= 3 ? 0.16 : 0.12, 1.1);
    }
    this.downbeat(t);
  }
  miss(reason) {
    if (!this.ctx) return;
    const t = this.now();
    this.stopWhoosh(t);
    this.noise({ t, dur: 0.32, buf: 'white', type: 'bandpass', f: 3200, f2: 700, Q: 2, g: 0.4, a: 0.005 });
    this.grunt(t + 0.05, reason === 'pump' ? 0.85 : 1.08, 0.18, 0.3);
    // dissonant low brass bend D -> C# down
    this.saws({ t, notes: [38, 50], det: this.low ? [0] : [-8, 8], bend: -1, f0: 300, f1: 900, sweep: 0.2, Q: 2, g: 0.2, a: 0.04, sus: 0.7, dur: 0.6, rel: 0.4, dest: this.hits });
  }
  // the fall: tape stop (pad bends down 2 semitones, music fades), low boom, silence, the drone returns
  fallWhoosh() {
    if (!this.ctx) return;
    const t = this.now();
    this.stopWhoosh(t);
    this.catches = 0;
    this.noise({ t, dur: 0.75, buf: 'pink', type: 'lowpass', f: 2600, f2: 380, Q: 0.6, g: 0.16, a: 0.08 });
    for (const tg of [this.tape.gain, this.wetTape.gain]) {
      tg.cancelScheduledValues(t); tg.setValueAtTime(tg.value, t);
      tg.linearRampToValueAtTime(0.0001, t + 0.5);
      tg.setValueAtTime(0.0001, t + 2.0);
      tg.linearRampToValueAtTime(1, t + 3.2);
    }
    if (this.bend) {
      const b = this.bend.offset;
      b.cancelScheduledValues(t); b.setValueAtTime(0, t);
      b.linearRampToValueAtTime(-200, t + 0.5);
      b.setValueAtTime(0, t + 1.9);
    }
    this.tone({ t: t + 0.45, f: 60, f2: 30, dur: 1.3, glide: 0.9, g: 0.8, dest: this.hits });
    this.fallUntil = t + 3.4;
  }
  land(hard = 1) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 78, f2: 36, dur: 0.38, g: 0.85 * hard, glide: 0.3 });
    this.tone({ t, f: 170, f2: 85, dur: 0.16, g: 0.35 * hard, glide: 0.12 });
    this.noise({ t, dur: 0.3, buf: 'brown', type: 'lowpass', f: 420, g: 0.65 * hard, a: 0.003 });
    this.noise({ t: t + 0.02, dur: 0.6, buf: 'pink', type: 'bandpass', f: 520, Q: 0.8, g: 0.12 * hard, a: 0.04 });
    this.noise({ t: t + 0.03, dur: 0.08, buf: 'white', type: 'highpass', f: 5000, g: 0.05 });
    this.duckMusic(t, 0.5);
  }
  feet(q) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 1900, f2: 2800, dur: 0.06, g: 0.05, glide: 0.05 });
    this.tone({ t, f: 220, f2: 90, dur: 0.08, g: q ? 0.3 : 0.18 });
    this.noise({ t, dur: 0.035, buf: 'white', type: 'highpass', f: 4200, g: 0.05 });
    if (q === 'perfect') this.taiko(t, 'mid', 0.7, this.hits);
  }
  footstep() {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 240, f2: 110, dur: 0.06, g: 0.12 });
    if (this.rnd() < 0.6) this.tone({ t, f: 2100 + this.rnd() * 500, f2: 2900, dur: 0.04, g: 0.02, glide: 0.035 });
  }
  feetMiss() {
    if (!this.ctx) return;
    const t = this.now();
    this.noise({ t, dur: 0.22, buf: 'white', type: 'bandpass', f: 2400, f2: 900, Q: 1.6, g: 0.18 });
    this.noise({ t: t + 0.05, dur: 0.5, buf: 'pink', type: 'bandpass', f: 500, f2: 900, Q: 1, g: 0.08, a: 0.1 });
    this.grunt(t + 0.08, 1.0, 0.1, 0.22);
  }
  startRest() {
    const c = this.ctx; if (!c || this.restNode) return;
    const src = c.createBufferSource(); src.buffer = this.pink; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1700; f.Q.value = 0.6;
    const g = c.createGain(); g.gain.value = 0;
    const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 7.5;
    const lg = c.createGain(); lg.gain.value = 0.045;
    const bias = c.createConstantSource ? c.createConstantSource() : null;
    lfo.connect(lg); lg.connect(g.gain);
    if (bias) { bias.offset.value = 0.045; bias.connect(g.gain); bias.start(); }
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start(); lfo.start();
    this.restNode = { src, lfo, bias, g };
  }
  stopRest() {
    const n = this.restNode; if (!n || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const s of [n.src, n.lfo, n.bias]) if (s) { try { s.stop(t + 0.05); } catch (e) { /* already stopped */ } }
    this.restNode = null;
  }
  // "Allez!" from a friend below: a formant-filtered saw voice, two syllables (a-LEZ) with the
  // stress and the pitch peak on the second, a short "z" of noise at the end. No samples.
  allez(t = this.now()) {
    const c = this.ctx; if (!c) return;
    const T = (x) => t + x;
    const out = c.createGain(); out.gain.value = 0.45; out.connect(this.sfx);
    // pitch: a shout, rising into the stressed syllable
    const voices = [0, 9].map((det) => {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.detune.value = det;
      const f = o.frequency;
      f.setValueAtTime(205, T(0)); f.linearRampToValueAtTime(228, T(0.12));
      f.linearRampToValueAtTime(215, T(0.16)); f.linearRampToValueAtTime(300, T(0.26));
      f.linearRampToValueAtTime(285, T(0.4)); f.linearRampToValueAtTime(230, T(0.52));
      return o;
    });
    const vib = c.createOscillator(); vib.frequency.value = 6.5;
    const vg = c.createGain(); vg.gain.value = 5; vib.connect(vg);
    // vowel envelope: "a" (open), a quick "l" dip, "e" (stressed, long)
    const amp = c.createGain(); const a = amp.gain;
    a.setValueAtTime(0.0001, T(0)); a.exponentialRampToValueAtTime(0.5, T(0.03));
    a.setValueAtTime(0.45, T(0.11)); a.exponentialRampToValueAtTime(0.12, T(0.15));
    a.exponentialRampToValueAtTime(0.7, T(0.21)); a.setValueAtTime(0.62, T(0.4));
    a.exponentialRampToValueAtTime(0.0001, T(0.54));
    for (const o of voices) { vg.connect(o.frequency); o.connect(amp); }
    // formants (F1, F2, F3) morph a → l → e
    const F = [[760, 350, 470], [1250, 1050, 1950], [2600, 2500, 2650]], G = [1, 0.55, 0.22];
    F.forEach((fs, i) => {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = i === 0 ? 7 : 9;
      bp.frequency.setValueAtTime(fs[0], T(0)); bp.frequency.setValueAtTime(fs[0], T(0.11));
      bp.frequency.linearRampToValueAtTime(fs[1], T(0.15)); bp.frequency.linearRampToValueAtTime(fs[2], T(0.21));
      const g = c.createGain(); g.gain.value = G[i] * 0.55;
      amp.connect(bp); bp.connect(g); g.connect(out);
    });
    for (const o of voices) { o.start(T(0)); o.stop(T(0.58)); }
    vib.start(T(0)); vib.stop(T(0.58));
    // breath on the attack and the final "z"
    this.noise({ t: T(0), dur: 0.05, buf: 'white', type: 'bandpass', f: 1400, Q: 0.8, g: 0.05, dest: out });
    this.noise({ t: T(0.44), dur: 0.1, buf: 'white', type: 'highpass', f: 4200, g: 0.06, a: 0.02, dest: out });
  }
  // allez tapped: a warm lift (major third up), the friend's energy
  allezTap() {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: mtof(76), dur: 0.22, g: 0.07, wave: 'triangle' });
    this.tone({ t: t + 0.07, f: mtof(80), dur: 0.26, g: 0.07, wave: 'triangle' });
    this.tone({ t: t + 0.14, f: mtof(83), dur: 0.4, g: 0.07, wave: 'triangle' });
  }
  // bubbles: a soft rising blip when one appears, a pop when tapped
  bubble(kind) {
    if (!this.ctx) return;
    const t = this.now(), hi = kind === 'jump';
    this.tone({ t, f: hi ? 660 : 520, f2: hi ? 1320 : 880, dur: hi ? 0.1 : 0.14, g: 0.05, glide: 0.09, wave: 'triangle' });
  }
  pop(kind) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 900, f2: 1800, dur: 0.05, g: 0.08, glide: 0.04 });
    this.noise({ t, dur: 0.04, buf: 'white', type: 'bandpass', f: 3200, Q: 1.5, g: 0.1 });
    if (kind === 'chalk') { // hand in the bag: a dry pat and a puff
      this.noise({ t: t + 0.12, dur: 0.08, buf: 'pink', type: 'bandpass', f: 900, Q: 0.9, g: 0.16 });
      this.noise({ t: t + 0.34, dur: 0.35, buf: 'white', type: 'bandpass', f: 2600, f2: 1200, Q: 0.7, g: 0.07, a: 0.02 });
    } else if (kind === 'jump') {
      this.tone({ t: t + 0.04, f: mtof(76), dur: 0.12, g: 0.06, wave: 'triangle' });
      this.tone({ t: t + 0.1, f: mtof(83), dur: 0.18, g: 0.06, wave: 'triangle' });
    }
  }
  // jump bubble countdown blip (one per remaining step)
  countTick(n) {
    if (!this.ctx) return;
    this.tone({ t: this.now(), f: mtof(84 - n * 2), dur: 0.035, g: 0.04, wave: 'square', lp: 2500 });
  }
  ledBlip(i) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: mtof(74 + [0, 3, 5, 7, 10, 12, 15, 17][i % 8]), dur: 0.07, g: 0.035, wave: 'triangle' });
  }
  // Countdown to the deadpoint: tic (A4), tic (C5, C#5 in the crux), TAC (D, a taiko + chord stab).
  // Tap on the TAC. `delay` in seconds from now.
  tick(accent, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + Math.max(0, delay) + 0.004;
    if (t - this.lastTickT > 0.8) this.tickN = 0;
    this.lastTickT = t;
    if (!this.flying) { // feet / match countdowns: the rhythm steps aside too
      const g = this.rhythm.gain;
      g.cancelScheduledValues(t); g.setTargetAtTime(0.316, t - 0.05, 0.013);
      g.setTargetAtTime(1, t + (accent ? 0.25 : 0.9), 0.15); // a later tick cancels this restore
    }
    if (accent) {
      this.tickN = 0;
      if (this.whooshNode) { // reverse cymbal: hard cut on the deadpoint
        const g = this.whooshNode.cut.gain;
        g.cancelScheduledValues(t); g.setValueAtTime(1, t); g.setTargetAtTime(0, t, 0.006);
        this.whooshNode = null;
      }
      this.taiko(t, 'low', 0.9, this.hits, true);
      const ch = this.chord, r = ch.root + (ch.root < 41 ? 24 : 12);
      this.saws({ t, notes: [r, r + 7, r + 12], det: this.low ? [0] : [-7, 7], f0: 3000, f1: 900, sweep: 0.25, Q: 1, g: 0.12, a: 0.006, sus: 0.5, dur: 0.18, rel: 0.12, dest: this.hits });
      this.tone({ t, f: mtof(74), dur: 0.3, g: 0.12, wave: 'triangle' });
      this.tone({ t, f: mtof(86), dur: 0.12, g: 0.03, wave: 'triangle' });
      this.noise({ t, dur: 0.03, buf: 'white', type: 'bandpass', f: 3400, Q: 2.2, g: 0.16 });
      this.duckMusic(t);
    } else {
      const m = this.tickN++ === 0 ? 69 : this.I === 3 ? 73 : 72;
      this.tone({ t, f: mtof(m), dur: 0.08, g: 0.13, wave: 'triangle' });
      this.tone({ t, f: mtof(m + 12), dur: 0.04, g: 0.04, wave: 'triangle' });
      this.noise({ t, dur: 0.02, buf: 'white', type: 'bandpass', f: 2400, Q: 2.2, g: 0.16 });
    }
  }
  matchCue() {
    if (!this.ctx) return;
    this.tone({ t: this.now(), f: mtof(81), dur: 0.08, g: 0.04, wave: 'triangle' });
  }
  // top stinger: gong + taiko + crash, then Bb – C – D major (brass, strings, choir), applause
  top(flash) {
    if (!this.ctx) return;
    const c = this.ctx, t = this.now();
    this.stopWhoosh(t);
    this.catches = 0;
    this.topUntil = t + 4;
    this.applyIntensity(4, t);
    this.duckMusic(t, 0.5);
    this.taiko(t, 'low', 1.3, this.hits, true);
    this.taiko(t + 0.33, 'mid', 0.8, this.hits);
    this.taiko(t + 0.66, 'low', 1.3, this.hits, true);
    // gong: FM 1:1.41, index 2 -> 0.1 over 3 s
    const car = c.createOscillator(); car.frequency.value = 98;
    const mod = c.createOscillator(); mod.frequency.value = 98 * 1.41;
    const mg = c.createGain(); mg.gain.setValueAtTime(98 * 2, t); mg.gain.exponentialRampToValueAtTime(98 * 0.1, t + 3);
    mod.connect(mg); mg.connect(car.frequency);
    const gg = c.createGain(); this.env(gg, t, 0.3, 0.01, 4);
    car.connect(gg); gg.connect(this.sfx);
    const gs = c.createGain(); gs.gain.value = 0.5; gg.connect(gs); gs.connect(this.verb);
    for (const o of [car, mod]) { o.start(t); o.stop(t + 4.1); }
    this.noise({ t, dur: 2.4, buf: 'white', type: 'highpass', f: 5000, Q: 0.5, g: 0.08, a: 0.01 });
    TOP.forEach((ch, i) => {
      const tt = t + i * 0.33, hold = i === 2 ? 3 : 0.28;
      const r = ch.root < 36 ? ch.root + 12 : ch.root;
      this.saws({ t: tt, notes: [r, r + 7, r + 12], det: this.low ? [0] : [-8, 8], f0: 400, f1: 2200, f2: 1200, sweep: 0.15, Q: 1.5,
        g: 0.16, a: 0.02, sus: 0.7, dur: hold, rel: 0.8, dest: this.hits });
      this.saws({ t: tt, notes: ch.pad.slice(1).map((m) => m + 12), det: [0], f0: 1500, f1: 3500, f2: 2400, sweep: 0.1,
        g: 0.035, a: 0.02, sus: 0.8, dur: hold, rel: 0.9, dest: this.sfx });
    });
    this.voice(t + 0.66, 62, 0.12, 3.2);
    if (flash) this.saws({ t: t + 0.66, notes: [86], det: [-6, 6], f0: 2000, f1: 4000, sweep: 0.6, g: 0.04, a: 0.4, sus: 0.9, dur: 2.6, rel: 1, dest: this.sfx });
    // gym applause: dense short noise claps with a swell
    const n = (flash ? 110 : 70) * (this.low ? 0.5 : 1);
    for (let i = 0; i < n; i++) {
      const u = this.rnd();
      const tt = t + 0.12 + Math.pow(u, 1.6) * 1.9;
      const amp = (0.03 + this.rnd() * 0.06) * (1 - 0.5 * u);
      this.noise({ t: tt, dur: 0.018 + this.rnd() * 0.02, buf: 'white', type: 'bandpass', f: 1100 + this.rnd() * 1500, Q: 1.3, g: amp, pan: this.rnd() * 1.4 - 0.7 });
    }
  }
  over() {
    if (!this.ctx) return;
    const t = this.now();
    [69, 65, 64, 62].forEach((m, i) => this.saws({ t: t + i * 0.45, notes: [m], det: [-5, 5], f0: 900, f1: 1800, f2: 1200, sweep: 0.2,
      g: 0.05, a: 0.08, sus: 0.8, dur: i === 3 ? 1.6 : 0.4, rel: 0.6, dest: this.sfx }));
    this.saws({ t, notes: [38, 45], det: [-8, 8], f0: 200, f1: 700, sweep: 0.5, Q: 1.5, g: 0.12, a: 0.3, sus: 0.8, dur: 2.4, rel: 1.2, dest: this.hits });
  }
}
