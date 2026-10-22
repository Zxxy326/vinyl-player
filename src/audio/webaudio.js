/* 桌面 / Web 后端：HTMLAudioElement + Web Audio AnalyserNode */
import { BARS, AudioBackend, buildBins } from './backend.js';

export class WebAudioBackend extends AudioBackend {
  constructor(audioEl){
    super();
    this.audio = audioEl;
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.map = null;
    this.broken = false;
    this._volume = .72;
    this.audio.volume = .72;
  }

  /* 必须在用户手势里调用：createMediaElementSource 会把输出重定向进音频图，
     context 若处于 suspended 就是全程静音 */
  ensureAnalyser(){
    if (this.analyser || this.broken) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC){ this.broken = true; return; }
    try {
      this.ctx = new AC();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = .72;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.map = buildBins(this.ctx.sampleRate, this.analyser.frequencyBinCount);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e){
      this.broken = true;
      this.analyser = null;
    }
  }

  resumeCtx(){
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  async load(track){
    this.ready = false;
    this.live = false;
    this.bins.fill(0);
    const a = this.audio;
    a.src = track.src;
    a.load();
    await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(finish, 8000);
      function finish(){
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.removeEventListener('loadedmetadata', finish);
        a.removeEventListener('error', finish);
        resolve();
      }
      a.addEventListener('loadedmetadata', finish);
      a.addEventListener('error', finish);
    });
    this.ready = true;
    return track;
  }

  async play(){
    this.resumeCtx();
    try { await this.audio.play(); return true; }
    catch (e){ return false; }
  }

  pause(){ try { this.audio.pause(); } catch (_) {} }

  seek(t){
    const d = this.duration;
    const v = Math.min(d > 0 ? d : t, Math.max(0, t));
    if (this.audio.readyState >= 1) this.audio.currentTime = v;
  }

  /* 桌面端每次移动直接写 currentTime：高频 seek 本身就是刮擦声（原有手感） */
  beginScratch(){
    if (!this.audio.paused){ const p = this.audio.play(); if (p && p.catch) p.catch(() => {}); }
  }
  scratchTo(t){ this.seek(t); }
  endScratch(t){ this.seek(t); }

  setVolume(v){ this._volume = v; this.audio.volume = v; }

  get time(){ return this.audio.currentTime || 0; }
  get duration(){
    const d = this.audio.duration;
    return isFinite(d) && d > 0 ? d : 0;
  }
  get paused(){ return this.audio.paused; }

  pull(){
    if (!this.analyser || this.broken || this.audio.paused){ return; }
    const a = this.analyser;
    a.getByteFrequencyData(this.freq);
    let peak = 0;
    for (let i = 0; i < this.freq.length; i++) if (this.freq[i] > peak) peak = this.freq[i];
    if (peak > 0){
      this.live = true;
      for (let i = 0; i < BARS; i++){
        const [s, e] = this.map[i];
        let m = 0;
        for (let b = s; b < e; b++) if (this.freq[b] > m) m = this.freq[b];
        this.bins[i] = m;
      }
    }
  }

  destroy(){
    this.pause();
    this.audio.removeAttribute('src');
  }
}
