/* 歌词视图：滚动 / 高亮 / 点行跳转 */
import { esc } from '../core/util.js';

export class LyricsView {
  constructor({ viewport, track, onSeek }){
    this.viewport = viewport;
    this.track = track;
    this.onSeek = onSeek;
    this.lines = [];
    this.els = [];
    this.active = -1;
    this.signature = '';

    // 布局稳定后重新居中：首帧 clientHeight 可能是 0，
    // 只在 setActive 时算一次会永远停在顶部（原版的既有问题）
    if (window.ResizeObserver){
      this._ro = new ResizeObserver(() => { if (this.active >= 0) this.center(); });
      this._ro.observe(this.viewport);
    }
    if (document.fonts && document.fonts.ready){
      document.fonts.ready.then(() => { if (this.active >= 0) this.center(); }).catch(() => {});
    }
  }

  setLines(lines){
    this.lines = lines || [];
    this.active = -1;
    this.signature = this.lines.map(l => l.t + '|' + l.en + '|' + l.cn).join('\n');
    this.track.innerHTML = '';
    this.els = [];

    const frag = document.createDocumentFragment();
    this.lines.forEach((l, i) => {
      const el = document.createElement('div');
      el.className = 'lyric';
      el.innerHTML = '<div class="en">' + esc(l.en) + '</div>' +
                     (l.cn ? '<div class="cn">' + esc(l.cn) + '</div>' : '');
      el.addEventListener('click', () => { if (this.onSeek) this.onSeek(l.t + 0.01); });
      frag.appendChild(el);
      this.els.push(el);
    });
    this.track.appendChild(frag);
  }

  get hasLines(){ return this.lines.length > 0; }

  indexAt(t){
    if (!this.lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < this.lines.length; i++) if (t >= this.lines[i].t) idx = i;
    return idx;
  }

  setActive(i){
    if (i === this.active) return;
    this.active = i;
    this.els.forEach((el, k) => {
      const d = Math.abs(k - i);
      el.style.setProperty('--o', d === 0 ? 1 : d === 1 ? .40 : d === 2 ? .22 : .11);
      el.classList.toggle('is-active', k === i);
    });
    this.center();
  }

  center(){
    const el = this.els[this.active];
    if (!el) return;
    const y = el.offsetTop + el.offsetHeight / 2 - this.viewport.clientHeight / 2;
    this.track.style.transform = 'translate3d(0, ' + (-y) + 'px, 0)';
  }

  /* 主动 seek 时立即定位，不等过渡 */
  snapTo(t){
    const i = this.indexAt(t);
    if (i < 0) return;
    this.setActive(i);
  }
}
