// 扫描前端文件中「被调用但未导入且未定义」的已知 fork 符号（合并冲突遗漏检查）
import fs from 'node:fs';
import path from 'node:path';

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

const SYMS = ['voiceKey', 'voiceLang', 'skinPicker', 'SkinSection', 'setSkin', 'sanitizeSkins', 'exportPayload', 'parseImport'];
const files = walk('public/js');
const found = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const raw of m[1].split(',')) imported.add(raw.trim().split(/\s+as\s+/).pop());
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) imported.add(m[1]);
  const lines = src.split('\n');
  for (const sym of SYMS) {
    const callRe = new RegExp('(^|[^\\w.$])' + sym + '\\s*\\(');
    const defRe = new RegExp('(function|const|let|var|class)\\s+' + sym + '\\b');
    lines.forEach((line, i) => {
      const t = line.trim();
      // 跳过注释行（// 与 * 开头）与字符串里的示例
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (callRe.test(line) && !imported.has(sym) && !defRe.test(src)) {
        found.push(`${f}:${i + 1} 调用 ${sym}() 但未导入`);
      }
    });
  }
}
if (!found.length) console.log('✓ 未发现「调用但未导入」的符号');
else found.forEach((x) => console.log('  ✗ ' + x));
