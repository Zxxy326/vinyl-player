/* 通用小工具 */
export const $ = (id) => document.getElementById(id);

export function fmt(s){
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

export function debounce(fn, ms){
  let id = 0;
  return function(){
    const args = arguments;
    clearTimeout(id);
    id = setTimeout(() => fn.apply(null, args), ms);
  };
}

export function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
export function hasCJK(s){ return CJK.test(s || ''); }

/* 文件名 → {artist, title}：支持 "01 - Artist - Title"、"Artist - Title"、"Title" */
export function guessMeta(name){
  let s = String(name || '').replace(/\.[^.]+$/, '');
  s = s.replace(/^\s*\d{1,3}[.\-_ )]+/, '');
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 2){
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: s.trim() };
}
