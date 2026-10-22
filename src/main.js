/* 装配层：把后端、UI、曲库接到一起 */
import { $, clamp, debounce, esc } from './core/util.js';
import { S, loadPrefs, savePrefs, saveResume, getResume, getLastId, getPlaylists, createPlaylist, deletePlaylist, renamePlaylist, addToPlaylist, removeFromPlaylist } from './core/store.js';
import { notePlay, addSeconds, flushStats, resetStats } from './core/stats.js';
import { libraryStats, fmtBytes, fmtDuration } from './core/quality.js';
import { HAS_ANDROID, acall, acallJSON } from './core/bridge.js';
import { IS_WEB, IS_DESKTOP, IS_ANDROID, pickLibrary, rescan, resolvePlayable, loadLyrics, importLyrics, restoreImportedLyrics, loadCover, listen, invoke } from './core/platform.js';
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
      platform: IS_ANDROID ? 'android' : IS_DESKTOP ? 'desktop' : 'web',
      folder: S.folder || '',
      notifOk: notifOk
    },
    view: S.view,
    volume: S.volume
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

function paintMeta(tr){
  const pad = String(S.index + 1).padStart(2, '0');
  $('tEyebrow').textContent = tr.eyebrow || ('SIDE A · TRACK ' + pad);
  $('tTitle').textContent = tr.title || '未知曲目';
  $('tArtist').innerHTML = esc(tr.artist || '未知艺人') +
    (tr.album ? ' <em>— ' + esc(tr.album) + '</em>' : '');
  $('tCredit').innerHTML = tr.creditHtml ||
    ('本地曲库 · ' + esc(tr.format || 'AUDIO') + (tr.transcoded ? ' · 已转码' : ''));
  $('ringText').textContent = tr.ring ||
    (String(tr.title || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff ]/g, ' ') + ' · ').repeat(3);
  $('rpmLabel').textContent = (tr.format ? tr.format + ' · ' : '') + 'STEREO';
  document.title = (tr.title || 'Vinyl Player') + (tr.artist ? ' — ' + tr.artist : '') + ' · Vinyl Player';
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
    library.renderSettings();
    toast('默认视图：' + (S.view === 'visual' ? '频谱' : '歌词'));
  } else if (key === 'notif'){
    if (HAS_ANDROID) acall('openNotifSettings');
  }
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

const reflow = debounce(() => {
  lyricsView.center();
  spectrum.size();
}, 120);
window.addEventListener('resize', reflow);
window.addEventListener('orientationchange', () => setTimeout(reflow, 280));
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

/* ================= 启动 ================= */
async function boot(){
  loadPrefs();
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

  if (IS_ANDROID){
    await listen('player://position', onPositionEvent);
    await listen('player://spectrum', onSpectrumEvent);
    await listen('player://state', onStateEvent);
    await listen('player://command', onCommandEvent);
  }

  watchPerf((p90) => {
    S.perfLow = true;
    document.body.classList.add('perf-low');
    spectrum.setLow(true);
    spectrum.size();
    console.info('[vinyl] 性能降档 p90=' + p90.toFixed(1) + 'ms');
  });

  requestAnimationFrame(loop);

  if (IS_WEB){
    S.tracks = [DEMO];
    S.index = 0;
    S.source = 'demo';
    renderLib({ showLrcImport: false });
    await playIndex(0, false);
    setTimeout(() => { if (!S.playing) setPlaying(true); }, 700);
    logBoot('boot: web demo');
    return;
  }

  if (IS_DESKTOP){
    logBoot('boot: desktop, folder=' + (S.folder || '-'));
    if (S.folder){
      // 大曲库扫描要几秒，先给个占位，别让用户以为曲库丢了
      showRestoring();
      try {
        const res = await rescan(S.folder);
        if (res && res.tracks.length){
          setLibrary(res.tracks, false);
          $('empty').classList.remove('show');
          logBoot('boot: restored ' + res.tracks.length + ' tracks');
          return;
        }
        logBoot('boot: rescan empty');
      } catch (e){
        logBoot('boot: rescan failed ' + (e && e.message));
        // 目录不在了，清掉记忆，避免每次启动都白扫一遍
        S.folder = '';
        savePrefs();
      }
    }
    showEmpty();
    logBoot('boot: empty state');
    return;
  }

  showRestoring();
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
  } catch (e){
    showEmpty();
    logBoot('boot: android scan failed');
  }
}

function logBoot(msg){
  try {
    if (IS_DESKTOP) invoke('log_line', { msg: msg });
  } catch (_) {}
}

window.addEventListener('error', (e) => {
  const msg = 'JS ERROR: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0);
  logBoot(msg);
  document.title = msg;
  if (S.tracks.length === 0) toast('出错了：' + (e.message || '脚本异常'));
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

/* 诊断：访问 ?diag 时把关键盒子尺寸写进 title，便于无头浏览器取值 */
if (location.search.indexOf('diag') >= 0){
  setTimeout(() => {
    const r = (sel) => {
      const e = typeof sel === 'string' && sel[0] === '#' ? $(sel.slice(1)) : document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    document.title = JSON.stringify({
      vw: innerWidth, vh: innerHeight,
      stage: r('.stage'), deck: r('#deck'), platter: r('#platter'),
      panel: r('.panel'), lyrics: r('#lyrics'), track: r('#lyricTrack'),
      libBtn: r('#libBtn'), row: r('.row'), tf: ($('lyricTrack') || {}).style.transform || '',
      controls: r('.controls'), btns: r('.btns'), play: r('#play'),
      hwbr: r('.hw.br'), knob: r('#viewToggle'), volknob: r('#volKnob'),
      sheet: r('#sheet'), tabs: r('#sheetTabs'), settings: r('#settingsPane'), cards: r('.stat-cards'), card1: r('.stat-card'), group: r('.set-group')
    });
  }, 1800);
}
