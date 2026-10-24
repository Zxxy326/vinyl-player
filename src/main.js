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
    onSetting: (key) => doSetting(key)
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
    hideBar: S.hideBar
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

/* 设置页自己缓存了一份状态，改完要同步过去再重绘，否则界面还显示旧值 */
function refreshSettings(){
  library.view = S.view;
  library.volume = S.volume;
  library.keepOn = S.keepOn;
  library.hideBar = S.hideBar;
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
   =========
   这里踩过三个坑，结论写在最前面：
     ① Windows 的窗口尺寸只有终态 —— setFullscreen / setSize 都是"一帧换掉"；
     ② WebView2 在窗口尺寸变化的那些帧里要重建渲染表面，正在跑的 CSS 过渡会被
        直接丢弃（CDP 里 opacity 0→1 跑得好好的，真机录屏逐帧看一帧都没有）；
     ③ 重排也晚一两帧，于是窗口先变大、内容后长满，中间那半秒画面是空的。
   只要"过渡"和"resize"在时间上重叠，①②③ 就会同时发作 —— 这就是前几版
   怎么调都生硬的根本原因，不是参数问题。

   所以这一版把两件事**在时间上彻底拆开**：
     ① 先把画布钉成当前尺寸居中，围边压成深色 —— 这一帧画面完全没变；
     ② 窗口一帧跳到全屏。此刻屏幕上是"原尺寸的播放器 + 深色围边"，
        读起来是"应用接管了屏幕"，而不是"窗口突然变大"；
     ③ 窗口从此不再变化，纯在页面里把画布从原尺寸长到全屏，唱片同步插值。
   ③ 期间一次 resize 都没有，CSS 过渡不会被丢弃，也没有重排要追 ——
   顺滑是这个结构本身保证的，不靠调参。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* 双 rAF = 等这一帧真的画出来再往下走 */
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (_) { return false; } };
/* 画布尺寸、唱片直径、围边统一用这一条曲线，才是"一起展开"而不是各走各的。
   这条曲线的 JS 版本在下面 bezier() 里，两边必须是同一组控制点。 */
const IMM_EASE = 'cubic-bezier(.22,.61,.36,1)';
const IMM_PTS = [0.22, 0.61, 0.36, 1];

function readDisc(){
  const p = document.querySelector('.platter');
  return p ? p.getBoundingClientRect().width : 0;
}

/* 桌面端 --disc 只有两档系数（见 app.css）：
   1001–1240 宽用 70vh/38vw，其余用 74vh/41vw。
   过渡期间画布尺寸和视口脱钩了（视口已经是全屏的），所以终点直径要自己算。
   **改了 CSS 断点记得同步这里。** */
function discFor(w, h){
  const narrow = w >= 1001 && w <= 1240;
  const kh = narrow ? 70 : 74, kw = narrow ? 38 : 41;
  return Math.min(kh * h / 100, kw * w / 100);
}

/* 同一条贝塞尔曲线的 JS 版本（IMM_EASE = cubic-bezier(.22,.61,.36,1)）。
   为什么要自己算：画布尺寸和唱片直径必须用**同一个 p**，否则两者会各走各的。
   上一版让 CSS 过渡推尺寸、JS 每帧 getBoundingClientRect() 去量进度，
   量一次就是一次强制同步重排 —— 和过渡自身的重排叠在同一帧里，
   实测把这段过渡的帧数直接砍到 13 帧/560ms（约 20fps），看着就是台阶。
   现在两边都由 JS 逐帧写，一帧只重排一次，且严格同步。 */
function bezier(x1, y1, x2, y2){
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const fy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++){
      const e = fx(t) - x;
      if (Math.abs(e) < 1e-4) return fy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 20; i++){
      const e = fx(t);
      if (Math.abs(e - x) < 1e-4) break;
      if (e < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return fy(t);
  };
}
const IMM_BEZ = bezier(...IMM_PTS);

/* 把画布从 from 长到 to，唱片直径同步从 d0 插到 d1。
   --disc 只被 .platter 消费，所以钉在 .platter 上而不是 .deck 上：
   挂在 .deck 会让整个 deck 子树每帧重算样式，实测帧数明显更低。 */
async function growStage(st, from, to, d0, d1, dur){
  const pl = document.querySelector('.platter');
  if (!st) return;
  const set = (p) => {
    st.style.width = (from.w + (to.w - from.w) * p) + 'px';
    st.style.height = (from.h + (to.h - from.h) * p) + 'px';
    if (pl) pl.style.setProperty('--disc', (d0 + (d1 - d0) * p) + 'px');
  };
  if (!dur){ set(1); return; }
  set(0);
  const t0 = performance.now();
  await new Promise((res) => {
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      set(IMM_BEZ(t));
      if (t < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

let __immFrames = 0, __immT0 = 0;   // 诊断：过渡实际出了多少帧
let immersiveBusy = false;
let stagePrev = null;   // 进沉浸前的视口尺寸，退出时缩回去

/* 把 .stage 钉成指定 px 尺寸并居中。
   必须用 px：过渡期间视口已经是全屏的，vh/vw 给的是全屏尺寸，钉不住。 */
function pinStage(w, h, disc){
  const st = document.querySelector('.stage');
  if (!st) return null;
  const pl = document.querySelector('.platter');
  st.style.transition = 'none';
  st.style.position = 'fixed';
  st.style.left = '50%'; st.style.top = '50%';
  st.style.right = 'auto'; st.style.bottom = 'auto';
  st.style.width = w + 'px'; st.style.height = h + 'px';
  st.style.transform = 'translate(-50%,-50%)';
  if (pl && disc > 0) pl.style.setProperty('--disc', disc + 'px');
  void st.offsetWidth;
  return st;
}

function unpinStage(st){
  if (!st) return;
  const pl = document.querySelector('.platter');
  st.style.transition = '';
  st.style.position = '';
  st.style.left = ''; st.style.top = '';
  st.style.right = ''; st.style.bottom = '';
  st.style.width = ''; st.style.height = '';
  st.style.transform = '';
  if (pl) pl.style.removeProperty('--disc');
}

/* 深色围边：画布之外那一圈。它只在"画布还没铺满"的时候露出来，
   所以只要它是深色，就不会出现"红底先铺满"的割裂感。
   这一层只动 opacity，而且只在窗口**不变化**的时候开关，所以不会被 resize 打断。 */
function backdropSet(v){
  const el = $('bgDim');
  if (!el) return null;
  el.style.transition = 'none';
  el.style.opacity = String(v);
  void el.offsetWidth;
  return el;
}

/* 跳全屏之后 WebView2 不一定在同一帧就把 innerWidth 更新掉，等它一下 */
async function viewportChanged(w0, h0){
  for (let i = 0; i < 20; i++){
    await new Promise((r) => requestAnimationFrame(r));
    if (innerWidth !== w0 || innerHeight !== h0){ await frame(); return; }
  }
}

async function enterImmersive(dur){
  stagePrev = { w: innerWidth, h: innerHeight };
  const disc0 = readDisc();
  const st = pinStage(stagePrev.w, stagePrev.h, disc0);
  backdropSet(1);          // 画布此刻还铺满整个窗口，这一下完全看不见
  await frame();           // 让"钉住"这一帧先上屏，再去跳窗口

  const w0 = innerWidth, h0 = innerHeight;
  await invoke('set_fullscreen', { on: true }).catch(() => {});
  await viewportChanged(w0, h0);
  /* 再多等两帧：全屏有时分两趟把窗口撑开，第二趟如果落在过渡开始之后，
     过渡会被那次 resize 打断。40ms 看不出来，但能挡掉这一趟。 */
  await wait(40);

  const tw = innerWidth, th = innerHeight;
  const disc1 = discFor(tw, th);
  /* 标题栏淡出、安全区让位。放在跳全屏之后：这点位移和"接管屏幕"同一帧，
     看不出来；放在之前反而会在窗口还没变大时先跳一下。 */
  document.body.classList.add('immersive');
  void st && st.offsetWidth;

  /* 数一下这段过渡实际画了多少帧。这个数直接决定观感：
     帧数太少再好的缓动也是台阶，写进日志方便以后排查。 */
  __immFrames = 0; __immT0 = performance.now();
  (function tick(){ __immFrames++; if (performance.now() - __immT0 < dur + 80) requestAnimationFrame(tick); })();

  await Promise.all([
    growStage(st, { w: stagePrev.w, h: stagePrev.h }, { w: tw, h: th }, disc0, disc1, dur)
  ]);
  unpinStage(st);
  backdropSet(0);          // 画布已经铺满，这一下也看不见
  logBoot('imm: enter ' + __immFrames + 'f/' + Math.round(performance.now() - __immT0) + 'ms');
}

async function exitImmersive(dur){
  const back = stagePrev || { w: innerWidth, h: innerHeight };
  const fw = innerWidth;
  const disc0 = readDisc();
  const disc1 = discFor(back.w, back.h);
  const st = pinStage(innerWidth, innerHeight, disc0);   // 钉成当前全屏尺寸，画面不变
  backdropSet(1);                                        // 围边深色，此刻还看不见
  await frame();

  await growStage(st, { w: fw, h: innerHeight }, { w: back.w, h: back.h }, disc0, disc1, dur);

  const w0 = innerWidth, h0 = innerHeight;
  await invoke('set_fullscreen', { on: false }).catch(() => {});
  await viewportChanged(w0, h0);

  document.body.classList.remove('immersive');   // 标题栏在正常窗口尺寸下才淡回来
  unpinStage(st);
  backdropSet(0);
  stagePrev = null;
}

async function setImmersive(on){
  // 过渡期间忽略重复触发，否则快速连点会把两次窗口切换叠在一起
  if (on === immersive || immersiveBusy) return;
  immersiveBusy = true;
  const soft = IS_DESKTOP && TAURI_WIN;   // 只有要换原生窗口的这一端才需要这套
  const dur = reduceMotion() ? 0 : 560;
  try {
    immersive = on;
    const b = $('immersiveBtn');
    if (b) b.setAttribute('aria-pressed', String(on));

    if (on){
      if (soft){
        await enterImmersive(dur);
      } else {
        document.body.classList.toggle('immersive', true);
        if (IS_ANDROID && HAS_ANDROID){
          try { acall('hideStatusBar', { on: true }); } catch (_) {}
        } else if (document.documentElement.requestFullscreen){
          try { await document.documentElement.requestFullscreen(); } catch (_) {}
        }
      }
      await keepAwake(true);
      showCtrlBar();
      // 手机上没有键盘，别提示快捷键
      toast(IS_ANDROID || matchMedia('(hover:none)').matches
        ? '沉浸播放 · 再点一次退出'
        : '沉浸播放 · 按 F 或 Esc 退出');
    } else {
      if (soft){
        await exitImmersive(dur);
      } else {
        if (IS_ANDROID && HAS_ANDROID){
          try { acall('hideStatusBar', { on: !!S.hideBar }); } catch (_) {}
        } else if (document.fullscreenElement && document.exitFullscreen){
          try { await document.exitFullscreen(); } catch (_) {}
        }
      }
      document.body.classList.toggle('immersive', false);
      await keepAwake(false);
      clearTimeout(ctrlTimer);
      document.body.classList.remove('ctrl-hidden');
    }
  } catch (err){
    /* 中途出岔子（命令失败、被系统打断）：把画布和围边还原，
       别把界面留在"钉住一半"的状态里。 */
    logBoot('imm: failed ' + ((err && err.message) || err));
    unpinStage(document.querySelector('.stage'));
    backdropSet(0);
  } finally {
    immersiveBusy = false;
    // 兜底：别把背景留在深色围边状态
    const el = $('bgDim');
    if (el && el.style.opacity && el.style.opacity !== '0') el.style.opacity = '0';
  }
}

if ($('immersiveBtn')) $('immersiveBtn').addEventListener('click', () => setImmersive(!immersive));
window.addEventListener('pointermove', showCtrlBar, { passive: true });
window.addEventListener('pointerdown', showCtrlBar, { passive: true });
/* 浏览器里按 Esc 会自己退全屏，状态跟着同步一下 */
document.addEventListener('fullscreenchange', () => {
  if (immersive && !document.fullscreenElement) setImmersive(false);
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
   高度只能量：视口宽高、字体、是否显示转速铭牌都会影响它。 */
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
}

/* ================= 启动 ================= */
async function boot(){
  loadPrefs();
  ensureFavorites();   // 「收藏」歌单先建出来，歌单页里始终在
  paintFav(currentTrack());
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
