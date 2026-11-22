// ============================================================================
// SOLMARA UNDERTOW — audio.js
// Fully procedural WebAudio: no audio files. Engine hum and police sirens are
// persistent oscillators whose pitch follows game state; shots, punches,
// pickups, crashes and mission stings are short synthesized envelopes.
// Ambient pad: two detuned triangles through a slow filter LFO, very quiet.
// Toggle mute with M. Audio starts on first user gesture (browser policy).
// ============================================================================

export const RADIO_STATIONS = [
  { name: 'Neon FM', desc: 'synthwave' },
  { name: 'Palma Lo-Fi', desc: 'chill chords' },
  { name: 'Solmara News Radio', desc: 'news jingle' },
];

// Step-sequencer patterns for the car radio. Frequencies in Hz, 0 = rest.
// synthwave: A-minor bass arp + Am F C G pads. lo-fi: maj7 chord loop.
// news: a bright station-ident jingle phrase that loops with beeps.
const RADIO_SEQ = [
  { stepDur: 0.268, steps: 32, bass: [110, 0, 110, 0, 110, 0, 130.8, 0, 87.3, 0, 87.3, 0, 98, 0, 110, 0, 130.8, 0, 130.8, 0, 146.8, 0, 164.8, 0, 98, 0, 98, 0, 110, 0, 123.5, 0],
    pads: [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 196, 246.9]] },
  { stepDur: 0.46, steps: 16, chords: [[174.6, 220, 261.6, 329.6], [164.8, 196, 246.9, 293.7], [146.8, 174.6, 220, 261.6], [130.8, 164.8, 196, 246.9]] },
  { stepDur: 0.21, steps: 32, lead: [523, 0, 659, 784, 0, 784, 659, 523, 587, 0, 698, 880, 784, 0, 659, 0, 523, 0, 659, 784, 0, 1046, 880, 784, 659, 0, 587, 0, 523, 0, 0, 0] },
];

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.engineOsc = null; this.engineGain = null;
    this.sirenOsc = null; this.sirenGain = null; this.sirenLfo = null;
    this.padOn = false;
    this.radioIdx = -1;      // -1 = radio off
    this._radioStep = 0;
    this._radioNext = 0;
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
  smgShoot() { this._noise(0.07, 0.26, 3000); this._blip(260, 0.05, 'square', 0.09, 70); }
  shotgunShoot() { this._noise(0.24, 0.5, 1500); this._blip(140, 0.16, 'square', 0.2, 45); }
  empty() { this._blip(1250, 0.03, 'square', 0.07); }
  explosion() { this._noise(0.55, 0.55, 320); this._blip(95, 0.5, 'sine', 0.42, 28); }
  switchWeapon() { this._blip(700, 0.04, 'square', 0.06, 500); }
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

  // ---- Car radio -------------------------------------------------------------
  // setRadio(idx): -1 off, else an index into RADIO_STATIONS. radioTick()
  // is called once per frame from the game loop; it schedules sequencer
  // steps a little ahead of the audio clock. All radio voices connect to
  // the master gain, so the M mute silences the radio too.
  setRadio(idx) {
    this.radioIdx = idx;
    this._radioStep = 0;
    if (this.ctx) this._radioNext = this.ctx.currentTime + 0.06;
  }

  _note(freq, t, dur, type, vol) {
    if (!this.ctx || !freq) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  radioTick() {
    if (!this.ctx || this.radioIdx < 0) return;
    const ctx = this.ctx;
    if (this._radioNext < ctx.currentTime - 0.4) this._radioNext = ctx.currentTime + 0.05;
    const seq = RADIO_SEQ[this.radioIdx];
    while (this._radioNext < ctx.currentTime + 0.18) {
      this._radioStepPlay(this.radioIdx, seq, this._radioStep, this._radioNext);
      this._radioNext += seq.stepDur;
      this._radioStep = (this._radioStep + 1) % seq.steps;
    }
  }

  _radioStepPlay(idx, seq, step, t) {
    if (idx === 0) { // Neon FM — synthwave
      const bass = seq.bass[step % seq.bass.length];
      if (bass) this._note(bass, t, 0.22, 'sawtooth', 0.045);
      if (step % 8 === 0) {
        const pad = seq.pads[(step / 8) % seq.pads.length];
        for (const f of pad) this._note(f, t, 1.9, 'triangle', 0.016);
      }
      if (step % 16 === 12) this._note(440, t, 0.2, 'square', 0.012);
    } else if (idx === 1) { // Palma Lo-Fi — soft maj7 chords + tick
      if (step % 4 === 0) {
        const chord = seq.chords[(step / 4) % seq.chords.length];
        chord.forEach((f, i) => this._note(f * 1.003, t + i * 0.03, 1.7, 'triangle', 0.02));
      }
      if (step % 2 === 1) this._note(3200, t, 0.02, 'sine', 0.006);
    } else { // Solmara News Radio — ident jingle loop
      const lead = seq.lead[step % seq.lead.length];
      if (lead) this._note(lead, t, 0.17, 'square', 0.028);
      if (step % 16 === 0) this._note(1568, t, 0.07, 'sine', 0.02);
    }
  }
}
