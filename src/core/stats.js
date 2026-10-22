/* 听歌统计：播放次数、累计时长、按天/按曲记录
   存 localStorage，三端通用。数据量小（按曲目 id 索引，最多保留 2000 首）。 */

const STATS_KEY = 'vinyl-player/stats';
const MAX_TRACKS = 2000;
const MAX_DAYS = 120;

let db = null;

function load(){
  if (db) return db;
  try {
    const raw = localStorage.getItem(STATS_KEY);
    db = raw ? JSON.parse(raw) : null;
  } catch (_) { db = null; }
  if (!db || typeof db !== 'object') db = {};
  if (!db.tracks || typeof db.tracks !== 'object') db.tracks = {};
  if (!db.days || typeof db.days !== 'object') db.days = {};
  if (!db.total) db.total = { plays: 0, seconds: 0 };
  return db;
}

let saveTimer = 0;
function save(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStats, 800);
}

export function flushStats(){
  clearTimeout(saveTimer);
  if (!db) return;
  try { localStorage.setItem(STATS_KEY, JSON.stringify(db)); } catch (_) {}
}

function today(){
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function trim(){
  const ids = Object.keys(db.tracks);
  if (ids.length > MAX_TRACKS){
    ids.sort((a, b) => (db.tracks[a].at || 0) - (db.tracks[b].at || 0));
    for (const id of ids.slice(0, ids.length - MAX_TRACKS)) delete db.tracks[id];
  }
  const days = Object.keys(db.days);
  if (days.length > MAX_DAYS){
    days.sort();
    for (const d of days.slice(0, days.length - MAX_DAYS)) delete db.days[d];
  }
}

/* 开始播放一首：计一次播放。同一首 20 秒内重复触发只算一次
   （切歌来回切、单曲循环的开头重复都不该刷次数） */
const recent = new Map();

export function notePlay(track){
  if (!track || !track.id) return;
  const d = load();
  const now = Date.now();
  const last = recent.get(track.id) || 0;
  if (now - last < 20000) return;
  recent.set(track.id, now);

  const rec = d.tracks[track.id] || (d.tracks[track.id] = { n: 0, s: 0, at: 0 });
  rec.n++;
  rec.at = now;
  if (track.title) rec.t = track.title;
  if (track.artist) rec.a = track.artist;

  d.total.plays++;

  const day = today();
  const dd = d.days[day] || (d.days[day] = { plays: 0, seconds: 0 });
  dd.plays++;

  trim();
  save();
}

/* 累加实际收听秒数（由主循环每 5 秒结一次账） */
export function addSeconds(track, sec){
  if (!track || !track.id || !(sec > 0)) return;
  const d = load();
  const rec = d.tracks[track.id] || (d.tracks[track.id] = { n: 0, s: 0, at: Date.now() });
  rec.s += sec;
  d.total.seconds += sec;
  const day = today();
  const dd = d.days[day] || (d.days[day] = { plays: 0, seconds: 0 });
  dd.seconds += sec;
  save();
}

export function trackStats(id){
  const d = load();
  return d.tracks[id] || null;
}

export function allTrackStats(){
  return load().tracks;
}

export function summary(){
  const d = load();
  const todayKey = today();
  const day = d.days[todayKey] || { plays: 0, seconds: 0 };

  let weekPlays = 0, weekSeconds = 0;
  const keys = Object.keys(d.days).sort().slice(-7);
  for (const k of keys){
    weekPlays += d.days[k].plays || 0;
    weekSeconds += d.days[k].seconds || 0;
  }

  return {
    plays: d.total.plays || 0,
    seconds: d.total.seconds || 0,
    tracks: Object.keys(d.tracks).length,
    today: day,
    week: { plays: weekPlays, seconds: weekSeconds },
    days: Object.keys(d.days).length
  };
}

export function topTracks(n){
  const d = load();
  return Object.keys(d.tracks)
    .map(id => Object.assign({ id }, d.tracks[id]))
    .sort((a, b) => b.n - a.n || b.s - a.s)
    .slice(0, n || 10);
}

export function recentTracks(n){
  const d = load();
  return Object.keys(d.tracks)
    .map(id => Object.assign({ id }, d.tracks[id]))
    .filter(x => x.at)
    .sort((a, b) => b.at - a.at)
    .slice(0, n || 10);
}

export function resetStats(){
  db = { tracks: {}, days: {}, total: { plays: 0, seconds: 0 } };
  recent.clear();
  flushStats();
}
