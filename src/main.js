/* 装配层：把后端、UI、曲库接到一起 */
import { $, clamp, debounce, esc } from './core/util.js';
import { S, loadPrefs, savePrefs, saveResume, getResume, getLastId, getPlaylists, createPlaylist, deletePlaylist, renamePlaylist, addToPlaylist, removeFromPlaylist, ensureFavorites, isFavorite, toggleFavorite } from './core/store.js';
import { notePlay, addSeconds, flushStats, resetStats } from './core/stats.js';
import { libraryStats, fmtBytes, fmtDuration } from './core/quality.js';
import { HAS_ANDROID, acall, acallJSON } from './core/bridge.js';
import { IS_WEB, IS_DESKTOP, IS_ANDROID, HAS_TAURI, pickLibrary, rescan, resolvePlayable, loadLyrics, importLyrics, restoreImportedLyrics, loadCover, listen, invoke, setNowLyric } from './core/platform.js';
import { DEMO, DEMO_LYRICS } from './data/demo.js';
import { lrcToLines } from './lyrics/lrc.js';
import { WebAudioBackend } from './audio/webaudio.js';
import { Media3Backend } from './audio/media3.js';
import { Disc } from './ui/disc.js';
import { LyricsView } from './ui/lyricsView.js';
import { Spectrum } from './ui/spectrum.js';
import { Transport } from './ui/transport.js';
import { Library } from './ui/library.js';
import { watchPerf } from './ui/perf.js';

const audioEl = $('audio');
const backend = IS_ANDROID ? new Media3Backend() : new WebAudioBackend(audioEl);

const lyricsView = new LyricsView({
  viewport: $('lyrics'),
  track: $('lyricTrack'),
  onSeek: (t) => seekTo(t, true)
});
// 当前歌词行同步给原生：通知栏 / 锁屏上显示正在唱哪一句
lyricsView.onLine = (text) => setNowLyric(text);

const spectrum = new Spectrum({ canvas: $('viz'), backend });

const transport = new Transport({
  bar: $('bar'), fill: $('fill'), dot: $('dot'), tCur: $('tCur'), tDur: $('tDur'),
  playBtn: $('play'), vol: $('vol'), volKnob: $('volKnob'),
  shuffleBtn: $('shuffle'), repeatBtn: $('repeat'), repeatBadge: $('repeatBadge'),
  hooks: {
    onSeek: (t) => seekTo(t, true),
    onTogglePlay: () => togglePlay(),
    onShuffle: () => toggleShuffle(),
    onRepeat: () => cycleRepeat(),
    onVolume: (v) => { S.volume = v; backend.setVolume(v); savePrefs(); },
    onScrubStart: () => { S.scrubbing = true; },
    onScrubEnd: () => { S.scrubbing = false; },
    getDuration: () => S.duration || backend.duration,
    ensureAudio: () => ensureAudio()
  }
});

const library = new Library({
  sheet: $('sheet'), scrim: $('scrim'), list: $('libList'), count: $('libCount'),
  hint: $('libHint'), pickBtn: $('pickBtn'), rescanBtn: $('rescanBtn'),
  lrcBtn: $('lrcBtn'), closeBtn: $('libClose'),
  tabs: $('sheetTabs'), title: $('sheetTitle'),
  newPlBtn: $('newPlBtn'),
  searchInput: $('libSearch'), searchClear: $('libSearchClear'),
  panes: {
    tracks: document.querySelector('[data-pane="tracks"]'),
    albums: document.querySelector('[data-pane="albums"]'),
    artists: document.querySelector('[data-pane="artists"]'),
    playlists: document.querySelector('[data-pane="playlists"]'),
    settings: document.querySelector('[data-pane="settings"]')
  },
  lists: {
    albums: $('albumList'), artists: $('artistList'),
    playlists: $('plList'), settings: $('settingsPane')
  },
  hooks: {
    onPick: () => pick(),
    onRescan: () => doRescan(),
    onPlay: (i) => playIndex(i, true),
    onImportLyrics: () => doImportLyrics(),
    onUnsupported: (t) => toast('这个格式播不了：' + (t.format || '未知') + '（可装 ffmpeg 解锁）'),
    onCreatePlaylist: () => doCreatePlaylist(),
    onAddToPlaylist: (trackId) => doAddToPlaylist(trackId),
    onPlaylistAction: (act, id) => doPlaylistAction(act, id),
    onRemoveFromPlaylist: (id, trackId) => doRemoveFromPlaylist(id, trackId),
    onSetting: (key) => doSetting(key),
    /* 只在色相条松手时进来（拖动过程只更新设置页里的小色点），
       所以这里可以放心地整页换色 + 立即落盘 */
    onBgHue: (v) => {
      S.bg = 'custom';
      S.bgHue = v;
      applyBg();
      savePrefs();
    }
  }
});

/* 通知权限：没有它通知栏不会出媒体卡片，设置页要能提示并一键跳转 */
let notifOk = true;

/* 调试用：?platform=android 强制按安卓渲染设置页 */
const DEBUG_PLATFORM = (() => {
  try { return new URLSearchParams(location.search).get('platform') || ''; } catch (_) { return ''; }
})();

function refreshNotifState(){
  if (!IS_ANDROID || !HAS_ANDROID) return notifOk;
  try {
    const o = acallJSON('notif');
    if (o) notifOk = !!o.ok;
  } catch (_) {}
  return notifOk;
}

/* 统一走这里，免得每个调用点都要记着传歌单/统计信息 */
function renderLib(extra){
  refreshNotifState();
  const opts = Object.assign({
    showLrcImport: IS_ANDROID,
    playlists: getPlaylists(),
    libraryInfo: {
      // ?platform=android 可以在桌面浏览器里预览安卓专属的设置项（截图/调试用）
      platform: DEBUG_PLATFORM || (IS_ANDROID ? 'android' : IS_DESKTOP ? 'desktop' : 'web'),
      folder: S.folder || '',
      notifOk: notifOk,
      closeAction: S.closeAction
    },
    view: S.view,
    volume: S.volume,
    keepOn: S.keepOn,
    hideBar: S.hideBar,
    immMotion: S.immMotion,
    bg: S.bg,
    bgHue: currentBgHue()
  }, extra || {});
  library.render(S.tracks, S.index, S.playing, opts);
}

const disc = new Disc({
  platter: $('platter'),
  discEl: $('disc'),
  backend,
  hooks: {
    ensureAudio: () => ensureAudio(),
    isPlaying: () => S.playing,
    getTime: () => S.t,
    getDuration: () => S.duration || backend.duration,
    setTime: (t) => { S.t = t; },
    togglePlay: () => togglePlay(),
    restorePlay: (was) => { if (was !== S.playing) setPlaying(was); },
    onScratch: (d, t) => paintScratch(d, t),
    onScratchEnd: () => { document.body.classList.remove('is-scratching'); }
  }
});

/* ================= 视图 ================= */
function viewMode(){
  return lyricsView.hasLines ? S.view : 'visual';
}

function applyView(){
  const on = viewMode() === 'visual';
  document.body.classList.toggle('view-visual', on);
  const btn = $('viewToggle');
  btn.style.setProperty('--r', on ? '38deg' : '-52deg');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.disabled = !lyricsView.hasLines;
  btn.title = lyricsView.hasLines ? '切换 歌词 / 可视化' : '本曲无歌词，已显示可视化';
  if (on) requestAnimationFrame(() => spectrum.size());
}

$('viewToggle').addEventListener('click', () => {
  if (!lyricsView.hasLines) return;
  ensureAudio();
  S.view = S.view === 'lyrics' ? 'visual' : 'lyrics';
  savePrefs();
  applyView();
});

/* ================= 元信息 ================= */
function currentTrack(){
  return S.index >= 0 ? S.tracks[S.index] : null;
}

/* 收藏：一颗心，点了就进固定的「收藏」歌单，再点移出 */
const favBtn = $('fav');

function paintFav(tr){
  const on = !!tr && isFavorite(tr.id);
  favBtn.classList.toggle('on', on);
  favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  favBtn.disabled = !tr;
  favBtn.title = on ? '已收藏 · 再点取消' : '收藏到「收藏」歌单';
}

function paintMeta(tr){
  const pad = String(S.index + 1).padStart(2, '0');
  $('tEyebrow').textContent = tr.eyebrow || ('SIDE A · TRACK ' + pad);
  $('tTitle').textContent = tr.title || '未知曲目';
  $('tTitle').style.opacity = '';   // 清掉「正在读取曲库」占位时的半透明
  $('tArtist').innerHTML = esc(tr.artist || '未知艺人') +
    (tr.album ? ' <em>— ' + esc(tr.album) + '</em>' : '');
  $('tCredit').innerHTML = tr.creditHtml ||
    ('本地曲库 · ' + esc(tr.format || 'AUDIO') + (tr.transcoded ? ' · 已转码' : ''));
  $('ringText').textContent = tr.ring ||
    (String(tr.title || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff ]/g, ' ') + ' · ').repeat(3);
  $('rpmLabel').textContent = (tr.format ? tr.format + ' · ' : '') + 'STEREO';
  document.title = (tr.title || 'Vinyl Player') + (tr.artist ? ' — ' + tr.artist : '') + ' · Vinyl Player';
  paintFav(tr);
}

async function paintCover(tr){
  const img = $('cover');
  const label = $('label');
  const url = await loadCover(tr);
  if (url){
    img.src = url;
    label.classList.add('has-cover');
  } else {
    img.removeAttribute('src');
    label.classList.remove('has-cover');
  }
}

/* ================= 播放 ================= */
function ensureAudio(){
  if (backend.ensureAnalyser) backend.ensureAnalyser();
}

async function playIndex(i, autoplay){
  if (i < 0 || i >= S.tracks.length) return;
  flushListen();
  const tr = S.tracks[i];
  S.index = i;
  syncOrder(i);

  try {
    await resolvePlayable(tr);
  } catch (e){
    toast('无法播放：' + (tr.title || '') + (e && e.message ? '（' + e.message + '）' : ''));
    tr.playable = false;
    renderLib();
    return;
  }

  try {
    await backend.load(tr, S.tracks);
  } catch (e){
    toast('播放失败：' + (tr.title || ''));
    return;
  }

  S.duration = tr.duration || backend.duration || 0;
  paintMeta(tr);
  paintCover(tr);

  // 记一次播放（切歌、循环回到开头都算，内部有 20 秒去重）
  notePlay(tr);
  playAccum = 0;
  playAccumId = tr.id;

  const raw = await loadLyrics(tr);
  const lines = raw ? lrcToLines(raw, S.duration) : (tr.demo ? DEMO_LYRICS.slice() : []);
  lyricsView.setLines(lines);
  applyView();

  const r = getResume(tr.id);
  if (r > 2 && (!S.duration || r < S.duration - 3)) seekTo(r, false);
  else seekTo(0, false);

  library.updatePlaying(S.index, false);
  if (autoplay) await setPlaying(true);
  savePrefs();
}

async function setPlaying(on){
  if (!S.tracks.length) return;
  if (!on) flushListen();
  if (on){
    ensureAudio();
    const ok = await backend.play();
    if (ok === false){
      S.playing = false;
      document.body.classList.remove('is-playing');
      document.body.classList.add('needs-tap');
      library.updatePlaying(S.index, false);
      return;
    }
  } else {
    backend.pause();
  }
  S.playing = on;
  document.body.classList.toggle('is-playing', on);
  document.body.classList.remove('needs-tap');
  library.updatePlaying(S.index, on);
  const tr = currentTrack();
  if (tr) saveResume(tr.id, S.t);
}

function togglePlay(){ setPlaying(!S.playing); }

function seekTo(t, immediate){
  const dur = S.duration || backend.duration || 0;
  const v = clamp(t, 0, dur > 0 ? dur : t);
  S.t = v;
  backend.seek(v);
  lyricsView.snapTo(v);
  transport.update(v, dur, S.playing);
}

function paintScratch(d, t){
  $('scratchTime').textContent = fmtShort(t);
  $('scratchDir').textContent = d < -0.6 ? '◀◀' : d > 0.6 ? '▶▶' : '●';
}

function fmtShort(s){
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ================= 队列 =================
   随机播放不是"每次随机取一个下标"——那样在「随机 + 不循环」时永远停不下来，
   也没法实现「上一首」。这里改成先把整库洗成一副牌（order），再按发牌顺序走。 */
let order = [];
let orderPos = 0;

function shuffleArr(a){
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* start >= 0：把它放第一位，其余洗牌；start = -1：整轮重新洗 */
function buildOrder(start){
  const n = S.tracks.length;
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== start) rest.push(i);
  shuffleArr(rest);
  order = start >= 0 ? [start].concat(rest) : rest;
  orderPos = 0;
}

/* 用户点了某一首之后，把发牌位置对齐过去 */
function syncOrder(i){
  if (!S.shuffle) return;
  if (order.length !== S.tracks.length){ buildOrder(i); return; }
  const p = order.indexOf(i);
  if (p >= 0) orderPos = p;
  else buildOrder(i);
}

function nextIndex(dir){
  const n = S.tracks.length;
  if (!n) return -1;

  if (S.shuffle){
    if (order.length !== n || order.indexOf(S.index) < 0) buildOrder(S.index);
    const pos = orderPos + (dir > 0 ? 1 : -1);
    if (pos >= 0 && pos < order.length){
      orderPos = pos;
      return order[orderPos];
    }
    if (S.repeat === 'off') return -1;      // 一轮发完就停
    if (dir > 0){
      buildOrder(-1);                       // 重新洗牌开下一轮
      return order[0];
    }
    orderPos = order.length - 1;
    return order[orderPos];
  }

  const i = S.index + dir;
  if (i < 0) return S.repeat === 'off' ? -1 : n - 1;
  if (i >= n) return S.repeat === 'off' ? -1 : 0;
  return i;
}

function onEnded(){
  // 安卓侧 ExoPlayer 自己会往下走，只有队列真的播完才回到这里
  if (IS_ANDROID){ setPlaying(false); return; }
  if (S.repeat === 'one'){ seekTo(0); setPlaying(true); return; }
  const i = nextIndex(1);
  if (i < 0){ setPlaying(false); seekTo(0); return; }
  playIndex(i, true);
}

function goNext(){
  if (IS_ANDROID){ backend.next(); return; }
  const i = nextIndex(1);
  if (i >= 0) playIndex(i, S.playing);
}

function goPrev(){
  if (IS_ANDROID){ backend.prev(); return; }
  if (S.t > 3){ seekTo(0); return; }
  const i = nextIndex(-1);
  if (i >= 0) playIndex(i, S.playing);
}

/* 通知栏/锁屏切歌后，把 UI 拉回当前曲目（不重新 load 音频） */
async function syncTrack(index){
  if (index < 0 || index >= S.tracks.length || index === S.index) return;
  S.index = index;
  const tr = S.tracks[index];
  S.duration = tr.duration || S.duration;
  paintMeta(tr);
  paintCover(tr);
  const raw = await loadLyrics(tr);
  lyricsView.setLines(raw ? lrcToLines(raw, S.duration) : []);
  applyView();
  library.updatePlaying(index, S.playing);
}

function toggleShuffle(){
  S.shuffle = !S.shuffle;
  order = [];                 // 开关一次就重新洗牌
  transport.setShuffle(S.shuffle);
  if (IS_ANDROID) backend.setShuffle(S.shuffle);
  savePrefs();
  if (S.shuffle){
    buildOrder(S.index);
    toast('随机播放 · 打乱后' + (S.repeat === 'off' ? '播完一轮停'
      : S.repeat === 'one' ? '单曲反复' : '整轮循环'));
  } else {
    toast('顺序播放 · 按曲库顺序' + (S.repeat === 'off' ? '，播完停' : '循环'));
  }
}

function repeatText(mode){
  return mode === 'one' ? '单曲循环' : mode === 'all' ? '列表循环' : '不循环';
}

/* 循环模式：列表循环 → 单曲循环 → 不循环 → 列表循环
   与随机是正交的两件事：
     不循环     播到最后一首就停
     列表循环   播完一轮从头再来
     单曲循环   当前这首反复播
   随机开着时先把整库洗成一副牌，再按上面的规则走完这一轮。 */
function cycleRepeat(){
  S.repeat = S.repeat === 'all' ? 'one' : S.repeat === 'one' ? 'off' : 'all';
  transport.setRepeat(S.repeat);
  if (IS_ANDROID) backend.setRepeat(S.repeat);
  savePrefs();
  const detail = S.repeat === 'off' ? '播到最后一首就停'
    : S.repeat === 'one' ? '当前这首反复播'
    : '播完一轮从头再来';
  toast(repeatText(S.repeat) + ' · ' + detail +
    (S.shuffle ? '（随机开着：打乱顺序后按这个规则走）' : ''));
}

/* ================= 曲库 ================= */
function setLibrary(tracks, autoplay){
  S.tracks = (tracks || []).map(restoreImportedLyrics);
  S.source = 'library';
  order = [];                 // 曲库换了，随机牌堆作废
  renderLib();
  $('empty').classList.remove('show');

  if (!S.tracks.length){
    showEmpty();
    return;
  }

  const lastId = getLastId();
  let idx = S.tracks.findIndex(t => t.id === lastId);
  if (idx < 0) idx = 0;
  playIndex(idx, autoplay);
}

function showEmpty(){
  $('emptyTitle').textContent = '把唱片放上来';
  $('emptyDesc').innerHTML = IS_ANDROID
    ? '扫描手机里的音乐，<br>它会把歌整理成一张唱片。'
    : '选择一个放音乐的文件夹，<br>它会把里面的歌整理成一张唱片。';
  $('empty').classList.add('show');
  $('emptyDemo').hidden = !IS_WEB;
}

function showRestoring(){
  $('emptyTitle').textContent = '正在恢复曲库';
  $('emptyDesc').innerHTML = '扫描上次的文件夹…';
  $('empty').classList.add('show');
  $('emptyDemo').hidden = true;
}

/* 桌面端后台扫曲库时的占位：不挡屏，只在标题区显示"正在读" */
function showLoading(){
  $('tEyebrow').textContent = 'LOADING LIBRARY';
  $('tTitle').textContent = '正在读取曲库…';
  $('tArtist').textContent = '歌一会儿就来，先转起来';
  $('tCredit').textContent = '';
  $('tTitle').style.opacity = '.55';
}

async function pick(){
  library.setBusy(true);
  try {
    const res = await pickLibrary();
    if (!res) return;
    if (!res.tracks.length && !res.dir) return;   // 用户取消
    if (res.dir){
      // 先把目录落盘：曲库大时第一首可能要转码，失败也不能把目录丢了
      S.folder = res.dir;
      savePrefs();
    }
    if (!res.tracks.length){
      toast(IS_ANDROID ? '没找到音乐，检查一下读取权限' : '这个文件夹里没有找到音频文件');
      return;
    }
    setLibrary(res.tracks, false);
    toast('找到 ' + res.tracks.length + ' 首');
  } catch (e){
    toast('扫描失败：' + (e && e.message ? e.message : e));
  } finally {
    library.setBusy(false);
  }
}

async function doRescan(){
  library.setBusy(true);
  try {
    const res = await rescan(S.folder);
    if (res && res.tracks){
      const curId = currentTrack() ? currentTrack().id : '';
      S.tracks = res.tracks;
      order = [];
      renderLib();
      if (!S.tracks.length) showEmpty();
      const i = S.tracks.findIndex(t => t.id === curId);
      if (i >= 0 && i !== S.index) S.index = i;
      toast('已刷新 · ' + S.tracks.length + ' 首');
    }
  } catch (e){
    // 目录被删/移动/U 盘拔了：清掉记忆，下次让用户重选
    if (IS_DESKTOP && S.folder){
      S.folder = '';
      savePrefs();
      showEmpty();
      toast('上次的文件夹找不到了，请重新选择');
    } else {
      toast('刷新失败');
    }
  } finally {
    library.setBusy(false);
  }
}

async function doImportLyrics(){
  const tr = currentTrack();
  if (!tr) return;
  const text = await importLyrics(tr);
  if (!text){ toast('没有导入歌词'); return; }
  lyricsView.setLines(lrcToLines(text, S.duration));
  applyView();
  toast('歌词已导入');
}

/* ================= 歌单 ================= */
let plPickFor = '';

function refreshPlaylists(){
  library.playlists = getPlaylists();
  library.renderPlaylists();
  library.renderTracks();
}

function doCreatePlaylist(){
  const input = $('plName');
  const typed = (input.value || '').trim();
  const list = getPlaylists();
  const name = typed || ('歌单 ' + (list.length + 1));
  createPlaylist(name);
  input.value = '';
  refreshPlaylists();
  toast('已创建「' + name + '」');
}

function doAddToPlaylist(trackId){
  if (!trackId) return;
  const list = getPlaylists();
  if (!list.length){
    toast('还没有歌单，先建一个');
    library.setTab('playlists');
    return;
  }
  if (list.length === 1){
    const ok = addToPlaylist(list[0].id, trackId);
    toast(ok ? ('已加入「' + list[0].name + '」') : '已经在这个歌单里了');
    refreshPlaylists();
    return;
  }
  plPickFor = trackId;
  $('plPickList').innerHTML = list.map(p =>
    '<button class="tool" data-pl="' + p.id + '">' + esc(p.name) + ' · ' + p.ids.length + ' 首</button>'
  ).join('');
  $('plPick').hidden = false;
}

function doRemoveFromPlaylist(plId, trackId){
  removeFromPlaylist(plId, trackId);
  refreshPlaylists();
  toast('已移出歌单');
}

function doPlaylistAction(act, id){
  if (!id) return;
  if (act === 'delete'){
    deletePlaylist(id);
    library.drill = null;
    refreshPlaylists();
    toast('歌单已删除');
  }
}

/* ================= 设置 ================= */

/* 屏幕相关设置要落到原生窗口上，Web 端没有这两件事 */
function applyScreenPrefs(){
  if (!IS_ANDROID || !HAS_ANDROID) return;
  try { acall('keepScreenOn', { on: !!S.keepOn }); } catch (_) {}
  try { acall('hideStatusBar', { on: !!S.hideBar }); } catch (_) {}
}

/* ================= 背景色板 =================
   预设色卡是纯 CSS（.pal-*），真正把类/自定义色相写上去的是 index.html 里
   那段引导脚本（它必须在首帧之前跑，否则启动幕会先闪一下默认红色）。
   这里只是转调；入口保留一份兜底，免得脚本被裁掉时整页没背景。 */
const BG_HUE = { crimson: 355, amber: 26, pine: 152, indigo: 222, violet: 288, charcoal: 214 };
const BG_NAME = { crimson: '绯红', amber: '琥珀', pine: '松绿', indigo: '藏蓝', violet: '紫罗兰', charcoal: '石墨' };

function currentBgHue(){
  return S.bg === 'custom' ? S.bgHue : (BG_HUE[S.bg] != null ? BG_HUE[S.bg] : 355);
}

function applyBg(){
  if (typeof window.__vpBgApply === 'function'){
    window.__vpBgApply(S.bg, S.bgHue);
    return;
  }
  document.body.className = document.body.className
    .replace(/\bpal-[a-z]+\b/g, '').trim() + ' pal-' + (BG_HUE[S.bg] != null ? S.bg : 'crimson');
}

/* 设置页自己缓存了一份状态，改完要同步过去再重绘，否则界面还显示旧值 */
function refreshSettings(){
  library.view = S.view;
  library.volume = S.volume;
  library.keepOn = S.keepOn;
  library.hideBar = S.hideBar;
  library.immMotion = S.immMotion;
  library.bg = S.bg;
  library.bgHue = currentBgHue();
  library.closeAction = S.closeAction;
  library.renderSettings();
}

function doSetting(key){
  if (key === 'reset-stats'){
    resetStats();
    library.renderSettings();
    library.renderTracks();
    toast('听歌统计已清空');
  } else if (key === 'view'){
    S.view = S.view === 'visual' ? 'lyrics' : 'visual';
    savePrefs();
    applyView();
    refreshSettings();
    toast('默认视图：' + (S.view === 'visual' ? '频谱' : '歌词'));
  } else if (key === 'keep-on'){
    S.keepOn = !S.keepOn;
    savePrefs();
    applyScreenPrefs();
    refreshSettings();
    toast(S.keepOn ? '屏幕常亮 · 已开启' : '屏幕常亮 · 已关闭');
  } else if (key === 'hide-bar'){
    S.hideBar = !S.hideBar;
    savePrefs();
    applyScreenPrefs();
    refreshSettings();
    toast(S.hideBar ? '顶部状态栏 · 已隐藏' : '顶部状态栏 · 已显示');
  } else if (key === 'imm-motion'){
    S.immMotion = !S.immMotion;
    savePrefs();
    refreshSettings();
    toast(S.immMotion ? '沉浸放大 · 已开启' : '沉浸放大 · 已关闭');
  } else if (key.indexOf('bg-') === 0 && BG_NAME[key.slice(3)]){
    S.bg = key.slice(3);
    savePrefs();
    applyBg();
    refreshSettings();
    toast('背景 · ' + BG_NAME[S.bg]);
  } else if (key === 'close-quit' || key === 'close-tray' || key === 'close-ask'){
    S.closeAction = key.slice(6);
    savePrefs();
    pushCloseAction();
    refreshSettings();
    toast('关闭窗口时：' + closeText(S.closeAction));
  } else if (key === 'notif'){
    if (HAS_ANDROID) acall('openNotifSettings');
  }
}

/* ================= 本次已听 ================= */
/* 只统计"真的在播"的墙钟时间，暂停、拖拽、拖进度都不算；重启归零 */
let sessSec = 0;
let sessMin = -1;

function paintSession(){
  const m = Math.floor(sessSec / 60);
  if (m === sessMin) return;
  sessMin = m;
  const el = $('sessMin');
  if (el) el.textContent = String(m);
}

/* ================= 提示 ================= */
let toastTimer = 0;
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ================= 渲染循环 ================= */
let last = performance.now();
let saveTick = 0;
let playAccum = 0;      // 待结算的收听秒数
let playAccumId = '';

function loop(now){
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!disc.scratching && !S.scrubbing && S.playing){
    S.t = backend.time;
  }
  const bd = backend.duration;
  if (bd > 0 && Math.abs(bd - S.duration) > 0.6) S.duration = bd;

  disc.tick(dt, S.playing);
  backend.pull();

  transport.update(S.t, S.duration || bd, S.playing);

  const i = lyricsView.indexAt(S.t);
  if (i >= 0) lyricsView.setActive(i);
  if (viewMode() === 'visual') spectrum.draw(S.playing);

  // 收听时长按「实际在播」的墙钟累加，5 秒结算一次
  if (S.playing && !disc.scratching && !S.scrubbing){
    playAccum += dt;
    sessSec += dt;
    paintSession();
    if (playAccum >= 5){
      const tr = currentTrack();
      if (tr) addSeconds(tr, playAccum);
      playAccum = 0;
    }
  }

  saveTick += dt;
  if (saveTick > 8 && S.playing){
    saveTick = 0;
    const tr = currentTrack();
    if (tr) saveResume(tr.id, S.t);
  }

  requestAnimationFrame(loop);
}

/* 切歌/暂停时把零头结算掉，不然最后几秒会丢 */
function flushListen(){
  if (playAccum >= 1 && playAccumId){
    const tr = S.tracks.find(t => t.id === playAccumId);
    if (tr) addSeconds(tr, playAccum);
  }
  playAccum = 0;
}

/* ================= 桌面外壳：标题栏 / 关闭确认 ================= */

const TAURI_WIN = (() => {
  try { return (window.__TAURI__ && window.__TAURI__.window) || null; } catch (_) { return null; }
})();

function win(){
  try { return TAURI_WIN.getCurrentWindow(); } catch (_) { return null; }
}

/* Mac 交通灯 + 整条拖动区域 */
function wireTitlebar(){
  if (!IS_DESKTOP || !TAURI_WIN) return;
  const w = win();
  if (!w) return;
  const tap = (fn) => () => { try { fn(); } catch (_) {} };
  $('winMin').addEventListener('click', tap(() => w.minimize()));
  $('winMax').addEventListener('click', tap(() => w.toggleMaximize()));
  $('winClose').addEventListener('click', tap(() => w.close()));
  // 双击标题栏最大化（Mac 习惯），点在按钮上不算
  $('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.tl-btn')) return;
    try { w.toggleMaximize(); } catch (_) {}
  });
}

/* 关闭确认：Rust 侧发现没记住选择时会发 vp://ask-close */
let closeAsking = false;

function openCloseModal(){
  if (closeAsking) return;
  closeAsking = true;
  $('closeRemember').checked = false;
  $('closeModal').classList.add('show');
}

function closeCloseModal(){
  closeAsking = false;
  $('closeModal').classList.remove('show');
}

/* 把当前选择同步给 Rust，下次点关闭就直接照做，不再问 */
function pushCloseAction(){
  if (!IS_DESKTOP || !HAS_TAURI) return;
  try { invoke('set_close_action', { action: S.closeAction }); } catch (_) {}
}

async function resolveClose(action){
  const remember = !!$('closeRemember').checked;
  closeCloseModal();
  if (remember){
    S.closeAction = action;
    savePrefs();
  }
  try { await invoke('resolve_close', { action: action, remember: remember }); } catch (_) {}
}

function closeText(a){
  return a === 'quit' ? '直接退出' : a === 'tray' ? '后台播放' : '每次询问';
}

$('closeQuit').addEventListener('click', () => resolveClose('quit'));
$('closeTray').addEventListener('click', () => resolveClose('tray'));
$('closeCancel').addEventListener('click', () => closeCloseModal());
$('closeModal').addEventListener('click', (e) => {
  if (e.target === $('closeModal')) closeCloseModal();
});

/* ================= 沉浸播放 =================
   全屏 + 底部控件自动隐藏 + 阻止系统休眠。快捷键 F 进 / Esc 退。
   三端各自的"全屏"和"别睡"都不同，这里分开处理。 */
let immersive = false;
let wakeLock = null;
let ctrlTimer = 0;

async function keepAwake(on){
  // 安卓：复用原生常亮开关；退出沉浸时按设置里的选择还原
  if (IS_ANDROID && HAS_ANDROID){
    try { acall('keepScreenOn', { on: on || !!S.keepOn }); } catch (_) {}
    return;
  }
  // 桌面：SetThreadExecutionState（Rust 侧有常驻线程持有这个状态）
  if (IS_DESKTOP){
    try { await invoke('keep_awake', { on }); } catch (_) {}
    return;
  }
  // 网页：Screen Wake Lock。页面切到后台会被系统收走，回来要重新申请
  try {
    if (on){
      if ('wakeLock' in navigator && !wakeLock){
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } else if (wakeLock){
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) {}
}

/* 鼠标一动就把底栏亮出来，2.6 秒没动静再淡下去 */
function showCtrlBar(){
  if (!immersive) return;
  document.body.classList.remove('ctrl-hidden');
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => {
    if (immersive) document.body.classList.add('ctrl-hidden');
  }, 2600);
}

/* 沉浸切换
   ========
   窗口和内容必须在**同一帧**换完。上一版是"class 先切、invoke 后调"，注释里
   假设"同一个任务里浏览器不会插一帧"——但 invoke 是跨 IPC 的异步调用，中间
   必然按旧窗口尺寸先画 1~3 帧新版式，然后窗口再跳，读起来是两段。

   现在的顺序：
     1. 记录旧唱片位置（FLIP 用），锁住所有会自己动的过渡（body.imm-swap）；
     2. 先调原生全屏 / hideStatusBar，再等真实的 resize；
     3. **在 resize 回调里**同步切 class、无过渡地重新居中歌词 —— resize 在绘制
        之前派发，所以新版式和新尺寸一起提交，没有中间帧；窗口尺寸本来就不变时
        最多等 4 帧后兜底执行；
     4. 260ms 后解锁：盖住 --ctrl-h 的二次测量和 ResizeObserver 的二次居中，
        否则歌词会在切完之后再自己滑 .62s（上一版"割裂"的主因）。
   全屏本身仍是硬切，和 mpv / VLC 一样；不同的是切点之后没有任何东西还在动
   （唯一在动的是可关掉的唱片放大，见 imm-motion）。 */
/* immersive / wakeLock / ctrlTimer 在上面「沉浸播放」那一段已经声明过 */
let swapLocked = false;
let flipTimer = 0;
let immSeq = 0;      // 连点两下时只让最后一次切换落地（见 setImmersive）

/* 无边框窗口（Tauri 的 decorations:false）客户区和外框基本重合，
   所以 screenX/screenY 就是客户区原点；网页版有标题栏，会有十几像素误差，
   对一次 400ms 的放大过渡可以忽略。 */
function viewOrigin(){
  return {
    x: typeof window.screenX === 'number' ? window.screenX : 0,
    y: typeof window.screenY === 'number' ? window.screenY : 0
  };
}

/* 切换那几帧：titlebar / controls / panel / lyric-track 一律不带过渡。
   只挂一下，切换完成后由 unlockSwap 摘掉。 */
function lockSwap(){
  if (swapLocked) return;
  swapLocked = true;
  document.body.classList.add('imm-swap');
}
function unlockSwap(){
  if (!swapLocked) return;
  swapLocked = false;
  document.body.classList.remove('imm-swap');
}

/* 原生全屏是异步的：真来了 resize 就在**回调里立刻**换版式（resize 在绘制前派发，
   所以新尺寸和新版式一起提交，中间不会有"大窗口 + 旧版式"的帧）；
   窗口本来就是这个尺寸时最多等 4 帧再兜底执行。

   `changed` 用来处理"resize 已经派发过"的情况：Tauri 的 invoke 要跨 IPC，
   原生窗口可能已经变完、resize 也已经发出去，响应才回到 JS —— 这时再挂监听
   就永远等不到它，只能白等 4 帧。视口尺寸已经不是旧值就直接换。 */
function settleResize(apply, changed){
  return new Promise((resolve) => {
    let done = false;
    const onResize = () => fin(true);
    const fin = (fire) => {
      if (done) return;
      done = true;
      window.removeEventListener('resize', onResize);
      if (fire) apply();
      resolve();
    };
    if (changed && changed()){
      apply();
      resolve();
      return;
    }
    window.addEventListener('resize', onResize, { once: true });
    let n = 4;
    const tick = () => (--n <= 0 ? fin(false) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

function clearDeckFlip(){
  clearTimeout(flipTimer);
  const platter = $('platter');
  if (!platter) return;
  platter.classList.remove('imm-flipping');
  platter.style.transition = '';
  platter.style.transform = '';
}

/* 唱片 FLIP：把新布局里的 .platter 反向套回旧唱片的屏幕位置，再过渡回 identity。
   只动 transform（合成层），不碰宽高 / 边距 / padding，所以不会被窗口 resize
   打断，也不需要逐帧推窗口。
   动的是 .platter 而不是整块 .deck —— .deck 里还有一圈 hw 小标签和旋钮，
   它们的字号是固定的，跟着一起缩放会在起手时"变小再长回来"；.platter 里
   只有唱片和唱臂，整体等比，uniform scale 是精确的。 */
function flipDeck(oldRect, oldAt){
  const platter = $('platter');
  if (!platter || !oldRect || !oldRect.width) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const n = platter.getBoundingClientRect();
  if (!n.width) return;
  const s = oldRect.width / n.width;
  if (!(s > 0) || Math.abs(s - 1) < .02) return;   // 尺寸几乎没变（安卓只收状态栏）

  clearTimeout(flipTimer);
  const now = viewOrigin();
  /* 旧 rect 是旧视口的坐标。屏幕上"窗口居中 → 全屏铺满"时，旧内容在屏幕上的
     位置 = 旧视口坐标 + 旧窗口原点；再减掉新窗口原点就是新视口里的起点。 */
  const ocx = oldRect.left + oldRect.width / 2 + oldAt.x - now.x;
  const ocy = oldRect.top + oldRect.height / 2 + oldAt.y - now.y;
  const ncx = n.left + n.width / 2;
  const ncy = n.top + n.height / 2;

  platter.classList.add('imm-flipping');
  platter.style.transition = 'none';
  /* 圆盘默认以自身中心为原点：先按中心缩到旧尺寸，再平移到旧圆心，
     正好是第一帧的旧画面；过渡回 identity 就是"长到全屏"。 */
  platter.style.transform =
    'translate(' + (ocx - ncx) + 'px,' + (ocy - ncy) + 'px) scale(' + s + ')';
  void platter.offsetWidth;                         // 起点先落定，别和终点合成一次
  requestAnimationFrame(() => {
    platter.style.transition = 'transform .42s cubic-bezier(.22,.72,.2,1)';
    platter.style.transform = 'none';
  });
  flipTimer = setTimeout(clearDeckFlip, 520);
}

async function setImmersive(on){
  if (on === immersive) return;
  immersive = on;
  /* 连点两下（比如进入后立刻退出）时，两次切换的 invoke 会并排跑；
     只有最后发出的那次允许改版式，前一次回来时直接作废。 */
  const seq = ++immSeq;
  const b = $('immersiveBtn');
  if (b) b.setAttribute('aria-pressed', String(on));

  clearDeckFlip();

  /* 旧位置必须在窗口变化前量 */
  let oldRect = null, oldAt = null;
  if (S.immMotion && $('platter') && !matchMedia('(prefers-reduced-motion: reduce)').matches){
    oldRect = $('platter').getBoundingClientRect();
    oldAt = viewOrigin();
  }

  lockSwap();
  /* invoke 回来时视口可能已经变了（resize 事件也许已经派发过）——见 settleResize */
  const vw0 = window.innerWidth, vh0 = window.innerHeight;

  /* 换版式的全部动作，放在一个幂等函数里：resize 先到就在回调里跑（同一帧），
     没等到 resize 就由下面的兜底跑一次。 */
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    if (seq !== immSeq) return;   // 已经被后一次切换接管
    document.body.classList.toggle('immersive', on);
    /* 控件高度随视口宽度变（左右内边距是 vw 的），--ctrl-h 默认由 RO 在下一帧
       才更新；这里同步量一次，否则退出沉浸时面板会先用全屏的留白画几帧，
       再"啪"地收一下 —— 又是一次切完之后的位移。 */
    syncCtrlH();
    lyricsView.center();
    if (on){
      showCtrlBar();
    } else {
      clearTimeout(ctrlTimer);
      document.body.classList.remove('ctrl-hidden');
    }
    if (oldRect) flipDeck(oldRect, oldAt);
  };

  try {
    if (IS_DESKTOP && TAURI_WIN){
      await invoke('set_fullscreen', { on });
    } else if (IS_ANDROID && HAS_ANDROID){
      acall('hideStatusBar', { on: on ? true : !!S.hideBar });
    } else if (on && document.documentElement.requestFullscreen){
      await document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement && document.exitFullscreen){
      await document.exitFullscreen().catch(() => {});
    }
  } catch (e) { logBoot('imm: ' + e); }

  await settleResize(apply, () => window.innerWidth !== vw0 || window.innerHeight !== vh0);
  apply();
  if (seq !== immSeq) return;   // 后一次切换已经在跑了，这里不要弹提示 / 别改休眠

  if (on){
    keepAwake(true);
    // 手机上没有键盘，别提示快捷键
    toast(IS_ANDROID || matchMedia('(hover:none)').matches
      ? '沉浸播放 · 再点一次退出'
      : '沉浸播放 · 按 F 或 Esc 退出');
  } else {
    keepAwake(false);
  }

  /* --ctrl-h 的二次测量、RO 的二次居中可能晚一两帧，锁要盖到它们后面 */
  setTimeout(unlockSwap, 260);
  logBoot('imm: ' + (on ? 'enter' : 'leave'));
}

if ($('immersiveBtn')) $('immersiveBtn').addEventListener('click', () => setImmersive(!immersive));
window.addEventListener('pointermove', showCtrlBar, { passive: true });
window.addEventListener('pointerdown', showCtrlBar, { passive: true });
/* 浏览器里按 Esc 会自己退全屏：视口已经变回去了，直接做一次无过渡的收尾，
   不能再等 resize（否则会看到"小窗口 + 全屏版式"的中间态）。 */
document.addEventListener('fullscreenchange', () => {
  if (!immersive || document.fullscreenElement) return;
  immersive = false;
  const b = $('immersiveBtn');
  if (b) b.setAttribute('aria-pressed', 'false');
  clearDeckFlip();
  lockSwap();
  document.body.classList.remove('immersive');
  document.body.classList.remove('ctrl-hidden');
  syncCtrlH();
  lyricsView.center();
  clearTimeout(ctrlTimer);
  keepAwake(false);
  setTimeout(unlockSwap, 260);
  logBoot('imm: leave(fs)');
});
/* 从后台回来重新申请 wake lock */
document.addEventListener('visibilitychange', () => {
  if (immersive && !document.hidden) keepAwake(true);
});

/* ================= 事件接线 ================= */
$('libBtn').addEventListener('click', () => library.toggle());
$('emptyPick').addEventListener('click', () => pick());
$('emptyDemo').addEventListener('click', () => {
  S.tracks = [DEMO]; S.index = 0; S.source = 'demo';
  $('empty').classList.remove('show');
  renderLib({ showLrcImport: false });
  playIndex(0, true);
});
$('prev').addEventListener('click', () => goPrev());
$('next').addEventListener('click', () => goNext());

/* 心形按钮：收藏 / 取消收藏 */
favBtn.addEventListener('click', () => {
  const tr = currentTrack();
  if (!tr) return;
  const on = toggleFavorite(tr.id);
  paintFav(tr);
  refreshPlaylists();
  toast(on ? ('已收藏「' + (tr.title || '这首') + '」') : '已取消收藏');
});

/* 加入歌单选择层 */
$('plPickCancel').addEventListener('click', () => { $('plPick').hidden = true; });
$('plPick').addEventListener('click', (e) => {
  if (e.target === $('plPick')) $('plPick').hidden = true;
});
$('plPickList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pl]');
  if (!b) return;
  const ok = addToPlaylist(b.dataset.pl, plPickFor);
  const p = getPlaylists().find(x => x.id === b.dataset.pl);
  $('plPick').hidden = true;
  toast(ok ? ('已加入「' + (p ? p.name : '') + '」') : '已经在这个歌单里了');
  refreshPlaylists();
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space'){ e.preventDefault(); ensureAudio(); togglePlay(); }
  else if (e.code === 'ArrowRight'){ seekTo(S.t + 5, true); }
  else if (e.code === 'ArrowLeft'){ seekTo(S.t - 5, true); }
  else if (e.code === 'ArrowUp'){ e.preventDefault(); lyricsView.setActive(Math.max(0, lyricsView.active - 1)); }
  else if (e.code === 'ArrowDown'){ e.preventDefault(); lyricsView.setActive(Math.min(lyricsView.els.length - 1, lyricsView.active + 1)); }
  else if (e.key === 'l' || e.key === 'L'){ library.toggle(); }
  else if (e.key === 'f' || e.key === 'F'){ setImmersive(!immersive); }
  else if (e.key === 'Escape' && immersive){ setImmersive(false); }
  else if (e.key === '/'){
    e.preventDefault();
    library.open();
    library.focusSearch();
  }
});

if (!IS_ANDROID){
  audioEl.addEventListener('ended', () => onEnded());
  audioEl.addEventListener('play', () => document.body.classList.remove('needs-tap'));
  audioEl.addEventListener('error', () => {
    if (S.tracks.length && S.index >= 0) toast('音频加载失败：' + (currentTrack().format || ''));
  });
}

/* 底部控件是绝对定位的（见 panel.css），面板用 padding-bottom 给它留位，
   高度只能量：视口宽高、字体、是否显示转速铭牌都会影响它。
   沉浸切换那一帧要立刻拿到新值，所以这里暴露一个同步量法（见 syncCtrlH）。 */
let syncCtrlH = () => {};
const ctrlEl = document.querySelector('.controls');
if (ctrlEl){
  let ctrlLast = -1, ctrlRaf = 0;
  const setCtrlH = (h) => {
    if (h === ctrlLast) return;
    ctrlLast = h;
    document.documentElement.style.setProperty('--ctrl-h', h + 'px');
  };
  // 首帧同步量一次，别让面板用默认留白闪一下
  setCtrlH(ctrlEl.offsetHeight);
  syncCtrlH = () => setCtrlH(ctrlEl.offsetHeight);
  /* 之后走 rAF 合流 + 值比较：窗口剧变时 RO 和 resize 会在同一帧里连进来，
     回调里同步读 offsetHeight 会强制布局，一轮改一轮，正好是浏览器报
     "ResizeObserver loop completed with undelivered notifications" 的成因。 */
  const pushCtrlH = () => {
    if (ctrlRaf) return;
    ctrlRaf = requestAnimationFrame(() => {
      ctrlRaf = 0;
      setCtrlH(ctrlEl.offsetHeight);
    });
  };
  if (window.ResizeObserver) new ResizeObserver(pushCtrlH).observe(ctrlEl);
}

const reflow = debounce(() => {
  lyricsView.center();
  spectrum.size();
}, 120);

/* ---- 视口自愈 ----
   安卓 WebView 声明了 configChanges 自己处理旋转，Chromium 不会重建页面，
   却会把上一次的 page scale 留着：真机实测旋转后 visualViewport.scale = 1.16、
   可视区只剩 787×354（屏幕是 914×411），于是整屏被放大、右边被切掉、
   底部控件掉到屏幕外，来回转还会越转越偏。播放时主线程被渲染循环占满，
   "旋转后重算视口"这一步更容易被跳过——这就是为什么只有播放状态会跑偏。

   对策：每次视口变化后校验一次 scale，不为 1 就重写 meta viewport 逼
   Chromium 重新解析（原生壳在 onConfigurationChanged 里也会主动调 __vpHeal）。 */
const VP_META = document.querySelector('meta[name="viewport"]');
function healViewport(){
  const vv = window.visualViewport;
  if (!vv) return;
  if (vv.scale > 1.02 && VP_META){
    const cur = VP_META.getAttribute('content') || '';
    // 先摘掉再写回：值不变也会触发一次 viewport 重新解析
    VP_META.setAttribute('content', 'width=device-width,initial-scale=1');
    VP_META.setAttribute('content', cur);
    void document.documentElement.offsetHeight;
  }
  lyricsView.center();
  spectrum.size();
}
/* 原生壳旋转后调用；两次是为了等布局真的落定（有一次是转场动画中途） */
window.__vpHeal = () => {
  healViewport();
  setTimeout(healViewport, 120);
  setTimeout(healViewport, 360);
};
const healSoon = debounce(healViewport, 90);

window.addEventListener('resize', () => { healSoon(); reflow(); });
window.addEventListener('orientationchange', () => {
  setTimeout(healViewport, 280);
  setTimeout(healViewport, 620);
});
if (window.visualViewport){
  window.visualViewport.addEventListener('resize', healSoon);
  window.visualViewport.addEventListener('scroll', healSoon);
}
window.addEventListener('beforeunload', () => {
  flushListen();
  flushStats();
  savePrefs();
  const tr = currentTrack();
  if (tr) saveResume(tr.id, S.t);
});

/* ================= 安卓事件（原生桥 → JS） ================= */
function onPositionEvent(p){
  backend.onPosition((p && p.position) || 0, (p && p.duration) || 0, !!(p && p.playing));
}

function onSpectrumEvent(a){
  backend.onSpectrum(a);
}

function onStateEvent(s){
  const state = typeof s === 'string' ? s : (s && s.state) || '';
  backend.onState(state);
  if (state === 'ended'){ onEnded(); return; }
  if (state === 'playing' && !S.playing){
    S.playing = true;
    document.body.classList.add('is-playing');
    library.updatePlaying(S.index, true);
  }
  if ((state === 'paused' || state === 'idle') && S.playing){
    S.playing = false;
    document.body.classList.remove('is-playing');
    library.updatePlaying(S.index, false);
  }
}

function onCommandEvent(c){
  const cmd = typeof c === 'string' ? c : (c && c.command) || '';
  if (cmd === 'next'){ const i = nextIndex(1); if (i >= 0) playIndex(i, true); }
  else if (cmd === 'prev'){ const i = nextIndex(-1); if (i >= 0) playIndex(i, true); }
  else if (cmd === 'pause'){ setPlaying(false); }
  else if (cmd === 'play'){ setPlaying(true); }
}

/* 原生把安全区推过来（单位已经是 CSS 像素）。
   WebView 不解 env(safe-area-inset-*)，只能由壳子算好塞进 CSS 变量：
   状态栏 / 手势条底下要留白，但背景仍然铺满整屏，做到"内容让开、底色不留缝"。 */
window.__setInsets = (t, b, l, r) => {
  const s = document.documentElement.style;
  s.setProperty('--safe-t', (t || 0) + 'px');
  s.setProperty('--safe-b', (b || 0) + 'px');
  s.setProperty('--safe-l', (l || 0) + 'px');
  s.setProperty('--safe-r', (r || 0) + 'px');
  document.body.classList.add('has-insets');
};

/* 安卓壳通过 evaluateJavascript 调这里 */
window.__playerEvent = (name, payload) => {
  if (name === 'position') onPositionEvent(payload);
  else if (name === 'spectrum') onSpectrumEvent(payload);
  else if (name === 'state') onStateEvent(payload);
  else if (name === 'command') onCommandEvent(payload);
  else if (name === 'track') syncTrack(payload && payload.index);
  else if (name === 'toast') toast(typeof payload === 'string' ? payload : '');
};

/* 安卓返回键：先关曲库，再退到后台（不杀播放） */
window.__back = () => {
  if (library.isOpen){ library.close(); return true; }
  return false;
};

/* 权限刚授予时重新拉一次曲库 */
window.__rescan = async () => {
  if (!IS_ANDROID) return;
  try {
    const res = await rescan('');
    if (res && res.tracks.length){
      if (!S.tracks.length) setLibrary(res.tracks, false);
      else {
        S.tracks = res.tracks;
        renderLib();
      }
    }
  } catch (_) {}
};

/* ================= 启动幕 =================
   HTML 里 body 一开始就带 .booting（deck / panel 是透明的），
   这里负责在"界面真的准备好了"的时候去掉它：
     1. 等两帧，确保首帧已经排好版（不然淡入会先露一下错位的布局）；
     2. 桌面端窗口是用 visible:false 创建的，到这一刻才 show()，
        所以屏幕上出现的第一帧就是启动幕，不是一片空底色；
     3. 再去 .booting（内容缓进）+ 加 .boot-done（幕淡出），两件事同时发生。 */
const bootStart = performance.now();
let bootRevealed = false;
let windowShown = false;

/* 桌面端窗口是 visible:false 建出来的。这里负责把它放出来 —— 但只是"放出来"，
   界面还不揭幕：用户先看到的是启动幕（品牌感 + 明确"在启动"），
   等曲库/首帧准备好再化开，中间不会有半截界面晃一下。 */
async function showWindow(){
  if (windowShown || !IS_DESKTOP) return;
  windowShown = true;
  try { await invoke('frontend_ready', {}); } catch (_) {}
}

async function revealApp(){
  if (bootRevealed) return;
  bootRevealed = true;
  await showWindow();
  if (IS_DESKTOP){
    // 窗口刚出现时，幕上的唱片标还要缓缓亮一下，给它一点时间
    await new Promise((r) => setTimeout(r, 240));
  }
  // 等两帧，确保首帧已经按最终布局排好（不然淡入会先露一下错位的排版）
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // 起幕太快等于没动画，压一个下限
  const wait = 420 - (performance.now() - bootStart);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  document.body.classList.remove('booting');
  document.body.classList.add('boot-done');
  // 揭幕过渡挂到 1.15s（panel 再加 90ms 延迟），放完就把 boot-reveal 摘掉：
  // 不摘的话 .panel 会一直带着 1.15s 的 transform 过渡，后面沉浸切全屏
  // 只要它身上有 transform 变化就会被拖慢（见 styles/boot.css 的说明）。
  setTimeout(() => document.body.classList.remove('boot-reveal'), 1500);
}

/* ================= 启动 ================= */
async function boot(){
  loadPrefs();
  ensureFavorites();   // 「收藏」歌单先建出来，歌单页里始终在
  paintFav(currentTrack());
  applyBg();           // 引导脚本已经上过了；这里保证状态和 DOM 一定一致
  // ?view=visual / ?view=lyrics 强制指定视图，调试和无头截图用
  try {
    const v = new URLSearchParams(location.search).get('view');
    if (v === 'visual' || v === 'lyrics') S.view = v;
  } catch (_) {}
  document.body.classList.add(IS_ANDROID ? 'is-android' : IS_DESKTOP ? 'is-desktop' : 'is-web');

  // 按钮文案按平台走：安卓是扫系统媒体库，不是"选文件夹"
  if (IS_ANDROID){
    $('pickBtn').textContent = '扫描本机音乐';
    $('rescanBtn').textContent = '重新扫描';
    $('emptyPick').textContent = '扫描手机音乐';
  } else {
    $('pickBtn').textContent = '选择音乐文件夹';
    $('rescanBtn').textContent = '刷新';
    $('emptyPick').textContent = '选择文件夹';
  }

  transport.setVolume(S.volume);
  transport.setShuffle(S.shuffle);
  transport.setRepeat(S.repeat);
  backend.setVolume(S.volume);
  applyScreenPrefs();   // 常亮 / 隐藏状态栏：开机就按上次的选择恢复

  if (IS_ANDROID){
    await listen('player://position', onPositionEvent);
    await listen('player://spectrum', onSpectrumEvent);
    await listen('player://state', onStateEvent);
    await listen('player://command', onCommandEvent);
  }

  if (IS_DESKTOP){
    wireTitlebar();
    pushCloseAction();                       // 把"关闭时怎么处理"同步给壳子
    listen('vp://ask-close', () => openCloseModal());
  }

  watchPerf((p90) => {
    S.perfLow = true;
    document.body.classList.add('perf-low');
    spectrum.setLow(true);
    spectrum.size();
    console.info('[vinyl] 性能降档 p90=' + p90.toFixed(1) + 'ms');
  });

  requestAnimationFrame(loop);

  /* 量一下这台机器上这个页面**空闲时**能跑多少帧。
     这个数是判断"过渡帧数够不够"的基准：如果空闲也就 20fps，那过渡拿到
     12 帧/560ms 已经是满速，锅不在过渡本身；如果空闲 60fps 而过渡只有 20，
     说明重排重绘才是瓶颈，得从画布尺寸的推进方式上想办法。
     开机动画先跑完再量，别让首屏那几帧混进来。 */
  setTimeout(() => {
    let n = 0;
    const t0 = performance.now();
    (function tick(){
      n++;
      if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
      else logBoot('raf idle ' + n + 'f/s');
    })();
  }, 1600);

  if (IS_WEB){
    S.tracks = [DEMO];
    S.index = 0;
    S.source = 'demo';
    renderLib({ showLrcImport: false });
    await playIndex(0, false);
    setTimeout(() => { if (!S.playing) setPlaying(true); }, 700);
    logBoot('boot: web demo');
    revealApp();
    return;
  }

  if (IS_DESKTOP){
    logBoot('boot: desktop, folder=' + (S.folder || '-'));
    if (S.folder){
      // 直接进主界面，曲库在后台扫；扫完再把歌填进来。
      // 以前会先弹"正在恢复曲库"挡一屏，目录大时要等好几秒，体感很差。
      showLoading();
      // 窗口先出来，让人马上看到"在启动"（启动幕），曲库在幕后扫；
      // 扫完就揭幕，目录特别大也不干等，最多 1.4 秒。
      showWindow();
      setTimeout(revealApp, 1400);
      rescan(S.folder).then((res) => {
        if (res && res.tracks.length){
          setLibrary(res.tracks, false);
          $('empty').classList.remove('show');
          logBoot('boot: restored ' + res.tracks.length + ' tracks');
        } else {
          logBoot('boot: rescan empty');
          S.folder = '';
          savePrefs();
          showEmpty();
        }
        revealApp();
      }).catch((e) => {
        logBoot('boot: rescan failed ' + (e && e.message));
        // 目录不在了，清掉记忆，避免每次启动都白扫一遍
        S.folder = '';
        savePrefs();
        showEmpty();
        revealApp();
      });
      return;
    }
    showEmpty();
    logBoot('boot: empty state');
    revealApp();
    return;
  }

  showRestoring();
  setTimeout(revealApp, 700);
  try {
    const res = await rescan('');
    if (new URLSearchParams(location.search).has('diag')){
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:6px;top:56px;right:6px;z-index:99;font:10px monospace;color:#fff;background:rgba(0,0,0,.8);padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;line-height:1.5';
      let probeTxt = 'n/a';
      let keysTxt = 'n/a';
      let rawTxt = 'n/a';
      const A = window.AndroidPlayer || {};
      try {
        keysTxt = 'probe=' + (typeof A.probe) +
          ' ping=' + (typeof A.ping) +
          ' library=' + (typeof A.library) +
          ' arity.probe=' + (A.probe ? A.probe.length : '?') +
          ' arity.ping=' + (A.ping ? A.ping.length : '?');
      } catch (e){ keysTxt = 'ERR ' + e; }
      // 三种调用方式对照，定位是"调用不通"还是"方法体炸了"
      try { rawTxt = 'direct=' + String(A.probe('{}')); } catch (e){ rawTxt = 'direct THREW ' + (e && (e.message || e)); }
      try { rawTxt += ' | apply=' + String(A.probe.apply(A, ['{}'])); } catch (e){ rawTxt += ' | apply THREW ' + (e && (e.message || e)); }
      try { rawTxt += ' | ping=' + String(A.ping('{}')); } catch (e){ rawTxt += ' | ping THREW ' + (e && (e.message || e)); }
      // 直接看 library() 原始返回
      try {
        const libRaw = String(A.library('{}') || '');
        let parsed = 'unparsed';
        try { const j = JSON.parse(libRaw); parsed = 'parsed len=' + j.length; } catch (pe){ parsed = 'PARSE FAIL: ' + (pe && pe.message); }
        rawTxt += ' | lib.len=' + libRaw.length + ' | lib.' + parsed + ' | head=' + libRaw.slice(0, 150);
      } catch (e){ rawTxt += ' | lib THREW ' + (e && (e.message || e)); }
      try { probeTxt = acall('probe') || 'null'; } catch (e){ probeTxt = 'ERR ' + e; }
      d.textContent = 'bridge=' + HAS_ANDROID + ' android=' + IS_ANDROID +
        ' tracks=' + (res ? res.tracks.length : 'null') +
        '\nprobe=' + probeTxt +
        '\nkeys=' + keysTxt +
        '\nraw=' + rawTxt;
      document.body.appendChild(d);
    }
    if (res && res.tracks.length){
      setLibrary(res.tracks, false);
      $('empty').classList.remove('show');
    } else {
      showEmpty();
    }
    logBoot('boot: android tracks=' + S.tracks.length);
    revealApp();
  } catch (e){
    showEmpty();
    logBoot('boot: android scan failed');
    revealApp();
  }
}

function logBoot(msg){
  try {
    if (IS_DESKTOP) invoke('log_line', { msg: msg });
  } catch (_) {}
}

window.addEventListener('error', (e) => {
  const raw = e.message || '';
  /* ResizeObserver 的这条不是真错误：浏览器在同一帧里 RO 回调改了尺寸、
     新一轮通知还没投递完时会发这个警告，属于框架层噪音。WebView2 在
     全屏切换、窗口拉伸这种尺寸剧变时尤其容易触发 —— 以前它被当成脚本
     异常，在曲库为空时直接弹成 toast，看着像崩了，其实什么都没坏。 */
  if (/ResizeObserver loop/i.test(raw)) return;
  const msg = 'JS ERROR: ' + raw + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0);
  logBoot(msg);
  document.title = msg;
  if (S.tracks.length === 0) toast('出错了：' + (raw || '脚本异常'));
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const msg = 'REJECT: ' + ((r && (r.stack || r.message)) || String(r));
  logBoot(msg);
  document.title = msg.slice(0, 180);
});

boot().then(() => {
  // ?lib=1 直接打开音乐库，?tab=settings 指定页签
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('lib')){
      const el = $('sheet');
      const sc = $('scrim');
      // 无头截图时 CSS 过渡可能不推进，直接跳到位
      el.style.transition = 'none';
      sc.style.transition = 'none';
      library.open();
      const t = q.get('tab');
      if (t) library.setTab(t);
      setTimeout(() => { el.style.transition = ''; sc.style.transition = ''; }, 60);
    }
  } catch (_) {}
});

/* 诊断：访问 ?diag 时把关键盒子尺寸写进 title（无头浏览器取值用），
   同时叠一张实时数值面板（真机上看，安卓 release 包没法连 CDP） */
if (location.search.indexOf('diag') >= 0){
  const rd = (sel) => {
    const e = typeof sel === 'string' && sel[0] === '#' ? $(sel.slice(1)) : document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  };
  setTimeout(() => {
    document.title = JSON.stringify({
      vw: innerWidth, vh: innerHeight,
      stage: rd('.stage'), deck: rd('#deck'), platter: rd('#platter'),
      panel: rd('.panel'), lyrics: rd('#lyrics'), track: rd('#lyricTrack'),
      libBtn: rd('#libBtn'), row: rd('.row'), tf: ($('lyricTrack') || {}).style.transform || '',
      controls: rd('.controls'), btns: rd('.btns'), play: rd('#play'),
      hwbr: rd('.hw.br'), knob: rd('#viewToggle'), volknob: rd('#volKnob'),
      led: rd('.hw.br .led'), fav: rd('#fav'), ttl: rd('.ttl-row'), seek: rd('.seek'),
      sheet: rd('#sheet'), tabs: rd('#sheetTabs'), settings: rd('#settingsPane'), cards: rd('.stat-cards'), card1: rd('.stat-card'), group: rd('.set-group')
    });
  }, 1800);

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:rgba(0,0,0,.82);' +
    'color:#5f5;font:10px/1.35 monospace;padding:4px 6px;white-space:pre;pointer-events:none';
  document.body.appendChild(box);
  setInterval(() => {
    const vv = window.visualViewport || {};
    const st = rd('.stage') || [];
    const pl = rd('#platter') || [];
    box.textContent =
      'iw/ih ' + innerWidth + '×' + innerHeight + '  dpr ' + devicePixelRatio + '\n' +
      'doc ' + document.documentElement.clientWidth + '×' + document.documentElement.clientHeight + '\n' +
      'vv ' + Math.round(vv.width || 0) + '×' + Math.round(vv.height || 0) + ' s' + (vv.scale || 0).toFixed(2) + '\n' +
      'land ' + matchMedia('(orientation:landscape)').matches + '  play ' + !!window.__vpPlaying + '\n' +
      'stage ' + st.join(',') + '\n' +
      'platter ' + pl.join(',');
  }, 400);
}
