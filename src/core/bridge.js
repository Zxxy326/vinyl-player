/* 安卓原生壳的 JS 桥
   Kotlin 侧通过 addJavascriptInterface 注入 window.AndroidPlayer，
   方法签名统一为 fn(String json) -> String json */
export const ANDROID = (typeof window !== 'undefined' && window.AndroidPlayer) ? window.AndroidPlayer : null;
export const HAS_ANDROID = !!ANDROID;

/* 注意：必须 ANDROID[cmd](...) 这样带着接收者调用。
   先 const fn = ANDROID[cmd] 再 fn(...) 会丢掉接收者，
   WebView 的 Java 桥在这种情况下直接返回 null（且不抛异常）。
   另外桥对象在调用时重新取一次，防止模块加载早于 addJavascriptInterface。 */
export function acall(cmd, args){
  const A = (typeof window !== 'undefined' && window.AndroidPlayer) ? window.AndroidPlayer : null;
  if (!A) return null;
  try {
    if (typeof A[cmd] !== 'function') return null;
    return A[cmd](JSON.stringify(args || {}));
  } catch (e){
    return null;
  }
}

export function acallJSON(cmd, args){
  const raw = acall(cmd, args);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
