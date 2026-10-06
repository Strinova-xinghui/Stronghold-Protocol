// 通用导入解析检查器：验证每条具名 import 在目标模块中确实有对应 export。
// 专治合并/移植时「取了调用方代码、没取被调用方符号」的运行时 ReferenceError。
// 用法: node tools/check-imports.mjs [--dir public/js] [--all]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = process.argv.includes('--all')
  ? ['public/js', 'server', 'shared', 'tools']
  : ['public/js', 'shared', 'server/match', 'server/sim'];
const SELF = path.resolve(import.meta.filename || fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 提取一个模块的导出名（含 `export { a, b as c }` 与 `export ... from`）。 */
function exportsOf(file) {
  const names = new Set();
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  // export function/const/let/var/class NAME（含生成器 `export function*` 与 async 变体）
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return { names, src };
}

const files = ROOTS.flatMap((r) => walk(r));
const problems = [];
let checked = 0;

for (const file of files) {
  if (path.resolve(file) === SELF) continue; // 不检查扫描器自身（内含示例正则）
  const raw = fs.readFileSync(file, 'utf8');
  // 剥离注释（块注释 + 行注释），避免把文档里的示例 import 当真代码
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  // import { a, b as c } from '...'   /   import X from '...'   /   import * as N from '...'
  const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const named = m[2];
    const star = m[3];
    const dflt = m[1] || m[4];
    const spec = m[5];
    if (!spec.startsWith('.')) continue; // 只查相对导入
    const target = path.normalize(path.join(path.dirname(file), spec));
    if (path.resolve(target) === path.resolve(file)) continue; // 自引用（battle/runner.js 的注释示例）跳过
    const info = exportsOf(target);
    if (!info) { problems.push(`${file} → 找不到模块 ${spec}`); continue; }
    checked++;
    if (named) {
      for (const part of named.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const [orig, alias] = t.split(/\s+as\s+/).map((x) => x.trim());
        if (!info.names.has(orig)) {
          problems.push(`${file}\n    导入了 ${orig}${alias ? ` as ${alias}` : ''}，但 ${spec} 没有导出它`);
        }
      }
    }
    if (star) { /* namespace import 总是合法 */ }
    if (dflt && !info.names.has('default')) {
      problems.push(`${file}\n    默认导入 ${dflt}，但 ${spec} 没有 default 导出`);
    }
  }
}

console.log(`检查 ${files.length} 个文件，${checked} 条相对导入`);
if (!problems.length) {
  console.log('✓ 所有具名导入均能解析到实际导出');
  process.exit(0);
}
console.log(`✗ 发现 ${problems.length} 处问题：`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
