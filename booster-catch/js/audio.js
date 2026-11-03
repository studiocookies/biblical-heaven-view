// Optional synthesized sound. Off by default. Nothing is downloaded: the
// rumble, wind and catch clunk are all made from noise and oscillators.
import { T_CONTACT } from './sim.js';

export class Sound {
  constructor() { this.ctx = null; this.enabled = false; }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = this.ctx = new AC();
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown noise
    const src = (rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };

    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);

    this.rumbleLP = ctx.createBiquadFilter(); this.rumbleLP.type = 'lowpass'; this.rumbleLP.frequency.value = 180;
    this.rumble = ctx.createGain(); this.rumble.gain.value = 0;
    src(1).connect(this.rumbleLP).connect(this.rumble).connect(this.master);
    this.crackleBP = ctx.createBiquadFilter(); this.crackleBP.type = 'bandpass'; this.crackleBP.frequency.value = 900; this.crackleBP.Q.value = 0.7;
    this.crackle = ctx.createGain(); this.crackle.gain.value = 0;
    src(2.3).connect(this.crackleBP).connect(this.crackle).connect(this.master);

    this.windBP = ctx.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.frequency.value = 500; this.windBP.Q.value = 0.5;
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    src(1.6).connect(this.windBP).connect(this.wind).connect(this.master);

    this.buf = buf;
    return true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.ctx && !this.init()) return;
    if (!this.ctx) return;
    if (on) this.ctx.resume();
    this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.2);
  }

  clunk() {
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1.2, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.6);
    o.connect(g); o.start(t); o.stop(t + 1.7);
    for (const [f, a] of [[412, 0.18], [1093, 0.08], [1730, 0.04]]) {
      const rg = ctx.createGain(); rg.connect(this.master);
      rg.gain.setValueAtTime(a, t); rg.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      const ro = ctx.createOscillator(); ro.frequency.value = f; ro.connect(rg); ro.start(t); ro.stop(t + 2.5);
    }
  }

  update(s, world, prevT) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const cam = world.camera.position;
    const dist = Math.max(30, cam.distanceTo(world.booster.group.position));
    const near = Math.min(1, 220 / dist);
    const thrust = s.eng.count === 0 ? 0 : (0.35 + 0.65 * s.eng.count / 33) * s.eng.throttle;
    const thin = Math.exp(-s.y / 25000);
    this.rumble.gain.setTargetAtTime(thrust * (0.25 + 0.75 * near) * (0.3 + 0.7 * thin), now, 0.08);
    this.crackle.gain.setTargetAtTime(thrust * near * 0.35 * thin, now, 0.08);
    const fall = s.t > 224 && s.t < 392 ? Math.min(1, s.speed / 900) * (0.4 + 0.6 * Math.exp(-s.y / 40000)) : 0;
    this.wind.gain.setTargetAtTime(fall * 0.45, now, 0.3);
    this.windBP.frequency.setTargetAtTime(300 + fall * 700, now, 0.3);
    if (prevT < T_CONTACT && s.t >= T_CONTACT) this.clunk();
  }
}
