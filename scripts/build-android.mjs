/* 构建安卓 APK：先把前端同步到 app/src/main/assets/web，再跑 Gradle。
   跨平台调用 gradlew（Windows 用 gradlew.bat）。 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');

function run(cmd, args, opts = {}){
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(process.execPath, [path.join(ROOT, 'scripts', 'build-web.mjs')]);

const isWin = process.platform === 'win32';
const gradlew = path.join(ANDROID, isWin ? 'gradlew.bat' : 'gradlew');
if (!existsSync(gradlew)){
  console.error('找不到 gradlew，先在 android/ 目录生成 Gradle wrapper');
  process.exit(1);
}

if (!process.env.JAVA_HOME){
  console.warn('提示：未设置 JAVA_HOME，需要 JDK 17 才能编译');
}
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT){
  console.warn('提示：未设置 ANDROID_HOME，需要 Android SDK 35');
}

const args = ['assembleRelease', '--no-daemon'];
if (isWin) run('cmd', ['/c', gradlew, ...args], { cwd: ANDROID });
else run(gradlew, args, { cwd: ANDROID });

console.log('\nAPK → android/app/build/outputs/apk/release/app-release.apk');
