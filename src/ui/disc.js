/* 唱片：旋转 / 惯性 / 搓碟手势
   旋转角度由 JS 统一驱动（不能用 CSS animation —— 拖拽接管后松手会从 0deg 重来，画面会跳） */
import { clamp } from '../core/util.js';

export class Disc {
  constructor({ platter, discEl, backend, hooks }){
    this.platter = platter;
    this.discEl = discEl;
    this.backend = backend;
    this.hooks = hooks || {};

    this.SPIN_PERIOD = 22;   // 视觉转速：22 秒一圈
    this.SEC_PER_TURN = 6;   // 搓碟换算：手转一圈 = 音轨前后 6 秒

    this.angle = 0;
    this.boost = 0;
    this.scratching = false;
    this.wasPlaying = false;
    this.ptrId = null;
    this.moved = 0;
    this.vel = 0;
    this.aLast = 0;
    this.tLast = 0;

    this._bind();
  }

  tick(dt, playing){
    if (!this.scratching){
      if (playing) this.angle += 360 / this.SPIN_PERIOD * dt;
      if (this.boost){
        this.angle += this.boost * dt;
        this.boost *= Math.pow(0.012, dt);
        if (Math.abs(this.boost) < 2) this.boost = 0;
      }
    }
    this.discEl.style.transform = 'rotate(' + this.angle + 'deg)';
  }

  _angle(e){
    const r = this.platter.getBoundingClientRect();
    return Math.atan2(
      e.clientY - (r.top + r.height / 2),
      e.clientX - (r.left + r.width / 2)
    ) * 180 / Math.PI;
  }

  _bind(){
    const pl = this.platter;

    pl.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      e.preventDefault();
      const h = this.hooks;
      if (h.ensureAudio) h.ensureAudio();

      this.scratching = true;
      this.wasPlaying = !!h.isPlaying();
      this.ptrId = e.pointerId;
      this.moved = 0;
      this.vel = 0;
      this.boost = 0;
      this.aLast = this._angle(e);
      this.tLast = performance.now();

      document.body.classList.add('is-scratching');
      this.backend.beginScratch();
      try { pl.setPointerCapture(this.ptrId); } catch (_) {}
      if (h.onScratch) h.onScratch(0, h.getTime());
    });

    pl.addEventListener('pointermove', (e) => {
      if (!this.scratching || e.pointerId !== this.ptrId) return;
      const h = this.hooks;

      const a = this._angle(e);
      let d = a - this.aLast;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.aLast = a;
      if (!d) return;

      const now = performance.now();
      const dtm = Math.max(0.008, (now - this.tLast) / 1000);
      this.tLast = now;
      this.vel = this.vel * 0.6 + (d / dtm) * 0.4;

      this.moved += Math.abs(d);
      this.angle += d;

      const t = clamp(h.getTime() + d / 360 * this.SEC_PER_TURN, 0, h.getDuration() || 1e9);
      h.setTime(t);

      // 角速度 → 倍速：手转一圈 / 6 秒 = 正常速度
      const rate = this.vel * this.SEC_PER_TURN / 360;
      this.backend.scratchTo(t, rate);

      if (h.onScratch) h.onScratch(d, t);
    });

    const end = () => {
      if (!this.scratching) return;
      const h = this.hooks;
      this.scratching = false;
      document.body.classList.remove('is-scratching');
      try { pl.releasePointerCapture(this.ptrId); } catch (_) {}

      const t = h.getTime();
      this.backend.endScratch(t);

      if (this.moved < 2){
        this.boost = 0;
        if (h.togglePlay) h.togglePlay();
      } else {
        this.boost = clamp(this.vel * 0.55, -1500, 1500);
        if (h.restorePlay) h.restorePlay(this.wasPlaying);
      }
      if (h.onScratchEnd) h.onScratchEnd();
    };

    pl.addEventListener('pointerup', end);
    pl.addEventListener('pointercancel', end);
  }
}
