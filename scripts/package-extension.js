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

// 3. 删除旧 zip 包
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
