// ============================================================================
// SOLMARA UNDERTOW — audio.js
// Fully procedural WebAudio: no audio files. Engine hum and police sirens are
// persistent oscillators whose pitch follows game state; shots, punches,
// pickups, crashes and mission stings are short synthesized envelopes.
// Ambient pad: two detuned triangles through a slow filter LFO, very quiet.
// Toggle mute with M. Audio starts on first user gesture (browser policy).
// ============================================================================

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.engineOsc = null; this.engineGain = null;
    this.sirenOsc = null; this.sirenGain = null; this.sirenLfo = null;
    this.padOn = false;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      this._startEngine();
      this._startSiren();
      this._startPad();
    } catch { /* audio is optional polish; never break the game */ }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  _startEngine() {
    const ctx = this.ctx;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 320;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(filt); filt.connect(this.engineGain); this.engineGain.connect(this.master);
    this.engineOsc.start();
  }

  // speedRatio 0..1 while driving; 0 when on foot / paused.
  engine(speedRatio, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const target = active ? 0.05 + speedRatio * 0.05 : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.08);
    this.engineOsc.frequency.setTargetAtTime(45 + speedRatio * 130, t, 0.08);
  }

  _startSiren() {
    const ctx = this.ctx;
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 700;
    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 180;
    this.sirenLfo.connect(lfoGain); lfoGain.connect(this.sirenOsc.frequency);
    this.sirenGain = ctx.createGain(); this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain); this.sirenGain.connect(this.master);
    this.sirenOsc.start(); this.sirenLfo.start();
  }

  // level 0..1 siren presence (police near + wanted).
  siren(level) {
    if (!this.ctx) return;
    this.sirenGain.gain.setTargetAtTime(level * 0.035, this.ctx.currentTime, 0.2);
  }

  _startPad() {
    const ctx = this.ctx;
    const gain = ctx.createGain(); gain.gain.value = 0.016;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 600;
    [110, 164.8, 220.5].forEach((f) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      o.connect(filt); o.start();
    });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lg = ctx.createGain(); lg.gain.value = 220;
    lfo.connect(lg); lg.connect(filt.frequency); lfo.start();
    filt.connect(gain); gain.connect(this.master);
    this.padOn = true;
  }

  _blip(freq, dur, type, vol, slideTo) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise(dur, vol, filterFreq) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
  }

  shoot() { this._noise(0.12, 0.35, 2600); this._blip(220, 0.08, 'square', 0.12, 60); }
  punch() { this._noise(0.07, 0.25, 700); this._blip(120, 0.07, 'sine', 0.2, 50); }
  hurt() { this._blip(300, 0.12, 'sawtooth', 0.12, 120); }
  crash(intensity = 1) { this._noise(0.22 * intensity, 0.3, 500); this._blip(70, 0.2, 'sine', 0.25, 35); }
  pickup() { this._blip(880, 0.09, 'sine', 0.18); setTimeout(() => this._blip(1320, 0.12, 'sine', 0.18), 70); }
  door() { this._blip(180, 0.06, 'square', 0.1, 90); }
  checkpoint() { this._blip(660, 0.08, 'sine', 0.16); setTimeout(() => this._blip(990, 0.14, 'sine', 0.16), 80); }
  sting(win = true) {
    const notes = win ? [523, 659, 784, 1046] : [392, 330, 262, 196];
    notes.forEach((f, i) => setTimeout(() => this._blip(f, 0.22, 'triangle', 0.2), i * 110));
  }
  dialog() { this._blip(520, 0.05, 'sine', 0.07, 620); }
  wanted() { this._blip(180, 0.3, 'sawtooth', 0.14, 90); }
}
