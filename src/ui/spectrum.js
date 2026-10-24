/* 频谱：56 根对数分频柱
   数据来自 backend.bins（0..255）；取不到真实频谱时退化为程序化波形，且能自动恢复 */
import { BARS } from '../audio/backend.js';

export class Spectrum {
  constructor({ canvas, backend }){
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.backend = backend;
    this.wrap = canvas.parentElement;
    this.vals = new Float32Array(BARS);
    this.w = 0; this.h = 0; this.dpr = 1;
    this.silent = 0;
    this.dataOK = true;
    this.low = false;
    this.gain = 1;          // 自适应增益（跟随峰值，见 draw）
    this.raw = null;        // 本帧原始能量，复用避免每帧分配
    this._ro = null;
    if (window.ResizeObserver){
      this._ro = new ResizeObserver(() => this.size());
      this._ro.observe(this.wrap);
    }
    window.addEventListener('resize', () => this.size());
  }

  setLow(low){ this.low = low; }

  size(){
    const r = this.wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(this.low ? 1.5 : 2, window.devicePixelRatio || 1);
    /* 尺寸没变就别重设 canvas.width/height：赋值会清空画布、也会让
       ResizeObserver 多跑一轮。窗口剧变时 RO 和 resize 会同时进来，
       这里短路掉能少一次"回调里改尺寸"的嵌套。 */
    if (Math.abs(r.width - this.w) < 0.5 && Math.abs(r.height - this.h) < 0.5 && dpr === this.dpr) return;
    this.dpr = dpr;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(playing){
    if (!this.w || !this.h){ this.size(); if (!this.w) return; }
    const g = this.g;
    const baseY = this.h * 0.80;
    const topPad = 8;
    g.clearRect(0, 0, this.w, this.h);

    // 网格
    g.strokeStyle = 'rgba(246,234,217,.055)';
    g.lineWidth = 1;
    for (let k = 1; k <= 3; k++){
      const y = Math.round(baseY - (baseY - topPad) * k / 3) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(this.w, y); g.stroke();
    }
    // 基线
    g.strokeStyle = 'rgba(246,234,217,.26)';
    g.beginPath(); g.moveTo(0, baseY + 0.5); g.lineTo(this.w, baseY + 0.5); g.stroke();

    const be = this.backend;
    const liveData = playing && be.live && !be.broken;

    // 连续 2 秒全零才判定取不到数据（乐曲里的安静段落不能把可视化永久打成假的）
    if (playing && be.live){
      let peak = 0;
      for (let i = 0; i < BARS; i++) if (be.bins[i] > peak) peak = be.bins[i];
      if (peak > 0){ this.silent = 0; this.dataOK = true; }
      else if (++this.silent > 120) this.dataOK = false;
    }

    const useLive = liveData && this.dataOK;
    const count = this.low ? 32 : BARS;
    const gap = Math.max(2, this.w / count * 0.34);
    const bw = (this.w - gap * (count - 1)) / count;
    const now = performance.now() / 1000;
    const span = baseY - topPad;

    /* 第一遍：算本帧每根柱子的原始能量（未归一化）
       以前这里乘了个 (1 + 1.15*i/BARS) 的高频补偿，高频一根比一根高，
       几乎每帧都有大半排捅到 1.0 —— 就是"全都顶满"的来源。
       现在只给 0~30% 的轻微抬升，真正的幅度交给下一步的自适应增益。 */
    const raw = this.raw && this.raw.length === count ? this.raw : (this.raw = new Float32Array(count));

    if (useLive){
      for (let i = 0; i < count; i++){
        const srcIdx = this.low ? Math.round(i * BARS / count) : i;
        const m = be.bins[Math.min(BARS - 1, srcIdx)];
        const tilt = 1 + 0.3 * (srcIdx / BARS);
        raw[i] = Math.pow(m / 255, 0.72) * tilt;
      }
    } else if (playing){
      for (let i = 0; i < count; i++){
        const a  = Math.abs(Math.sin(now * 1.7 + i * 0.71));
        const b2 = Math.abs(Math.sin(now * 0.93 + i * 0.23));
        const c  = Math.abs(Math.sin(now * 3.1 + i * 1.31));
        const tilt = 1 - 0.5 * Math.pow(i / count, 0.8);
        raw[i] = (0.06 + (a * 0.55 + b2 * 0.3 + c * 0.15) * 0.9) * tilt;
      }
    } else {
      raw.fill(0);
    }

    /* 横向 3 点平滑：相邻柱子一高一低会像梳子，平滑一遍更像真的电平表 */
    let prevRaw = raw[0];
    for (let i = 1; i < count - 1; i++){
      const cur = raw[i];
      raw[i] = prevRaw * 0.25 + cur * 0.5 + raw[i + 1] * 0.25;
      prevRaw = cur;
    }

    /* 第二遍：自适应增益。让本帧最高的一根稳定落在 ~0.85 高度，
       而不是让所有柱子各自去撞天花板。增益下降快、上升慢（跟压缩器一样）。 */
    let peak = 0;
    for (let i = 0; i < count; i++) if (raw[i] > peak) peak = raw[i];
    const want = peak > 0.02 ? Math.min(4, 1.35 / peak) : 1;
    const k = want < this.gain ? 0.22 : 0.07;
    this.gain += (want - this.gain) * k;
    if (!isFinite(this.gain) || this.gain <= 0) this.gain = 1;

    for (let i = 0; i < count; i++){
      // tanh 软饱和：越接近满格压得越狠，柱顶就不会齐刷刷排成一条线
      const target = Math.min(1, Math.tanh(raw[i] * this.gain) * 0.96);
      const v = this.vals[i];
      this.vals[i] = v + (target - v) * (target > v ? 0.55 : 0.14);
      if (this.vals[i] < 0.003) this.vals[i] = 0;

      const x = i * (bw + gap);
      const h = Math.max(1.5, this.vals[i] * span);

      g.fillStyle = 'rgba(250,240,226,' + (0.28 + 0.64 * this.vals[i]).toFixed(3) + ')';
      g.beginPath();
      if (g.roundRect) g.roundRect(x, baseY - h, bw, h, Math.min(bw / 2, 3));
      else g.rect(x, baseY - h, bw, h);
      g.fill();

      g.globalAlpha = 0.1;
      g.fillRect(x, baseY + 2, bw, Math.min(h * 0.22, this.h - baseY - 6));
      g.globalAlpha = 1;
    }
  }
}
