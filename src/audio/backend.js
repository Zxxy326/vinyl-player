/* 音频后端抽象
   桌面/Web 用 Web Audio（HTMLAudioElement + AnalyserNode）
   安卓用原生 Media3（ExoPlayer + 前台服务），通过 IPC 驱动

   约定：两端都往 bins 里填「已分好 56 个对数 bin、值域 0..255」的原始幅值，
   渲染层再套同一条曲线 —— 这样两端的频谱形态一致。 */
export const BARS = 56;

export class AudioBackend {
  constructor(){
    this.bins = new Uint8Array(BARS);
    this.live = false;        // 频谱数据是否真实可用
    this.ready = false;
  }

  async load(track, queue){ this.ready = true; return track; }
  async play(){}
  pause(){}
  seek(t){}
  setVolume(v){}
  next(){}
  prev(){}
  setShuffle(on){}
  setRepeat(mode){}

  /* 搓碟：begin → 多次 scratchTo → end
     rate 为「相对正常速度的倍率」，负值表示反向 */
  beginScratch(){}
  scratchTo(t, rate){ this.seek(t); }
  endScratch(t){ this.seek(t); }

  get time(){ return 0; }
  get duration(){ return 0; }
  get paused(){ return true; }

  /* 渲染循环里每帧调一次，拉取频谱（桌面）；安卓是推模式，这里空实现 */
  pull(){}

  destroy(){}
}

/* 对数分频：低频不被挤成一根柱子（与安卓 Kotlin 侧同一套公式） */
export function buildBins(sampleRate, binCount){
  const nyq = sampleRate / 2;
  const fMin = 38;
  const fMax = Math.min(16500, nyq * .92);
  const out = [];
  for (let i = 0; i < BARS; i++){
    const f0 = fMin * Math.pow(fMax / fMin, i / BARS);
    const f1 = fMin * Math.pow(fMax / fMin, (i + 1) / BARS);
    let s = Math.floor(f0 / nyq * binCount);
    let e = Math.ceil(f1 / nyq * binCount);
    if (e <= s) e = s + 1;
    out.push([Math.min(s, binCount - 1), Math.min(e, binCount)]);
  }
  return out;
}
