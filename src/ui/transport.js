/* 传输栏：进度条 / 播放键 / 音量 / 随机 / 循环 */
import { clamp, fmt } from '../core/util.js';

export class Transport {
  constructor(o){
    this.bar = o.bar;
    this.fill = o.fill;
    this.dot = o.dot;
    this.tCur = o.tCur;
    this.tDur = o.tDur;
    this.playBtn = o.playBtn;
    this.vol = o.vol;
    this.volKnob = o.volKnob;
    this.shuffleBtn = o.shuffleBtn;
    this.repeatBtn = o.repeatBtn;
    this.repeatBadge = o.repeatBadge;
    this.hooks = o.hooks;

    this._bind();
  }

  _bind(){
    const h = this.hooks;
    const bar = this.bar;

    const seekAt = (clientX) => {
      const r = bar.getBoundingClientRect();
      const p = clamp((clientX - r.left) / r.width, 0, 1);
      h.onSeek(p * (h.getDuration() || 0));
    };

    let dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      if (h.onScrubStart) h.onScrubStart();
      seekAt(e.clientX);
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) seekAt(e.clientX); });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      if (h.onScrubEnd) h.onScrubEnd();
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);

    this.playBtn.addEventListener('click', () => {
      if (h.ensureAudio) h.ensureAudio();
      h.onTogglePlay();
    });

    this.vol.addEventListener('input', () => {
      const v = this.vol.value / 100;
      this.setVolume(v);
      if (h.onVolume) h.onVolume(v);
    });

    this.shuffleBtn.addEventListener('click', () => h.onShuffle());
    this.repeatBtn.addEventListener('click', () => h.onRepeat());
  }

  update(t, dur, playing){
    const d = dur || 0;
    const p = d > 0 ? clamp(t / d, 0, 1) : 0;
    this.fill.style.width = (p * 100) + '%';
    this.dot.style.left = (p * 100) + '%';
    this.tCur.textContent = fmt(t);
    this.tDur.textContent = fmt(d);
    this.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  setVolume(v){
    this.vol.value = Math.round(v * 100);
    this.volKnob.style.setProperty('--r', (-120 + v * 240) + 'deg');
  }

  setShuffle(on){
    this.shuffleBtn.classList.toggle('on', !!on);
  }

  setRepeat(mode){
    this.repeatBtn.classList.toggle('on', mode !== 'off');
    if (this.repeatBadge) this.repeatBadge.hidden = mode !== 'one';
    this.repeatBtn.setAttribute('aria-label',
      mode === 'one' ? '单曲循环' : mode === 'all' ? '列表循环' : '不循环');
    this.repeatBtn.title = mode === 'one' ? '单曲循环' : mode === 'all' ? '列表循环' : '不循环';
  }
}
