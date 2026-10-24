// Summarize results.jsonl from validate-journeys.mjs: one row per model × arm,
// plus a per-journey breakdown. Usage: node summarize.mjs <results.jsonl>
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : NaN;
};
const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const short = (m) =>
  m
    .replace('google/gemini-3.8-flash@medium', 'gemini-3.8-flash')
    .replace('deepseek/deepseek-flash@high', 'deepseek-flash');
const group = (keyOf) => {
  const g = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
};
const line = (label, rs) => {
  const passed = rs.filter((r) => r.pass);
  const fmt = (x, d = 0) => (Number.isNaN(x) ? '-' : x.toFixed(d));
  return [
    label.padEnd(44),
    `${passed.length}/${rs.length}`.padStart(5),
    fmt(mean(passed.map((r) => r.cost)), 4).padStart(9),
    fmt(mean(passed.map((r) => r.tokens))).padStart(8),
    fmt(
      mean(passed.map((r) => r.cacheReadTokens / Math.max(1, r.inputTokens))) *
        100,
      0,
    ).padStart(6) + '%',
    fmt(median(rs.map((r) => r.wallMs / 1000))).padStart(6) + 's',
    fmt(mean(passed.map((r) => r.scripts ?? 0)), 1).padStart(7),
    fmt(
      mean(
        passed.map((r) =>
          Object.values(r.calls ?? {}).reduce((a, b) => a + b, 0),
        ),
      ),
      1,
    ).padStart(6),
  ].join(' ');
};
const header = [
  'model × arm'.padEnd(44),
  ' pass',
  ' $/pass'.padStart(9),
  '  tokens',
  'cached'.padStart(7),
  ' median'.padStart(7),
  'scripts',
  ' calls',
].join(' ');
console.log(header);
console.log('-'.repeat(header.length));
for (const [k, rs] of group((r) => `${short(r.model)} ${r.arm}`))
  console.log(line(k, rs));
console.log('\nper journey');
console.log('-'.repeat(header.length));
for (const [k, rs] of group((r) => `${short(r.model)} ${r.arm} ${r.name}`))
  console.log(line(k, rs));
const failures = rows.filter((r) => !r.pass);
if (failures.length) {
  console.log('\nfailures');
  for (const f of failures)
    console.log(
      `- ${short(f.model)} ${f.arm} ${f.name} #${f.attempt}: ${f.error.split('\n')[0].slice(0, 160)}`,
    );
}
