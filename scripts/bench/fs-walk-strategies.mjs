/**
 * R-1 evidence: the cost of walking a directory tree through
 * `effect/FileSystem` versus the repo's `FileSystemProvider` port.
 *
 * The port's `readDirectory` returns `[name, type]` pairs, reading each
 * entry's type off the `withFileTypes` dirent for free and paying a `stat`
 * only to resolve a symlink's target. `FileSystem.readDirectory` returns
 * names only, so every entry costs a `stat` to classify.
 *
 * Run: `node scripts/bench/fs-walk-strategies.mjs`
 * See: .agents/docs/proposed/architecture/2026-09-08-r1-filesystem-surface-experiment.md
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-'));
// A LaTeX-ish workspace: nested dirs, many files, a few symlinks.
let made = 0;
async function build(dir, depth) {
  if (depth === 0) return;
  for (let i = 0; i < 6; i++) {
    const sub = path.join(dir, `d${i}`);
    await fs.promises.mkdir(sub);
    for (let j = 0; j < 12; j++) {
      await fs.promises.writeFile(path.join(sub, `f${j}.tex`), 'x');
      made++;
    }
    await build(sub, depth - 1);
  }
}
await build(root, 3);
// a handful of symlinks, as a real workspace has
await fs.promises.symlink(path.join(root, 'd0'), path.join(root, 'linkdir'));
await fs.promises.writeFile(path.join(root, 'real.tex'), 'x');
await fs.promises.symlink(
  path.join(root, 'real.tex'),
  path.join(root, 'link.tex'),
);

let statsA = 0,
  readdirA = 0,
  statsB = 0,
  readdirB = 0;

// Strategy A — the repo's FileSystemProvider: types come off the dirent.
async function walkA(dir) {
  readdirA++;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      statsA++;
      try {
        isDir = (await fs.promises.stat(p)).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) await walkA(p);
  }
}

// Strategy B — effect/FileSystem: readDirectory returns names only.
async function walkB(dir) {
  readdirB++;
  const names = await fs.promises.readdir(dir);
  for (const n of names) {
    const p = path.join(dir, n);
    statsB++;
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) await walkB(p);
  }
}

const t0 = performance.now();
await walkA(root);
const tA = performance.now() - t0;
const t1 = performance.now();
await walkB(root);
const tB = performance.now() - t1;

console.log(
  JSON.stringify(
    {
      files: made,
      A_repo: { readdir: readdirA, stat: statsA, ms: +tA.toFixed(1) },
      B_effect: { readdir: readdirB, stat: statsB, ms: +tB.toFixed(1) },
      extra_stats: statsB - statsA,
      slowdown: +(tB / tA).toFixed(2),
    },
    null,
    2,
  ),
);
await fs.promises.rm(root, { recursive: true, force: true });
