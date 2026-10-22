/* 音频质量分级与曲库统计聚合
   分级口径：
     Hi-Res  —— 无损且（位深 > 16 或 采样率 > 48kHz）
     SQ      —— 无损、CD 级（16bit / 44.1–48kHz）
     HQ      —— 有损但码率 >= 256kbps
     其他    —— 其余（低码率有损、未知格式）

   M4A 既可能是 AAC 也可能装 ALAC，光看扩展名分不出来，所以用
   「位深 > 0」或「每秒字节数」兜底判断。 */

export const LOSSLESS = new Set([
  'FLAC', 'WAV', 'AIFF', 'AIF', 'ALAC', 'APE', 'WV', 'TAK', 'TTA',
  'DSF', 'DFF', 'CAF', 'WAVE'
]);

export const LOSSY = new Set([
  'MP3', 'AAC', 'M4A', 'OGG', 'OGA', 'OPUS', 'WMA', 'MPC', 'MP2', 'MP1', 'AC3', 'MKA'
]);

export const LEVELS = [
  { key: 'hires', name: 'Hi-Res', desc: '24bit / 96kHz 以上', color: '#e3b341' },
  { key: 'sq',    name: 'SQ',     desc: '无损 CD 级',        color: '#4caf7d' },
  { key: 'hq',    name: 'HQ',     desc: '有损 256kbps+',     color: '#5b8def' },
  { key: 'other', name: '其他',   desc: '低码率 / 未知',      color: '#8b8b8b' }
];

function bytesPerSec(t){
  const d = t.duration || 0;
  const s = t.size || 0;
  return d > 0 && s > 0 ? s / d : 0;
}

export function isLossless(t){
  const f = (t.format || '').toUpperCase();
  if (LOSSLESS.has(f)) return true;
  if (t.bitDepth > 0) return true;
  // M4A / CAF 这类容器：每秒 > 90KB（约 720kbps）基本只能是无损
  if (f === 'M4A' || f === 'CAF') return bytesPerSec(t) > 90000;
  return false;
}

export function qualityOf(t){
  const sr = t.sampleRate | 0;
  const bd = t.bitDepth | 0;
  const br = t.bitrate | 0;

  if (isLossless(t)){
    return (bd > 16 || sr > 48000) ? 'hires' : 'sq';
  }
  return br >= 256 ? 'hq' : 'other';
}

export function levelInfo(key){
  return LEVELS.find(l => l.key === key) || LEVELS[3];
}

export function fmtBytes(n){
  n = n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtDuration(sec){
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分 ' + (sec % 60) + ' 秒';
  return sec + ' 秒';
}

/* 曲库总览：数量、总大小、总时长、按质量/格式的分布 */
export function libraryStats(tracks){
  const list = tracks || [];
  const byLevel = {};
  LEVELS.forEach(l => { byLevel[l.key] = { count: 0, size: 0, duration: 0 }; });
  const byFormat = {};
  let size = 0, duration = 0;

  for (const t of list){
    const s = t.size || 0;
    const d = t.duration || 0;
    size += s;
    duration += d;

    const lv = qualityOf(t);
    byLevel[lv].count++;
    byLevel[lv].size += s;
    byLevel[lv].duration += d;

    const f = (t.format || '未知').toUpperCase();
    if (!byFormat[f]) byFormat[f] = { count: 0, size: 0 };
    byFormat[f].count++;
    byFormat[f].size += s;
  }

  const formats = Object.keys(byFormat)
    .map(k => ({ format: k, count: byFormat[k].count, size: byFormat[k].size }))
    .sort((a, b) => b.size - a.size || b.count - a.count);

  return {
    count: list.length,
    size,
    duration,
    byLevel,
    formats,
    // 覆盖率：有多少首能判出质量等级（用于提示「有 N 首信息不全」）
    unknown: byLevel.other.count
  };
}

/* 专辑 / 艺术家分组 */
export function groupBy(tracks, keyFn){
  const map = new Map();
  for (const t of tracks){
    const k = keyFn(t) || '';
    if (!map.has(k)) map.set(k, { name: k, tracks: [], size: 0, duration: 0 });
    const g = map.get(k);
    g.tracks.push(t);
    g.size += t.size || 0;
    g.duration += t.duration || 0;
  }
  return Array.from(map.values());
}
