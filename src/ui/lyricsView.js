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
    // 只在 setActive 时算一次会永远停在顶部（原版的既有问题）。
    // 沉浸切换时 main.js 会先把版式一帧换完再自己 center() 一次；
    // 这里的回调是兜底（字体、换行、安卓 insets 造成的二次回流），
    // 用 rAF 合流，一帧最多量一次，免得手机上量出掉帧。
    // 注意不能在切换时靠 .62s 的 transform 过渡把位置"补"过去 ——
    // 那会让歌词在窗口已经切完之后继续滑，main.js 的 imm-swap 就是压它的。
    if (window.ResizeObserver){
      let raf = 0;
      this._ro = new ResizeObserver(() => {
        if (this.active < 0 || raf) return;
        raf = requestAnimationFrame(() => { raf = 0; this.center(); });
      });
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
    // 把当前这句推给原生（通知栏/锁屏显示正在唱哪一句）
    if (typeof this.onLine === 'function'){
      const l = this.lines[i];
      this.onLine(l ? (l.en || l.cn || '') : '');
    }
  }

  center(){
    const el = this.els[this.active];
    if (!el) return;
    /* --lyr-shift 是给「可视窗口和盒子不重合」的情况留的修正量：
       沉浸模式下歌词盒子的下半截被底部控件和淡出蒙版吃掉，
       盒子几何居中会让当前这句看着偏下，这里整体再往上提一点。 */
    const shift = parseFloat(
      getComputedStyle(this.viewport).getPropertyValue('--lyr-shift')
    ) || 0;
    const y = el.offsetTop + el.offsetHeight / 2 - this.viewport.clientHeight / 2;
    this.track.style.transform = 'translate3d(0, ' + (-y + shift) + 'px, 0)';
  }

  /* 主动 seek 时立即定位，不等过渡 */
  snapTo(t){
    const i = this.indexAt(t);
    if (i < 0) return;
    this.setActive(i);
  }
}
