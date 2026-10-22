/* 性能看门狗：启动后测 3 秒帧时，p90 超过 22ms 就降档
   （安卓 WebView 上全屏噪点 / conic-gradient / 高 DPR canvas 是主要开销） */
export function watchPerf(onLow){
  const samples = [];
  let start = 0;
  let last = 0;

  function frame(now){
    if (!start){ start = now; last = now; }
    const dt = now - last;
    last = now;

    // 跳过启动阶段（首帧布局、字体、音频初始化会污染样本）
    if (now - start > 1400 && dt < 400) samples.push(dt);

    if (now - start < 4200){
      requestAnimationFrame(frame);
      return;
    }
    if (samples.length < 40) return;
    samples.sort((a, b) => a - b);
    const p90 = samples[Math.floor(samples.length * 0.9)];
    if (p90 > 22) onLow(p90);
  }
  requestAnimationFrame(frame);
}
