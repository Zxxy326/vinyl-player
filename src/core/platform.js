/* 平台适配层：三端只在这里分叉，UI 层不感知平台 */
import { guessMeta } from '../core/util.js';
import { HAS_ANDROID, acall, acallJSON } from './bridge.js';

export const HAS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
export const IS_ANDROID = HAS_ANDROID || (HAS_TAURI && /android/i.test(navigator.userAgent || ''));
export const IS_DESKTOP = HAS_TAURI && !IS_ANDROID;
export const IS_WEB = !HAS_TAURI && !HAS_ANDROID;

export function invoke(cmd, args){
  return window.__TAURI__.core.invoke(cmd, args || {});
}
export function pinvoke(cmd, args){
  return window.__TAURI__.core.invoke('plugin:player|' + cmd, args || {});
}
export function convertFileSrc(p){
  try { return window.__TAURI__.core.convertFileSrc(p); } catch (_) { return p; }
}
export function listen(ev, cb){
  if (!HAS_TAURI) return Promise.resolve(() => {});
  return window.__TAURI__.event.listen(ev, (e) => cb(e.payload));
}

const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac', 'ape', 'dsf', 'dff', 'mp2', 'caf'];
export function extOf(name){
  const m = /\.([^.\\/]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/* ---------------- Web：目录选择（File System Access 的降级路径） ---------------- */
function pickDirectoryWeb(){
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.webkitdirectory = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const files = Array.from(inp.files || []);
      inp.remove();
      resolve(files);
    }, { once: true });
    inp.click();
  });
}

function probeDuration(src){
  return new Promise((resolve) => {
    const a = new Audio();
    let done = false;
    const finish = (v) => { if (done) return; done = true; a.src = ''; resolve(v); };
    const timer = setTimeout(() => finish(0), 4000);
    a.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      finish(isFinite(a.duration) ? a.duration : 0);
    }, { once: true });
    a.addEventListener('error', () => { clearTimeout(timer); finish(0); }, { once: true });
    a.preload = 'metadata';
    a.src = src;
  });
}

async function scanWeb(files){
  const lrcMap = new Map();
  const imgMap = new Map();
  const audio = [];

  for (const f of files){
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.replace(/[^\\/]+$/, '');
    const base = rel.replace(/\.[^.]+$/, '').toLowerCase();
    const ext = extOf(f.name);
    if (ext === 'lrc') lrcMap.set(base, f);
    else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)){
      const key = (dir + f.name.replace(/\.[^.]+$/, '')).toLowerCase();
      if (!imgMap.has(key)) imgMap.set(key, f);
      imgMap.set((dir + 'cover').toLowerCase(), f);
      imgMap.set((dir + 'folder').toLowerCase(), f);
      imgMap.set((dir + 'front').toLowerCase(), f);
    } else if (AUDIO_EXT.includes(ext)) audio.push(f);
  }

  const tracks = [];
  for (let i = 0; i < audio.length; i++){
    const f = audio[i];
    const rel = f.webkitRelativePath || f.name;
    const base = rel.replace(/\.[^.]+$/, '').toLowerCase();
    const g = guessMeta(f.name);
    const src = URL.createObjectURL(f);
    const dur = await probeDuration(src);
    const lrcFile = lrcMap.get(base);
    const img = imgMap.get(base) || imgMap.get((rel.replace(/[^\\/]+$/, '') + 'cover').toLowerCase());
    tracks.push({
      id: 'web:' + rel,
      title: g.title || f.name,
      artist: g.artist || '未知艺人',
      album: rel.replace(/[^\\/]+$/, '').replace(/[\\/]$/, '') || '',
      duration: dur,
      src,
      format: extOf(f.name).toUpperCase(),
      playable: true,
      lrc: lrcFile ? await lrcFile.text() : '',
      artUrl: img ? URL.createObjectURL(img) : ''
    });
  }
  return tracks;
}

/* ---------------- 桌面：Rust 扫描 ---------------- */
async function scanDesktop(dir){
  const res = await invoke('scan_library', { dir });
  const tracks = (res.tracks || []).map(t => Object.assign({}, t, {
    id: 'file:' + t.path,
    src: '',
    artUrl: ''
  }));
  return { dir: res.dir || dir, tracks };
}

/* ---------------- 安卓：MediaStore（原生桥） ---------------- */
async function scanAndroid(){
  let list = null;
  if (HAS_ANDROID){
    try {
      list = acallJSON('library');
    } catch (e){
      console.log('[vinyl] library() 调用失败: ' + (e && e.message));
      list = null;
    }
    console.log('[vinyl] library() 返回 ' + (Array.isArray(list) ? list.length : 'null') + ' 首');
  }
  else {
    try { list = await pinvoke('library'); } catch (_) { list = null; }
  }
  return (list || []).map(t => Object.assign({}, t, {
    id: 'media:' + t.uri,
    src: t.uri
  }));
}

/* ---------------- 对外接口 ---------------- */
export async function pickLibrary(){
  if (IS_DESKTOP){
    const res = await invoke('pick_and_scan');
    if (!res || !res.tracks) return null;
    return { dir: res.dir, tracks: res.tracks.map(t => Object.assign({}, t, { id: 'file:' + t.path, src: '' })) };
  }
  if (IS_ANDROID){
    return { dir: '', tracks: await scanAndroid() };
  }
  const files = await pickDirectoryWeb();
  if (!files.length) return null;
  return { dir: '', tracks: await scanWeb(files) };
}

export async function rescan(dir){
  if (IS_DESKTOP && dir){
    const r = await scanDesktop(dir);
    return { dir: r.dir, tracks: r.tracks };
  }
  if (IS_ANDROID) return { dir: '', tracks: await scanAndroid() };
  return null;
}

/* 播放前把 track.src 准备好（桌面可能需要转码） */
export async function resolvePlayable(track){
  if (IS_DESKTOP){
    const r = await invoke('prepare_playback', { path: track.path });
    if (!r || r.error) throw new Error(r && r.error ? r.error : '无法播放');
    track.src = convertFileSrc(r.path);
    track.transcoded = !!r.transcoded;
    if (r.duration) track.duration = r.duration;
    return track;
  }
  if (IS_ANDROID) return track;
  return track;
}

export async function loadLyrics(track){
  if (track.lrc) return track.lrc;
  if (IS_DESKTOP && track.path){
    try { return await invoke('read_lyrics', { path: track.path }) || ''; } catch (_) { return ''; }
  }
  if (IS_ANDROID){
    if (HAS_ANDROID) return acall('lyrics', { uri: track.uri || '' }) || '';
    try { return await pinvoke('lyrics', { uri: track.uri || '' }) || ''; } catch (_) { return ''; }
  }
  return '';
}

export function importLyrics(track){
  if (!IS_ANDROID) return Promise.resolve('');
  return new Promise((resolve) => {
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      window.__onLyrics = null;
      const t = text || '';
      if (t){
        track.lrc = t;
        try {
          const map = JSON.parse(localStorage.getItem('vinyl-player/lrc') || '{}');
          map[track.id] = t;
          localStorage.setItem('vinyl-player/lrc', JSON.stringify(map));
        } catch (_) {}
      }
      resolve(t);
    };
    window.__onLyrics = finish;
    if (HAS_ANDROID) acall('pickLyrics');
    else pinvoke('pick_lyrics').then((t) => finish(t || '')).catch(() => finish(''));
    setTimeout(() => finish(''), 180000);
  });
}

export function restoreImportedLyrics(track){
  try {
    const map = JSON.parse(localStorage.getItem('vinyl-player/lrc') || '{}');
    if (map[track.id]) track.lrc = map[track.id];
  } catch (_) {}
  return track;
}

/* 当前歌词行推给原生（通知栏 / 锁屏副标题）。只有安卓原生壳有这条路。 */
export function setNowLyric(text){
  if (!IS_ANDROID || !HAS_ANDROID) return;
  try { acall('lyric', { text: text || '' }); } catch (_) {}
}

export async function loadCover(track){
  if (track.artUrl) return track.artUrl;
  try {
    if (IS_DESKTOP && track.path){
      const b64 = await invoke('read_cover', { path: track.path });
      if (b64) return 'data:image/jpeg;base64,' + b64;
    } else if (IS_ANDROID){
      // 安卓：原生侧先掏内嵌图片，没有再退回专辑封面
      const args = { albumId: track.albumId == null ? '' : String(track.albumId), uri: track.uri || '' };
      const raw = HAS_ANDROID ? acall('cover', args) : await pinvoke('cover', args);
      if (raw){
        // 安卓返回 {mime, data}：MIME 必须照抄，封面可能是 PNG / WebP
        if (typeof raw === 'string' && raw.charAt(0) === '{'){
          try {
            const o = JSON.parse(raw);
            if (o && o.data) return 'data:' + (o.mime || 'image/jpeg') + ';base64,' + o.data;
          } catch (_) {}
        }
        return 'data:image/jpeg;base64,' + raw;
      }
    }
  } catch (_) {}
  return '';
}
