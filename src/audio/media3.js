/* 安卓后端：原生 Media3（ExoPlayer）+ 前台服务
   时间用「Kotlin 每 250ms 推一次 position + JS 插值」，
   避免每帧一次跨语言往返。频谱由 Kotlin 推 56 个 bin。 */
import { BARS, AudioBackend } from './backend.js';
import { ANDROID } from '../core/bridge.js';

function inv(cmd, args){
  if (ANDROID){
    try {
      const raw = ANDROID[cmd](JSON.stringify(args || {}));
      return Promise.resolve(raw ? JSON.parse(raw) : null);
    } catch (e){
      return Promise.resolve(null);
    }
  }
  return window.__TAURI__.core.invoke('plugin:player|' + cmd, args || {});
}

export class Media3Backend extends AudioBackend {
  constructor(){
    super();
    this._pos = 0;
    this._dur = 0;
    this._paused = true;
    this._posAt = performance.now();
    this._rate = 1;
    this._base = 0;
    this._pending = 0;
    this._lastSeekAt = 0;
    this._vol = .72;
  }

  async load(track, queue){
    this.ready = false;
    this.bins.fill(0);
    this.live = false;
    this._pos = 0;
    this._dur = track.duration || 0;
    this._paused = true;
    this._posAt = performance.now();

    const list = (queue && queue.length ? queue : [track]).map((t) => ({
      id: t.id || '',
      uri: t.uri || t.src || '',
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      albumId: t.albumId != null ? String(t.albumId) : ''
    }));
    const index = Math.max(0, list.findIndex((t) => t.id === track.id));

    await inv('load', { index, queue: list });
    await inv('volume', { level: this._vol });
    this.ready = true;
  }

  async play(){ await inv('play'); this._paused = false; this._posAt = performance.now(); }
  pause(){ inv('pause'); this._paused = true; this._pos = this.time; this._posAt = performance.now(); }
  seek(t){
    const v = Math.max(0, t);
    this._pos = v; this._posAt = performance.now();
    this._base = v; this._pending = 0;
    inv('seek', { position: v });
  }

  next(){ inv('next'); }
  prev(){ inv('prev'); }
  setShuffle(on){ inv('shuffle', { on: !!on }); }
  setRepeat(mode){ inv('repeat', { mode: mode }); }

  beginScratch(){
    this._base = this.time;
    this._pending = 0;
    this._lastSeekAt = 0;
    if (!this._paused) inv('play');
  }

  /* 正向：变速弯音（varispeed，音高跟着变）→ 偏移超过 0.45s 才提交一次 seek
     反向：Media3 不能倒放，退化为限流 seek（25Hz） */
  scratchTo(t, rate){
    this._pending = t - this._base;
    if (rate > .3 && Math.abs(this._pending) < .45){
      inv('bend', { rate: Math.min(2.2, Math.max(.25, rate)) });
      return;
    }
    inv('bend', { rate: 0 });
    const now = performance.now();
    if (now - this._lastSeekAt > 42){
      this._lastSeekAt = now;
      this._base = t;
      this._pending = 0;
      this._pos = t; this._posAt = now;
      inv('seek', { position: t });
    }
  }

  endScratch(t){
    inv('bend', { rate: 0 });
    this._base = t; this._pending = 0;
    this._pos = t; this._posAt = performance.now();
    inv('seek', { position: t });
  }

  setVolume(v){
    this._vol = v;
    if (this.ready) inv('volume', { level: v });
  }

  get time(){
    if (this._paused) return this._pos;
    return this._pos + (performance.now() - this._posAt) / 1000 * this._rate;
  }
  get duration(){ return this._dur || 0; }
  get paused(){ return this._paused; }

  /* ---- 以下是 Kotlin 事件回调 ---- */
  onPosition(pos, dur, playing){
    this._pos = pos;
    this._dur = dur || this._dur;
    this._paused = !playing;
    this._posAt = performance.now();
    if (this._rate !== 1 && !playing) this._rate = 1;
  }
  onSpectrum(arr){
    if (!arr || !arr.length) return;
    let peak = 0;
    for (let i = 0; i < BARS; i++){
      const v = arr[i] | 0;
      this.bins[i] = v;
      if (v > peak) peak = v;
    }
    this.live = peak > 0;
  }
  onState(state){
    if (state === 'playing'){ this._paused = false; this._posAt = performance.now(); }
    else if (state === 'paused' || state === 'ended' || state === 'idle'){
      this._paused = true; this._pos = this.time; this._posAt = performance.now();
    }
  }

  destroy(){ inv('stop'); }
}
