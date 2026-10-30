import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const zipFile = path.join(rootDir, 'self-hub-chrome-extension.zip');

console.log('🚀 正在验证并打包 Chrome 扩展程序...');

// 1. 验证 manifest.json
const manifestPath = path.join(extDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('❌ 未找到 extension/manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`📦 扩展名称: ${manifest.name}`);
console.log(`🔖 版本号: ${manifest.version}`);
console.log(`🛡️ 规范: Manifest V${manifest.manifest_version}`);

// 2. 验证并确保图标存在且尺寸合规
[16, 48, 128].forEach(sz => {
  const iconPath = path.join(extDir, `icon${sz}.png`);
  if (!fs.existsSync(iconPath)) {
    console.warn(`⚠️ 图标 icon${sz}.png 缺失，正在自动生成...`);
    execSync('node scripts/gen-icons.js', { cwd: rootDir, stdio: 'inherit' });
  }
});

// 3. 将最新构建的 Vite 工作台同步内嵌到 extension/app 中
// Always rebuild: shipping a stale bundle inside the extension previously meant
// the built-in workspace kept old bugs even after src/ was fixed.
const distDir = path.join(rootDir, 'dist');
const skipBuild = process.argv.includes('--skip-build');
const distIndex = path.join(distDir, 'index.html');

let needsBuild = !skipBuild;
if (skipBuild && !fs.existsSync(distIndex)) {
  console.warn('⚠️ 指定了 --skip-build 但 dist/ 不存在，改为执行构建。');
  needsBuild = true;
}

// 2.5 版本号自增：每次完整打包（非 --skip-build）patch +1。
// chrome://extensions 列表里显示的版本号因此成为“浏览器里跑的是哪一版”的可见凭据——
// 排查“改了没生效”时，先对版本号，再谈别的。
if (!skipBuild) {
  const parts = manifest.version.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  manifest.version = parts.join('.');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`🔖 版本号自增 → ${manifest.version}`);
}

/**
 * `--skip-build` must not ship a build older than the sources.
 *
 * This is the failure that actually happened: the embedded workspace sat three batches
 * behind `src/`, because `dist/` was built earlier and nobody compared. Copying `dist` into
 * `extension/app` cannot reveal that on its own — the two agree by construction.
 */
if (!needsBuild) {
  const newest = (dir) => {
    let latest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        latest = Math.max(latest, newest(full));
      } else {
        latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    }
    return latest;
  };
  const srcTime = newest(path.join(rootDir, 'src'));
  const configTime = Math.max(
    fs.statSync(path.join(rootDir, 'package.json')).mtimeMs,
    fs.statSync(path.join(rootDir, 'vite.config.ts')).mtimeMs
  );
  const distTime = fs.statSync(distIndex).mtimeMs;
  if (distTime < Math.max(srcTime, configTime)) {
    console.error('❌ dist/ 比源码旧：--skip-build 会打包出过期的工作台。');
    console.error('   去掉 --skip-build 重新打包。');
    process.exit(1);
  }
}

if (needsBuild) {
  console.log('📦 正在编译 Self-Hub 主工作台前端（可用 --skip-build 跳过）...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
}
if (!fs.existsSync(distIndex)) {
  console.error('❌ dist/index.html 不存在，无法内嵌工作台。');
  process.exit(1);
}
const appDir = path.join(extDir, 'app');
if (fs.existsSync(appDir)) {
  fs.rmSync(appDir, { recursive: true, force: true });
}
fs.cpSync(distDir, appDir, { recursive: true });
console.log('✅ 已将 Self-Hub 主工作台成功内嵌至扩展程序 (extension/app)');

/**
 * Verify the copy instead of trusting it.
 *
 * `--skip-build` exists to save time, but it also means the package can embed whatever
 * `dist/` happened to contain — and nothing said so. That actually happened: the embedded
 * workspace sat three batches behind the source, and it was only noticed by reading the
 * chunk names. Two checks, both cheap:
 *
 *   1. the copied `index.html` must be byte-identical to `dist/index.html`;
 *   2. every script/preload/stylesheet it references must exist under `app/`.
 *
 * A broken or stale package fails here instead of shipping.
 */
const copiedIndex = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
const distIndexHtml = fs.readFileSync(distIndex, 'utf8');
const problems = [];
if (copiedIndex !== distIndexHtml) {
  problems.push('extension/app/index.html 与 dist/index.html 不一致（内嵌产物不是当前构建）');
}
const referenced = [...copiedIndex.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
for (const reference of referenced) {
  if (!fs.existsSync(path.join(appDir, reference))) {
    problems.push(`index.html 引用了不存在的文件：${reference}`);
  }
}
if (problems.length > 0) {
  console.error('\n❌ 内嵌工作台校验失败：');
  for (const problem of problems) console.error(`   · ${problem}`);
  console.error('   请重新运行 npm run package:extension（不要加 --skip-build）。');
  process.exit(1);
}
console.log(`✅ 内嵌工作台校验通过（${referenced.length} 个引用全部存在，index.html 与 dist 一致）`);

// 4. 删除旧 zip 包
if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
}

// 4. 打包 extension 目录为 zip
if (process.platform === 'win32') {
  // Use PowerShell Compress-Archive
  const psCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${extDir}\\*' -DestinationPath '${zipFile}' -Force"`;
  execSync(psCmd, { stdio: 'inherit' });
} else {
  // Unix zip
  execSync(`cd "${extDir}" && zip -r "${zipFile}" . -x "*.DS_Store"`, { stdio: 'inherit' });
}

if (fs.existsSync(zipFile)) {
  const stat = fs.statSync(zipFile);
  console.log(`\n🎉 Chrome 插件发布包已成功生成！`);
  console.log(`📁 路径: ${zipFile}`);
  console.log(`⚖️ 大小: ${(stat.size / 1024).toFixed(2)} KB`);
  console.log(`\n💡 发布 Chrome 应用商店指引：`);
  console.log(`1. 登录 Chrome 开发者控制台: https://chrome.google.com/webstore/devconsole/`);
  console.log(`2. 点击「新建项目」或「添加新项目」；`);
  console.log(`3. 上传上述生成的 self-hub-chrome-extension.zip 文件即可！`);
} else {
  console.error('❌ 打包失败，请检查压缩工具是否可用。');
  process.exit(1);
}
