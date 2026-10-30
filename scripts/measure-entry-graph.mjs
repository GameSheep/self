/**
 * Measure the first-load JavaScript budget.
 *
 * The dev doc's §15.4 budget is stated as "初始路由 JS gzip 目标 ≤250KB". Reporting
 * a single `index-*.js` size is not that number: the entry chunk statically imports
 * other chunks (storage, jsx runtime, …), and the browser loads those before first
 * paint too. This script follows the **static** import graph from the entry script
 * and sums gzipped sizes, so "did this change cost the first load anything?" has a
 * repeatable answer instead of a guess.
 *
 * Dynamic `import(...)` targets are deliberately excluded — those are the point of
 * code splitting.
 *
 * Usage: node scripts/measure-entry-graph.mjs [distDir]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2] ?? 'dist';
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const entryMatch = /<script[^>]+src="([^"]+)"/.exec(html);
if (!entryMatch) {
  console.error('找不到入口脚本：dist/index.html 里没有 <script src>');
  process.exit(1);
}

const entry = entryMatch[1].replace(/^\.?\//, '').replace(/^assets\//, '');
const seen = new Set();
const rows = [];

function resolveChunk(fromFile, reference) {
  // Chunks reference each other relative to the assets directory.
  const base = path.posix.dirname(fromFile);
  return path.posix.normalize(path.posix.join(base, reference));
}

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const full = path.join(dist, 'assets', file);
  let source;
  try {
    source = readFileSync(full, 'utf8');
  } catch {
    return;
  }
  rows.push({ file, gzip: gzipSync(source).length, raw: Buffer.byteLength(source) });

  /**
   * Remove Vite's lazy-dependency map before scanning.
   *
   * Rollup emits `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./a.js",…])))`
   * listing the targets of *dynamic* imports, and the preload helper references it as
   * `import"./x.js"`-looking text is not what it is: those are strings in an array, not
   * import statements. Scanning them counted every lazily-loaded chunk (settings, backup,
   * migration…) as part of the first load, which made this number useless in the
   * pessimistic direction — it punished exactly the code splitting it is supposed to
   * reward. The array holds only strings, so it can be cut safely.
   */
  const scanned = source.replace(/m\.f\|\|\(m\.f=\[[^\]]*\]\)/g, 'm.f||(m.f=[])');

  // `from"./x.js"` and bare `import"./x.js"` are static; `import("./x.js")` is not.
  for (const match of scanned.matchAll(/(?:from|import)"\.\/([^"]+)"/g)) {
    walk(resolveChunk(file, match[1]));
  }
}

walk(entry);

rows.sort((a, b) => b.gzip - a.gzip);
const totalGzip = rows.reduce((sum, row) => sum + row.gzip, 0);
const totalRaw = rows.reduce((sum, row) => sum + row.raw, 0);
for (const row of rows) {
  console.log(`${(row.gzip / 1024).toFixed(2).padStart(8)} KB gzip  ${(row.raw / 1024).toFixed(2).padStart(9)} KB  ${row.file}`);
}
console.log('-'.repeat(72));
console.log(`首屏静态图共 ${rows.length} 个 chunk：gzip ${(totalGzip / 1024).toFixed(2)} KB（原始 ${(totalRaw / 1024).toFixed(2)} KB）`);
console.log(`预算 250 KB → ${totalGzip / 1024 <= 250 ? '在预算内' : '超出预算'}`);
