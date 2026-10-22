# Vinyl Player · 桌面端 + 安卓端本地播放器方案

> 基于 `index.html`（43KB 单文件、零依赖）扩展出 Windows 桌面端与 Android 端。
> 目标：**一套 UI 代码，三端长期同步**；两端安装包都在 10MB 量级。

---

## 1. 已确认的选型

| 决策点 | 结论 |
| --- | --- |
| 外壳 | **Tauri 2 单工程**（Windows 用 WebView2，Android 用系统 WebView） |
| 平台 | **Windows 10/11 + Android 7.0+**（macOS / Linux 后续只补构建） |
| 桌面音频 | WebView 内的 `HTMLAudioElement` + `AnalyserNode`（复用现有全部逻辑） |
| 安卓音频 | **原生 Media3 / ExoPlayer** + 前台服务 + MediaSession |
| 安卓频谱 | `TeeAudioProcessor` 抓 PCM → Kotlin 自算 FFT → IPC 推 56 bin |
| 安卓搓碟 | **变速弯音（varispeed）+ 提交式 seek** |
| 安卓曲库 | MediaStore（`READ_MEDIA_AUDIO`） |
| 歌词 | 内嵌标签 → 同名 `.lrc` 旁挂 → 无歌词降级频谱 |
| 桌面格式 | WebView2 原生支持 + **Rust 缓存转码**兜底（APE / WMA） |
| v1 功能线 | 列表 + 播放 + 歌词/频谱 + 搓碟 + 随机/循环 + 断点续播 |
| 版式 | 竖屏单屏（手机）/ 横屏两栏（桌面、平板） |
| 分发 | GitHub Releases（APK + NSIS），CI 自动构建 |

**不做**：在线歌词、云同步、账号、EQ、倍速、睡眠定时、DSD、搜索。

---

## 2. 仓库结构

保持现有 GitHub 仓库，重构为单仓多目标：

```
index.html                  # 构建产物（单文件，GitHub Pages 用），不手改
src/
  main.js                   # 装配：读平台、选后端、挂 UI
  audio/
    backend.js              # AudioBackend 抽象（见 §3）
    webaudio.js             # 桌面实现：HTMLAudioElement + AnalyserNode
    media3.js               # 安卓实现：invoke + 事件
  lyrics/
    lrc.js                  # LRC 解析（含 offset / 多时间戳 / 双语配对）
    model.js                # {t, en, cn} 模型 + currentIndex
  ui/
    disc.js                 # 旋转 / 惯性 / 搓碟手势
    spectrum.js             # 56 柱渲染（从现有 drawViz 迁出）
    transport.js            # 进度条 / 播放键 / 音量
    library.js              # 曲库列表 / 播放队列
  styles/                   # 按块拆：base / deck / panel / portrait
  platform/
    web.js                  # 浏览器：无曲库，播 demo
    tauri.js                # 桌面：文件系统 + 扫描
    android.js              # 安卓：MediaStore + Media3
src-tauri/
  src/{lib,main,scan,transcode,tags}.rs
android/                    # 原生 Kotlin 壳（非 Tauri 生成，见下方「实现差异」）
  app/src/main/java/io/github/zxxy326/vinylplayer/
    MainActivity.kt         # WebView + WebViewAssetLoader + JavascriptInterface
    PlayerBridge.kt         # @JavascriptInterface 方法集
    PlaybackService.kt      # MediaSessionService（通知栏/锁屏）
    PlayerHolder.kt         # ExoPlayer 单例 + 音频处理链
    FftTap.kt               # TeeAudioProcessor 旁路抓 PCM → FFT → 56 bin
    JsBridge.kt             # 原生 → JS 事件推送
scripts/build-web.mjs       # 自写打包器 → index.html + dist/ + android assets
.github/workflows/          # web.yml / desktop.yml / android.yml
docs/
```

**为什么这样拆**：README 里「一个 HTML + 一个音频文件，双击即开」是卖点，不能丢。开发时用模块化源码，发布时用 `vite-plugin-singlefile` 仍然产出一个自包含 `index.html`——卖点和可维护性同时保住。

### 实现差异（落地时调整）

方案里原定「Tauri 2 单工程 + 本地移动插件（`tauri plugin new player --android`）」，实际落地时改成了**桌面用 Tauri、安卓用原生 Kotlin 壳**，原因和影响如下：

| 项 | 方案 | 实际 | 原因 |
| --- | --- | --- | --- |
| 安卓外壳 | Tauri 2 + 本地移动插件 | 原生 Kotlin + WebView | `tauri plugin new --android` 需要交互式 TTY，非交互环境无法完成脚手架；且安卓侧几乎全部逻辑都在 Kotlin（Media3/FFT/MediaStore），Tauri 移动壳只剩 WebView 托管，多一层没有收益 |
| 安卓构建 | `tauri android build --apk` | `./gradlew assembleRelease` | 同上 |
| 前端产物 | vite + vite-plugin-singlefile | 自写 `scripts/build-web.mjs` | 免去 vite 依赖，且能一次产出三份目标（`index.html` / `dist/` / `android/app/src/main/assets/web/`） |
| JS ↔ 原生 | Tauri IPC | `@JavascriptInterface`（`window.AndroidPlayer`） | 同步返回 + 事件回调，比 IPC 更直接；`src/core/bridge.js` 做了薄封装，媒体后端代码不感知差异 |

**不变的部分**：`AudioBackend` 抽象、`src/` 单一源码、两端共享 `dist/`、Media3 播放与 FFT 方案、MediaStore 曲库——这些是方案的核心，全部按原设计实现。

---

## 3. 核心抽象：AudioBackend

现有代码里三处直连音频（`state.t = audio.currentTime`、`audio.currentTime = state.t`、`analyser.getByteFrequencyData`）必须全部收敛到这里，否则安卓端无从替换。

```js
// src/audio/backend.js
export const BARS = 56;

export class AudioBackend {
  // 子类实现
  async load(track) {}        // track: {id, uri, title, artist, album, duration, hasArt}
  async play() {}
  pause() {}
  seek(seconds) {}            // 立即跳转（松手提交、进度条拖拽）
  bend(rate) {}               // 变速弯音；rate=null 恢复 1.0。桌面端空实现
  setVolume(v) {}             // 0..1

  get time() {}               // 当前时间，**已含未提交的搓碟偏移**
  get duration() {}
  get paused() {}
  bars = new Float32Array(BARS);   // 0..1，后端自行填充，渲染层只读
  on(ev, cb) {}                    // 'ended' | 'error' | 'play' | 'pause'
}
```

**关键约定**：两端后端都输出**已经分好 56 个对数 bin、值域 0..255 的 `Uint8Array`**，JS 侧再套用现有那条 `pow(m/255, 0.82) * (1 + 1.15*i/BARS)` 曲线。这样桌面（真 FFT）和安卓（PCM tap FFT）的视觉是同一套映射，不会一边高一边矮。

**时间同步**：桌面每帧读 `audio.currentTime` 无所谓；安卓每帧走一次 IPC 就是 60 次/秒的跨语言往返。所以安卓侧由 Kotlin 每 250ms 推一次 position，JS 用 `performance.now()` 插值：

```js
get time() {
  return this.paused ? this._pos
       : this._pos + (performance.now() - this._posAt) / 1000 * this._rate + this._pending;
}
```

---

## 4. 六个硬问题的具体解法

### 4.1 安卓频谱：PCM tap + Kotlin FFT

- 在 Media3 音频管道里插 `TeeAudioProcessor`，取解码后 PCM（44.1k/48k，立体声 downmix）。
- 2048 点窗口 + Hann 窗 + radix-2 FFT（约 40 行 Kotlin，预分配数组，音频线程内零分配）。
- 按 `fMin=38, fMax=min(16500, nyq*0.92)` 的同一套对数分段归到 56 bin，取区间最大值，输出 0..255。
- 以 `player://spectrum` 事件推给 JS，60fps。
- **不需要任何录音权限**——这是选它而不是 `android.media.Visualizer` 的唯一理由（后者在 Android 9+ 抓输出混音要 `RECORD_AUDIO`，部分 OEM 直接返回空）。

### 4.2 安卓搓碟：变速弯音

`currentTime = x` 跨 IPC 后再叠加 MP3 无精确 seek 的断口，手感会废。改成唱盘的真实行为：

```
拖动 d 度  →  Δt = d / 360 * SEC_PER_TURN   (沿用现有 6 秒/圈)
累加 pending += Δt

|pending| < 0.4s  →  bend(PlaybackParameters(speed = 1 + pending*2, pitch = speed))
|pending| ≥ 0.4s  →  seek(base + pending); pending = 0
松手               →  seek(base + pending); pending = 0; bend(null)
```

两个要点：
1. **`pitch` 必须等于 `speed`**。Media3 默认保音高（时间拉伸），而搓碟要的是变调（varispeed）——这是「像唱盘」和「像快进」的分界。
2. `backend.time` 要把 `pending` 算进去，否则歌词和进度条会落后于手指。

### 4.3 安卓本地文件：content:// 直通

Media3 的 `ContentDataSource` 原生支持 `content://`，不需要自己写协议。曲库用 MediaStore 查 `_ID / TITLE / ARTIST / ALBUM / DURATION / ALBUM_ID`，封面走 `content://media/external/audio/albumart/<albumId>`。

桌面端则走 Tauri asset 协议（`convertFileSrc`），它支持 Range 请求，进度条拖拽正常。

### 4.4 桌面转码兜底：缓存成文件，不做流式

APE / WMA 在 WebView2 里解不了。**不要写流式转码**——APE 是帧内预测压缩，seek 要回退重解，映射逻辑能吃掉一周。

改为：
1. 扫描时用 `lofty` 读标签，`symphonia` 探测能否解码；
2. 不能播的格式在列表里标灰，点击时提示「首次播放需转换」；
3. 确认后 `symphonia` 解码 → `flacenc` 编码到 `%LOCALAPPDATA%/vinyl-player/cache/<sha1(path+mtime+size)>.flac`；
4. 转完当普通文件播，seek 天然可用；
5. 缓存按 LRU 上限 2GB 淘汰。

**DSD（.dsf/.dff）v1 不支持**：symphonia 没有 DSD 解码器，要另接一套 1bit → PCM 抽取滤波，投入产出不划算。列表里标灰并注明。

### 4.5 双版式

现有 `@media (max-width:1000px),(orientation:portrait)` 只是把两栏堆成可滚动页面，不是 App 版式。改成两套明确布局：

| | 横屏 / 桌面 | 竖屏 / 手机 |
| --- | --- | --- |
| 结构 | `grid: 1.02fr .98fr` 两栏 | 单屏 flex 纵向，不滚动 |
| 唱片 | `--disc: min(74vh, 41vw)` | `--disc: min(58vh, 78vw)` |
| 歌词 | 右侧全高 | 中部固定高度 + 上下渐隐遮罩 |
| 控制 | 面板内 | 底部固定传输栏 + 安全区内边距 |
| 曲库 | 面板内切换 | 上滑抽屉 |

`centerLine()` 依赖 `viewport.clientHeight`，必须在 `orientationchange` + `resize` 双事件里重算，并在旋转动画结束后补一次（WebView 的 `resize` 会比布局晚一帧，会闪）。

### 4.6 低端机性能降级

现在最贵的三处，按嫌疑排序：

1. `body::before` 的 `feTurbulence` 全屏噪点 + `mix-blend-mode: overlay`——每帧强制全屏混合，安卓 WebView 上是头号杀手；
2. `.gloss` 的 `conic-gradient` 叠在旋转层上；
3. DPR 2 下的 56 柱 canvas。

对策：
- 噪点换成**预烘焙的 128×128 PNG 平铺**（视觉几乎无差，成本从「每帧全屏混合」变成「一次合成」）；
- 启动后测 3 秒 rAF 帧时，p90 > 22ms 就挂 `body.perf-low`：关噪点层、去 gloss、DPR 封顶 1.5、柱子降到 32 根、转速动画降到 30fps；
- 这个降级是运行时判定，不写死机型白名单。

---

## 5. 里程碑与验收

| # | 内容 | 验收标准 |
| --- | --- | --- |
| **M0** | 拆 `src/` + Vite + singlefile | 构建出的 `index.html` 与现网**逐像素一致**（三张截图对比：歌词/频谱/搓碟态）；仍为单文件、双击可开 |
| **M1** | Tauri 桌面壳 + 扫描 + 列表 | 500 首目录 3 秒内出列表；封面/时长正确；点播出声；关掉重开记住进度 |
| **M2** | 桌面转码兜底 | 一个 .ape 首次播放 ≤20s 转完并出声，第二次秒开；缓存超 2GB 自动淘汰 |
| **M3** | 安卓壳 + Media3 + 前台服务 | 锁屏后继续播；通知栏/锁屏能暂停、切歌；杀进程后重进能续播 |
| **M4** | 安卓频谱 + 搓碟 | 频谱与桌面同一首歌形态一致；搓碟有变调刮擦声、无明显断口 |
| **M5** | 双版式 + 性能降级 + 发布 | 竖屏单屏不滚动、横屏两栏；中端机 55fps+；CI 出 APK 与 NSIS 包 |

粗估 11–17 人日。M0 是唯一的「地基」里程碑，它不通过后面全部返工。

---

## 6. 风险登记

| 风险 | 触发 | 影响 | 预案 |
| --- | --- | --- | --- |
| Tauri IPC 扛不住 60fps 事件 | 频谱推流卡顿 | 频谱掉帧 | 降到 30fps；或改批量推 2 帧数据；兜底用程序化波形 |
| Android WebView 后台被回收 | 长时间后台 | 播放中断 | 前台服务 + `mediaPlayback` 类型 + `POST_NOTIFICATIONS`（13+）；`onTaskRemoved` 不 stopSelf |
| 搓碟弯音在部分机型爆音 | 快速来回拖 | 破音 | 给 `speed` 加变化率限制（每 16ms 最多 ±0.15） |
| 未签名安装包 | 用户下载 | SmartScreen 警告 | 文档说明；后续买证书或走 winget |
| MediaStore 索引滞后 | 刚拷贝的歌搜不到 | 列表缺歌 | 提供「刷新曲库」按钮，内部触发 MediaScannerConnection |
| 现有单文件被破坏 | 有人直接改 index.html | 构建覆盖丢失 | README 明确标注「产物，勿手改」，并在构建前校验 |

---

## 7. 我替你做的五个决定（可否决）

1. **不把 CC BY 的演示曲打进 App**——省体积，也避免授权归属扯皮。空态改为「选择音乐文件夹 / 授权曲库」。demo 仍留在网页版。
2. **桌面转码走缓存文件，不做流式**（见 4.4）。
3. **DSD 不做**，列表标灰。
4. **安卓 minSdk 24 / targetSdk 35**；release 版剔除 `INTERNET` 权限（更新器需要时再加），做成「零网络权限的本地播放器」——这是个能写进 README 的卖点。
5. **应用标识** `io.github.zxxy326.vinylplayer`，窗口最小 960×600，默认 1280×800。

---

## 8. 建议的下一步

先只做 **M0**，做完拿三张截图和现网对比。地基稳了，M1–M5 才是纯加法。
