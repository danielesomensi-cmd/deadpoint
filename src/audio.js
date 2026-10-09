// DEADPOINT — procedural audio (Web Audio API, no samples).
// Dynamic lo-fi score with layers that follow the climb, plus synthesized foley.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];

// 4-bar progression in C: Dm9 – G13 – Cmaj9 – Am9
const CHORDS = [
  { root: 38, keys: [50, 53, 57, 60, 64] },
  { root: 43, keys: [43, 53, 59, 64] },
  { root: 36, keys: [48, 52, 55, 59, 62] },
  { root: 33, keys: [45, 55, 60, 64, 71] },
];
const ARP_POOL = [62, 64, 67, 69, 72, 74, 76, 79];

export class Sound {
  constructor() {
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
    this.bpm = 86;
    this.arpNote = 4;
    this.whooshNode = null;
    this.restNode = null;
  }

  // Must be called from a user gesture (or with an OfflineAudioContext for tests).
  init(ctx) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
      return;
    }
    try { if (!ctx && navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && !AC) return;
    let c;
    try { c = this.ctx = ctx || new AC({ latencyHint: 'interactive' }); } catch (e) { this.ctx = null; return; }
    this.offline = !!ctx;

    this.out = c.createGain();
    this.out.gain.value = this.muted ? 0 : 1;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3.2;
    comp.attack.value = 0.003; comp.release.value = 0.22;
    this.out.connect(comp); comp.connect(c.destination);
    this.master = c.createGain(); this.master.gain.value = 0.85; this.master.connect(this.out);

    this.verb = c.createConvolver();
    this.verb.buffer = this.impulse(2.3, 3.0);
    const verbRet = c.createGain(); verbRet.gain.value = 0.55;
    this.verb.connect(verbRet); verbRet.connect(this.master);

    this.sfx = c.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    const sfxSend = c.createGain(); sfxSend.gain.value = 0.15;
    this.sfx.connect(sfxSend); sfxSend.connect(this.verb);
    this.far = c.createGain(); this.far.gain.value = 1; // distant gym sounds: mostly reverb
    const farLP = c.createBiquadFilter(); farLP.type = 'lowpass'; farLP.frequency.value = 900;
    this.far.connect(farLP); farLP.connect(this.verb);
    const farDry = c.createGain(); farDry.gain.value = 0.25; farLP.connect(farDry); farDry.connect(this.master);

    this.music = c.createGain(); this.music.gain.value = 0.32;
    this.musicLP = c.createBiquadFilter(); this.musicLP.type = 'lowpass';
    this.musicLP.frequency.value = 16000; this.musicLP.Q.value = 0.6;
    this.music.connect(this.musicLP); this.musicLP.connect(this.master);
    const musSend = c.createGain(); musSend.gain.value = 0.3;
    this.musicLP.connect(musSend); musSend.connect(this.verb);

    this.layers = {};
    for (const k of ['keys', 'bass', 'drums', 'hats', 'arp', 'bed']) {
      const g = c.createGain(); g.gain.value = 0.0001; g.connect(this.music); this.layers[k] = g;
    }
    this.white = this.noiseBuf('white', 2.5);
    this.pink = this.noiseBuf('pink', 4);
    this.brown = this.noiseBuf('brown', 4);

    // Room tone: ventilation hum, always on, very quiet.
    const room = c.createBufferSource(); room.buffer = this.brown; room.loop = true;
    const roomLP = c.createBiquadFilter(); roomLP.type = 'lowpass'; roomLP.frequency.value = 320;
    const roomG = c.createGain(); roomG.gain.value = 0.014;
    room.connect(roomLP); roomLP.connect(roomG); roomG.connect(this.master); room.start();
    // Vinyl bed for the score.
    const bed = c.createBufferSource(); bed.buffer = this.pink; bed.loop = true;
    const bedBP = c.createBiquadFilter(); bedBP.type = 'bandpass'; bedBP.frequency.value = 3000; bedBP.Q.value = 0.4;
    const bedG = c.createGain(); bedG.gain.value = 0.05;
    bed.connect(bedBP); bedBP.connect(bedG); bedG.connect(this.layers.bed); bed.start();

    this.setLevel(0, true);
    if (!this.offline) {
      // iOS unlock: a silent buffer started inside the gesture.
      const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
      if (c.resume) c.resume();
      this.nextT = c.currentTime + 0.1;
      this.thudNext = c.currentTime + 4;
      this.timer = setInterval(() => this.tick(), 25);
    }
  }

  // ---------- building blocks ----------
  noiseBuf(kind, secs) {
    const c = this.ctx, n = Math.floor(c.sampleRate * secs);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }
  impulse(secs, decay) {
    const c = this.ctx, n = Math.floor(c.sampleRate * secs);
    const buf = c.createBuffer(2, n, c.sampleRate);
    const pre = Math.floor(c.sampleRate * 0.012);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = pre; i < n; i++) {
        const x = (i - pre) / (n - pre);
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, decay) * (x < 0.02 ? 0.6 : 1);
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
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
    f.Q.value = o.Q ?? 1;
    const g = c.createGain(); this.env(g, t, o.g ?? 0.3, o.a ?? 0.002, dur);
    src.connect(f); f.connect(g);
    let last = g;
    if (o.pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = o.pan; g.connect(p); last = p; }
    last.connect(o.dest || this.sfx);
    const maxOff = Math.max(0, src.buffer.duration - dur - 0.1);
    src.start(t, Math.random() * maxOff, dur + 0.05);
    return { src, g, f };
  }
  tone(o) {
    const c = this.ctx; if (!c) return null;
    const t = o.t ?? c.currentTime, dur = o.dur ?? 0.2;
    const osc = c.createOscillator(); osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide ?? dur));
    const g = c.createGain(); this.env(g, t, o.g ?? 0.2, o.a ?? 0.003, dur);
    osc.connect(g);
    let last = g;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); last = f; }
    last.connect(o.dest || this.sfx);
    osc.start(t); osc.stop(t + dur + 0.05);
    return osc;
  }
  bell(t, freq, gain = 0.15, dur = 1.3, dest) {
    const c = this.ctx; if (!c) return;
    const car = c.createOscillator(); car.frequency.value = freq;
    const mod = c.createOscillator(); mod.frequency.value = freq * 2;
    const mg = c.createGain();
    mg.gain.setValueAtTime(freq * 1.6, t);
    mg.gain.exponentialRampToValueAtTime(freq * 0.04, t + dur * 0.5);
    mod.connect(mg); mg.connect(car.frequency);
    const g = c.createGain(); this.env(g, t, gain, 0.004, dur);
    car.connect(g); g.connect(dest || this.sfx);
    const shimmer = c.createOscillator(); shimmer.frequency.value = freq * 4.01;
    const sg = c.createGain(); this.env(sg, t, gain * 0.12, 0.002, dur * 0.35);
    shimmer.connect(sg); sg.connect(dest || this.sfx);
    for (const o of [car, mod, shimmer]) { o.start(t); o.stop(t + dur + 0.05); }
  }
  ep(t, midi, gain, dur, dest) {
    // electric-piano voice: 1:1 FM with a quick index decay + soft tine
    const c = this.ctx; const f = mtof(midi);
    const car = c.createOscillator(); car.frequency.value = f;
    const mod = c.createOscillator(); mod.frequency.value = f;
    const mg = c.createGain();
    mg.gain.setValueAtTime(f * 0.9, t); mg.gain.exponentialRampToValueAtTime(f * 0.08, t + 0.35);
    mod.connect(mg); mg.connect(car.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    car.connect(g); g.connect(lp); lp.connect(dest);
    const tine = c.createOscillator(); tine.frequency.value = f * 7.02;
    const tg = c.createGain(); this.env(tg, t, gain * 0.05, 0.002, 0.25);
    tine.connect(tg); tg.connect(dest);
    for (const o of [car, mod, tine]) { o.start(t); o.stop(t + dur + 0.05); }
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

  // ---------- music ----------
  setLevel(level, instant) {
    if (level === this.level && !instant) return;
    this.level = level;
    if (!this.ctx) return;
    const mix = [
      { keys: 0.65, bass: 0.45, drums: 0.0001, hats: 0.0001, arp: 0.0001, bed: 1 },
      { keys: 0.42, bass: 0.6, drums: 0.75, hats: 0.22, arp: 0.0001, bed: 0.8 },
      { keys: 0.42, bass: 0.65, drums: 0.85, hats: 0.5, arp: 0.42, bed: 0.8 },
      { keys: 0.0001, bass: 0.0001, drums: 0.0001, hats: 0.0001, arp: 0.0001, bed: 0.4 },
    ][level];
    const now = this.ctx.currentTime;
    for (const k in mix) {
      const p = this.layers[k].gain;
      if (instant) p.setValueAtTime(mix[k], now);
      else p.setTargetAtTime(mix[k], now, 0.35);
    }
  }
  setPump(p) {
    if (Math.abs(p - this.pumpLevel) < 0.01 && !(p === 0 && this.pumpLevel !== 0)) return;
    this.pumpLevel = p;
    if (!this.ctx) return;
    const f = 650 * Math.pow(16000 / 650, 1 - Math.min(1, p * 1.1));
    this.musicLP.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.25);
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
  tick() {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    const ahead = c.currentTime + 0.14;
    const sd = 60 / this.bpm / 4;
    if (this.nextT < c.currentTime - 0.2) this.nextT = c.currentTime + 0.02;
    while (this.nextT < ahead) { this.scheduleStep(this.step, this.nextT, sd); this.nextT += sd; this.step++; }
    // heartbeat & breathing when pumped
    if (this.pumpLevel > 0.05) {
      if (this.hbNext < c.currentTime) this.hbNext = c.currentTime + 0.05;
      while (this.hbNext < ahead) {
        const p = this.pumpLevel;
        this.tone({ t: this.hbNext, f: 62, f2: 44, dur: 0.16, g: 0.45 * p, glide: 0.12 });
        this.tone({ t: this.hbNext, f: 124, f2: 90, dur: 0.11, g: 0.2 * p, glide: 0.09 });
        this.noise({ t: this.hbNext, dur: 0.09, buf: 'brown', type: 'bandpass', f: 190, Q: 1.2, g: 0.22 * p, a: 0.006 });
        this.tone({ t: this.hbNext + 0.2, f: 56, f2: 40, dur: 0.14, g: 0.3 * p, glide: 0.1 });
        this.tone({ t: this.hbNext + 0.2, f: 112, f2: 82, dur: 0.1, g: 0.13 * p, glide: 0.08 });
        this.hbNext += 60 / (68 + 80 * p);
      }
      if (this.breathNext < c.currentTime) {
        const p = this.pumpLevel;
        this.noise({ t: c.currentTime + 0.05, dur: 0.42, buf: 'pink', type: 'bandpass', f: 750, f2: 520, Q: 1.2, g: 0.07 * p, a: 0.12 });
        this.breathNext = c.currentTime + 1.4 - 0.6 * p;
      }
    }
    // distant gym: someone else falls on a pad
    if (c.currentTime > this.thudNext) {
      const t = c.currentTime + 0.05;
      this.tone({ t, f: 70, f2: 40, dur: 0.3, g: 0.22, dest: this.far });
      this.noise({ t, dur: 0.25, buf: 'brown', type: 'lowpass', f: 380, g: 0.3, dest: this.far });
      this.thudNext = c.currentTime + 7 + Math.random() * 12;
    }
  }
  scheduleStep(step, t, sd) {
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    const ch = CHORDS[bar];
    const L = this.layers;
    const swing = s % 2 === 1 ? sd * 0.18 : 0;
    const tt = t + swing;
    if (s === 0) for (const m of ch.keys) this.ep(t + Math.random() * 0.012, m, 0.07, 60 / this.bpm * 3.6, L.keys);
    if (s === 10) for (const m of ch.keys.slice(-3)) this.ep(tt, m, 0.04, 0.5, L.keys);
    if (s === 0 || s === 6 || s === 14) {
      const m = s === 14 ? ch.root + 7 : ch.root;
      this.tone({ t: s === 6 ? tt : t, f: mtof(m), dur: s === 14 ? 0.18 : 0.42, g: 0.32, wave: 'triangle', lp: 420, dest: L.bass, a: 0.01 });
    }
    if (s === 0 || s === 7 || s === 10) {
      this.tone({ t: s === 7 ? tt : t, f: 140, f2: 46, dur: 0.32, g: 0.85, glide: 0.11, dest: L.drums });
      this.noise({ t, dur: 0.012, buf: 'white', type: 'highpass', f: 3000, g: 0.05, dest: L.drums });
    }
    if (s === 4 || s === 12) {
      this.noise({ t, dur: 0.17, buf: 'white', type: 'bandpass', f: 1900, Q: 0.7, g: 0.32, dest: L.drums });
      this.tone({ t, f: 196, f2: 150, dur: 0.09, g: 0.22, wave: 'triangle', dest: L.drums });
    }
    if (s % 2 === 0) this.noise({ t: tt, dur: s % 4 === 2 ? 0.05 : 0.03, buf: 'white', type: 'highpass', f: 7600, g: s % 4 === 2 ? 0.12 : 0.07, dest: L.hats });
    if (s % 2 === 0 && Math.random() < 0.62) {
      this.arpNote = Math.max(0, Math.min(ARP_POOL.length - 1, this.arpNote + [-2, -1, 1, 1, 2][Math.floor(Math.random() * 5)]));
      this.bell(tt, mtof(ARP_POOL[this.arpNote]), 0.05, 0.6, L.arp);
    }
    if (Math.random() < 0.35) this.noise({ t: t + Math.random() * sd, dur: 0.004, buf: 'white', type: 'highpass', f: 1800, g: 0.02 + Math.random() * 0.05, dest: L.bed });
  }

  // ---------- game foley ----------
  now() { return this.ctx ? this.ctx.currentTime + 0.004 : 0; }
  ui() { if (!this.ctx) return; this.tone({ t: this.now(), f: 880, f2: 1320, dur: 0.05, g: 0.06, glide: 0.04 }); }
  launch(dyno, T) {
    if (!this.ctx) return;
    const t = this.now();
    this.noise({ t, dur: 0.16, buf: 'pink', type: 'bandpass', f: 1150, Q: 1, g: 0.14, a: 0.012 });
    this.noise({ t, dur: 0.05, buf: 'white', type: 'highpass', f: 4200, g: 0.05 });
    if (dyno) this.grunt(t + 0.02, 0.95 + Math.random() * 0.15, 0.17, 0.26);
    this.stopWhoosh();
    const w = this.noise({ t, dur: T + 0.15, buf: 'pink', type: 'bandpass', f: 320, f2: 1500, Q: 1.4, g: 0.0002, a: 0.01 });
    if (w) {
      const g = w.g.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(0.055, t + T * 0.9);
      g.exponentialRampToValueAtTime(0.0001, t + T + 0.14);
      this.whooshNode = w;
    }
  }
  stopWhoosh() {
    if (this.whooshNode && this.ctx) {
      const g = this.whooshNode.g.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t); g.setTargetAtTime(0.0001, t, 0.02);
      this.whooshNode = null;
    }
  }
  scaleFreq(step) { return mtof(72 + PENTA[Math.min(step, PENTA.length - 1)]); }
  catchHold(q, combo, holdType) {
    if (!this.ctx) return;
    this.stopWhoosh();
    const t = this.now();
    const k = q === 'perfect' ? 1 : q === 'good' ? 0.85 : 0.78;
    const bright = holdType === 'jug' ? 0.85 : holdType === 'sloper' ? 0.7 : 1.15;
    this.noise({ t, dur: 0.07, buf: 'white', type: 'bandpass', f: (2000 + Math.random() * 500) * bright, Q: 0.8, g: 0.5 * k, a: 0.001 });
    this.tone({ t, f: 175, f2: 66, dur: 0.17, g: 0.8 * k, glide: 0.1 });
    this.tone({ t, f: 430 + Math.random() * 50, f2: 300, dur: 0.06, g: 0.1, wave: 'triangle' });
    this.noise({ t: t + 0.015, dur: 0.3, buf: 'pink', type: 'highpass', f: 2600, Q: 0.5, g: 0.09, a: 0.03 });
    if (q === 'perfect') {
      this.bell(t + 0.01, this.scaleFreq(Math.max(0, combo - 1)), 0.13, 1.2);
      if (combo >= 3) this.bell(t + 0.07, this.scaleFreq(Math.max(0, combo + 1)), 0.06, 0.9);
    }
    if (q === 'ok') this.grunt(t + 0.03, 0.9, 0.13, 0.22);
  }
  miss(reason) {
    if (!this.ctx) return;
    this.stopWhoosh();
    const t = this.now();
    this.noise({ t, dur: 0.32, buf: 'white', type: 'bandpass', f: 3200, f2: 700, Q: 2, g: 0.4, a: 0.005 });
    this.grunt(t + 0.05, reason === 'pump' ? 0.85 : 1.08, 0.18, 0.3);
  }
  fallWhoosh() {
    if (!this.ctx) return;
    const t = this.now();
    this.noise({ t, dur: 0.75, buf: 'pink', type: 'lowpass', f: 2600, f2: 380, Q: 0.6, g: 0.16, a: 0.08 });
  }
  land(hard = 1) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 78, f2: 36, dur: 0.38, g: 0.85 * hard, glide: 0.3 });
    this.tone({ t, f: 170, f2: 85, dur: 0.16, g: 0.35 * hard, glide: 0.12 });
    this.noise({ t, dur: 0.3, buf: 'brown', type: 'lowpass', f: 420, g: 0.65 * hard, a: 0.003 });
    this.noise({ t: t + 0.02, dur: 0.6, buf: 'pink', type: 'bandpass', f: 520, Q: 0.8, g: 0.12 * hard, a: 0.04 });
    this.noise({ t: t + 0.03, dur: 0.08, buf: 'white', type: 'highpass', f: 5000, g: 0.05 });
  }
  feet(q) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 1900, f2: 2800, dur: 0.06, g: 0.05, glide: 0.05 });
    this.tone({ t, f: 220, f2: 90, dur: 0.08, g: q ? 0.3 : 0.18 });
    this.noise({ t, dur: 0.035, buf: 'white', type: 'highpass', f: 4200, g: 0.05 });
    if (q === 'perfect') this.bell(t + 0.01, mtof(79), 0.06, 0.6);
  }
  footstep() {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: 240, f2: 110, dur: 0.06, g: 0.12 });
    if (Math.random() < 0.6) this.tone({ t, f: 2100 + Math.random() * 500, f2: 2900, dur: 0.04, g: 0.02, glide: 0.035 });
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
    const t = c.currentTime;
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
  ledBlip(i) {
    if (!this.ctx) return;
    const t = this.now();
    this.tone({ t, f: mtof(84 + PENTA[i % 8]), dur: 0.07, g: 0.035, wave: 'triangle' });
  }
  matchCue() {
    if (!this.ctx) return;
    this.tone({ t: this.now(), f: mtof(79), dur: 0.08, g: 0.04, wave: 'triangle' });
  }
  top(flash) {
    if (!this.ctx) return;
    const t = this.now();
    for (const m of [60, 64, 67, 71, 74]) this.ep(t + Math.random() * 0.02, m, 0.11, 2.4, this.sfx);
    this.tone({ t, f: mtof(36), dur: 1.4, g: 0.35, wave: 'triangle', lp: 300 });
    const arp = flash ? [84, 88, 91, 96, 100] : [84, 88, 91, 96];
    arp.forEach((m, i) => this.bell(t + 0.08 + i * 0.07, mtof(m), 0.07, 1.1));
    // gym applause: dense short noise claps with a swell
    const n = flash ? 110 : 70;
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const tt = t + 0.12 + Math.pow(u, 1.6) * 1.9;
      const amp = (0.03 + Math.random() * 0.06) * (1 - 0.5 * u);
      this.noise({ t: tt, dur: 0.018 + Math.random() * 0.02, buf: 'white', type: 'bandpass', f: 1100 + Math.random() * 1500, Q: 1.3, g: amp, pan: Math.random() * 1.4 - 0.7 });
    }
  }
  over() {
    if (!this.ctx) return;
    const t = this.now();
    [69, 65, 62, 57].forEach((m, i) => this.ep(t + i * 0.22, m, 0.09, 1.4, this.sfx));
  }
}
