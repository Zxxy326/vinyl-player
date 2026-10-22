/* LRC 解析 + 双语配对
   支持：[mm:ss.xx] / [mm:ss:xx] / 一行多时间戳 / [offset:±ms] / 元数据标签
   双语：同一时间戳（±80ms）的相邻两行，一行含中日韩字符、一行不含 → 配对成 en/cn */
import { hasCJK } from '../core/util.js';

const TAG = /\[([a-zA-Z#]+):([^\]]*)\]/g;
const TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function toSec(m, s, f){
  let ms = 0;
  if (f != null){
    ms = f.length === 1 ? +f * 100 : f.length === 2 ? +f * 10 : +f;
  }
  return (+m) * 60 + (+s) + ms / 1000;
}

export function parseLrc(text){
  if (!text) return [];
  const out = [];
  let offset = 0;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  // 先扫一遍 offset
  for (const line of lines){
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(line))){
      if (m[1].toLowerCase() === 'offset'){
        const v = parseInt(m[2], 10);
        if (!isNaN(v)) offset = v / 1000;
      }
    }
  }

  for (const raw of lines){
    TIME.lastIndex = 0;
    const times = [];
    let m;
    while ((m = TIME.exec(raw))){
      times.push(toSec(m[1], m[2], m[3]));
    }
    if (!times.length) continue;

    // 去掉所有 [..] 标签，剩下的就是正文
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!body) continue;

    for (const t of times){
      out.push({ t: Math.max(0, t - offset), text: body });
    }
  }

  out.sort((a, b) => a.t - b.t);

  // 同时间戳去重（保留第一条）
  const dedup = [];
  for (const e of out){
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.t - e.t) < 0.005 && prev.text === e.text) continue;
    dedup.push(e);
  }
  return dedup;
}

/* 纯文本歌词（无时间戳）→ 平均分配时间轴 */
export function plainLyrics(text, duration){
  // 只按 \r\n 拆不够：ID3 的 USLT 帧里常见的是单独的 \r（老 Mac 换行）
  const rows = String(text || '').split(/\r\n?|\n/).map(s => s.trim()).filter(Boolean);
  if (!rows.length) return [];
  const dur = duration && duration > 4 ? duration : rows.length * 4;
  const start = Math.min(4, dur * .08);
  const span = Math.max(1, dur - start - 2);
  return rows.map((text, i) => ({ t: start + span * (i / rows.length), text }));
}

/* entries → 渲染行 {t, en, cn} */
export function buildLines(entries){
  if (!entries || !entries.length) return [];
  const groups = [];
  for (const e of entries){
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.t - e.t) <= 0.08) last.items.push(e);
    else groups.push({ t: e.t, items: [e] });
  }

  const lines = [];
  for (const g of groups){
    if (g.items.length === 1){
      const text = g.items[0].text;
      // 中文单语：放主行（大号衬线，中文回退到宋体），不占副行
      lines.push({ t: g.t, en: text, cn: '' });
      continue;
    }
    // 多行同时间戳：挑一条拉丁的当 en，一条 CJK 的当 cn
    let en = '', cn = '';
    for (const it of g.items){
      const cjk = hasCJK(it.text);
      if (cjk && !cn) cn = it.text;
      else if (!cjk && !en) en = it.text;
      else if (!cn) cn = it.text;
      else if (!en) en = it.text;
    }
    if (!en && cn){ en = cn; cn = ''; }
    lines.push({ t: g.t, en, cn });
  }
  return lines;
}

export function lrcToLines(text, duration){
  const entries = parseLrc(text);
  if (entries.length) return buildLines(entries);
  const plain = plainLyrics(text, duration);
  return plain.length ? buildLines(plain) : [];
}
