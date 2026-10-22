/* 零依赖打包：把 src/ 下的模块按拓扑序拼成一个 <script>，CSS 全部内联，
   产出一个自包含的 index.html（保住「双击即开、零依赖」这个卖点）。

   约束（写代码时要遵守）：
   - import 必须写成单行 `import { a, b } from './x.js';`
   - export 只能是 `export const|let|function|class|async function`
   - 各模块的顶层标识符不能重名（拼完在同一个作用域里） */
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const STYLES = [
  'styles/base.css',
  'styles/deck.css',
  'styles/panel.css',
  'styles/app.css'
];

/* 拓扑序：被依赖的在前 */
const MODULES = [
  'core/util.js',
  'core/store.js',
  'core/bridge.js',
  'core/quality.js',
  'core/stats.js',
  'data/demo.js',
  'lyrics/lrc.js',
  'audio/backend.js',
  'audio/webaudio.js',
  'audio/media3.js',
  'core/platform.js',
  'ui/disc.js',
  'ui/lyricsView.js',
  'ui/spectrum.js',
  'ui/transport.js',
  'ui/library.js',
  'ui/perf.js',
  'main.js'
];

const IMPORT_RE = /^[ \t]*import\s[^\n]*?;[ \t]*$/gm;
const EXPORT_RE = /^export\s+(const|let|var|function|class|async\s+function)/gm;

async function read(rel){
  return readFile(path.join(SRC, rel), 'utf8');
}

function strip(code, rel){
  const before = code;
  code = code.replace(IMPORT_RE, '');
  code = code.replace(EXPORT_RE, '$1');
  if (/\bexport\b/.test(code)){
    const line = code.split('\n').findIndex(l => /\bexport\b/.test(l)) + 1;
    throw new Error(`${rel}:${line} 还有没被处理的 export，请改成 export const/function/class`);
  }
  if (code === before) return code;
  return code;
}

/* 顶层重复声明检查：同一作用域下 const/let/class/function 重名会直接报错 */
function checkDuplicates(chunks){
  const seen = new Map();
  const re = /^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  for (const { rel, code } of chunks){
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(code))){
      const name = m[1];
      // 函数体内的局部声明不会出现在行首，这里只抓顶层
      if (seen.has(name)){
        console.warn(`  ! 顶层重名: ${name}  (${seen.get(name)} 与 ${rel})`);
      } else {
        seen.set(name, rel);
      }
    }
  }
}

async function main(){
  const t0 = Date.now();

  const cssParts = [];
  for (const s of STYLES){
    const css = await read(s);
    cssParts.push(`/* ${s} */\n${css}`);
  }

  const chunks = [];
  for (const m of MODULES){
    const code = strip(await read(m), m);
    chunks.push({ rel: m, code });
  }
  checkDuplicates(chunks);

  const js = chunks.map(c => `/* ---- ${c.rel} ---- */\n${c.code.trim()}\n`).join('\n');

  let html = await read('index.html');
  if (!html.includes('/*__STYLES__*/') || !html.includes('/*__SCRIPT__*/')){
    throw new Error('src/index.html 缺少 /*__STYLES__*/ 或 /*__SCRIPT__*/ 占位');
  }
  html = html.replace('/*__STYLES__*/', cssParts.join('\n\n'));
  html = html.replace('/*__SCRIPT__*/', js);

  const out = path.join(ROOT, 'index.html');
  await writeFile(out, html, 'utf8');

  // Tauri 的 frontendDist：同一份产物 + 演示音频
  const dist = path.join(ROOT, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), html, 'utf8');
  await cp(path.join(ROOT, 'assets'), path.join(dist, 'assets'), { recursive: true });

  // 安卓壳直接吃同一份产物
  const androidAssets = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'web');
  try {
    await rm(androidAssets, { recursive: true, force: true });
    await mkdir(androidAssets, { recursive: true });
    await cp(dist, androidAssets, { recursive: true });
  } catch (_) {}

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`✓ index.html + dist/  ${kb} KB  (${MODULES.length} modules, ${STYLES.length} stylesheets, ${Date.now() - t0}ms)`);
}

main().catch((e) => {
  console.error('✗ 构建失败:', e.message);
  process.exit(1);
});
