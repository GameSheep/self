#!/usr/bin/env node
/**
 * 语义 token 守门（批次2，审查报告 P0-3 的防回潮措施）。
 *
 * src/index.css 的约定：「redesign 之后的组件不许再取字面量灰/字面量彩」。
 * 之前没有机器守着，收件箱、手绘、DataInterop 又长回了 zinc/indigo/sky 字面量，
 * 亮色主题下出现 1.6:1 的隐身按钮和 hover 白字消失。这里用正则把约定变成
 * 可执行检查：任何 tsx 里再出现这些类，直接非零退出。
 *
 * 例外：index.css 本身（亮色 shim 与 token 定义）、测试、扩展侧原生 JS。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
const PATTERN =
  /(text|bg|border|ring|fill|stroke|placeholder|decoration|divide|outline|from|via|to|shadow|accent|caret)-(zinc|neutral|stone|slate|gray|indigo|sky|purple|violet|amber|emerald|rose|red|green|lime|teal|cyan|blue|fuchsia|pink|orange|yellow)-\d+/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || (full.endsWith('.ts') && !full.endsWith('.d.ts'))) out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const match = line.match(PATTERN);
    if (match) offenders.push(`${file}:${i + 1}  ${match[0]}  ${line.trim().slice(0, 90)}`);
  });
}

if (offenders.length > 0) {
  console.error(`✗ 发现 ${offenders.length} 处字面量调色板类（应使用 sh-* 语义 token）：\n`);
  for (const line of offenders) console.error(`  ${line}`);
  console.error('\n映射参考：灰阶 zinc-* → sh-fg/muted/subtle/surface2/line；indigo|sky → sh-info；');
  console.error('emerald → sh-ok；amber → sh-warn；rose|red → sh-danger；purple|violet → sh-focus；');
  console.error('主按钮 → bg-sh-accent text-sh-accent-fg。');
  process.exit(1);
}
console.log('✓ 语义 token 检查通过：src 下没有字面量调色板类。');
