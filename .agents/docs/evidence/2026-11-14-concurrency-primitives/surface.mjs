// Counts two rows of the note's surface table over the non-test source
// (`packages/*/src`, `.ts` and `.tsx`): lines that call
// `Effect.uninterruptible` or `Effect.uninterruptibleMask`, and lines that
// make a `Queue.unbounded` or `PubSub.unbounded`. A line that is a comment
// (it starts with `//`, `*` or `/*`) is not counted. `--list` prints each
// counted line.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../../../', import.meta.url).pathname;
const ROWS = {
  uninterruptible: /Effect\.uninterruptible(Mask)?\b/,
  unbounded: /\b(Queue|PubSub)\.unbounded\b/,
};

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

const packages = join(root, 'packages');
const sources = readdirSync(packages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const src = join(packages, entry.name, 'src');
    try {
      return files(src);
    } catch {
      return [];
    }
  });

const list = process.argv.includes('--list');
for (const [row, pattern] of Object.entries(ROWS)) {
  const hits = [];
  for (const file of sources) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (pattern.test(line))
          hits.push(`${relative(root, file)}:${index + 1}`);
      });
  }
  console.log(`${row}: ${hits.length}`);
  if (list) for (const hit of hits) console.log(`  ${hit}`);
}
