/* 全局状态 + 偏好持久化（localStorage，三端通用） */
const KEY = 'vinyl-player/v2';

export const S = {
  tracks: [],
  index: -1,
  playing: false,
  t: 0,
  duration: 0,
  volume: .72,
  shuffle: false,
  repeat: 'all',      // 'all' | 'one' | 'off'
  view: 'lyrics',     // 'lyrics' | 'visual'
  source: 'demo',     // 'demo' | 'library'
  scrubbing: false,
  perfLow: false,
  folder: '',         // 桌面端上次的目录
  keepOn: false,      // 安卓：保持屏幕常亮
  hideBar: false      // 安卓：隐藏顶部状态栏
};

let prefs = { volume: .72, shuffle: false, repeat: 'all', view: 'lyrics', folder: '', resume: {}, playlists: [], keepOn: false, hideBar: false };

export function loadPrefs(){
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) prefs = Object.assign(prefs, JSON.parse(raw));
  } catch (_) {}
  S.volume = typeof prefs.volume === 'number' ? prefs.volume : .72;
  S.shuffle = !!prefs.shuffle;
  S.repeat = prefs.repeat === 'one' || prefs.repeat === 'off' ? prefs.repeat : 'all';
  S.view = prefs.view === 'visual' ? 'visual' : 'lyrics';
  S.folder = prefs.folder || '';
  S.keepOn = !!prefs.keepOn;
  S.hideBar = !!prefs.hideBar;
  return prefs;
}

export function savePrefs(){
  prefs.volume = S.volume;
  prefs.shuffle = S.shuffle;
  prefs.repeat = S.repeat;
  prefs.view = S.view;
  prefs.folder = S.folder;
  prefs.keepOn = !!S.keepOn;
  prefs.hideBar = !!S.hideBar;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
}

/* 断点续播：每首歌记一个位置，另外记「上次在听哪首」 */
export function saveResume(id, t){
  if (!id) return;
  prefs.resume = prefs.resume || {};
  prefs.resume[id] = Math.max(0, Math.round(t || 0));
  prefs.lastId = id;
  const ids = Object.keys(prefs.resume);
  if (ids.length > 400){ delete prefs.resume[ids[0]]; }
  savePrefs();
}

export function getResume(id){
  if (!id || !prefs.resume) return 0;
  return prefs.resume[id] || 0;
}

export function getLastId(){ return prefs.lastId || ''; }

/* ---------------- 歌单 ---------------- */

function normPlaylists(){
  if (!Array.isArray(prefs.playlists)) prefs.playlists = [];
  prefs.playlists = prefs.playlists.filter(p => p && typeof p === 'object' && Array.isArray(p.ids));
  return prefs.playlists;
}

export function getPlaylists(){
  return normPlaylists().map(p => ({ id: p.id, name: p.name, ids: p.ids.slice(), at: p.at || 0 }));
}

export function createPlaylist(name){
  const list = normPlaylists();
  const id = 'pl:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  list.push({ id, name: (name || '新建歌单').trim().slice(0, 40) || '新建歌单', ids: [], at: Date.now() });
  savePrefs();
  return id;
}

export function deletePlaylist(id){
  prefs.playlists = normPlaylists().filter(p => p.id !== id);
  savePrefs();
}

export function renamePlaylist(id, name){
  const p = normPlaylists().find(x => x.id === id);
  if (!p) return;
  p.name = (name || '').trim().slice(0, 40) || p.name;
  savePrefs();
}

export function addToPlaylist(id, trackId){
  const p = normPlaylists().find(x => x.id === id);
  if (!p || !trackId) return false;
  if (p.ids.includes(trackId)) return false;
  p.ids.push(trackId);
  p.at = Date.now();
  savePrefs();
  return true;
}

export function removeFromPlaylist(id, trackId){
  const p = normPlaylists().find(x => x.id === id);
  if (!p) return;
  p.ids = p.ids.filter(x => x !== trackId);
  savePrefs();
}

/* ---------------- 收藏：固定一个「收藏」歌单 ---------------- */
const FAV_ID = 'pl:fav';

function ensureFav(){
  const list = normPlaylists();
  let p = list.find(x => x.id === FAV_ID);
  if (!p){
    p = { id: FAV_ID, name: '收藏', ids: [], at: Date.now() };
    list.unshift(p);
    savePrefs();
  }
  return p;
}

/** 首次启动就把「收藏」歌单建出来，歌单页里始终能看到它 */
export function ensureFavorites(){
  ensureFav();
}

export function isFavorite(trackId){
  if (!trackId) return false;
  const p = normPlaylists().find(x => x.id === FAV_ID);
  return !!(p && p.ids.indexOf(trackId) >= 0);
}

/** 返回 true 表示操作后处于「已收藏」 */
export function toggleFavorite(trackId){
  if (!trackId) return false;
  const p = ensureFav();
  const i = p.ids.indexOf(trackId);
  if (i >= 0) p.ids.splice(i, 1);
  else p.ids.push(trackId);
  p.at = Date.now();
  savePrefs();
  return i < 0;
}
