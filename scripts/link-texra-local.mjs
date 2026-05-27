#!/usr/bin/env node

// Create (or refresh) a `texra-local` command that always runs this repo's
// locally-built CLI, so it can coexist with a globally-installed published
// `texra`. It's a symlink to the bundled `dist/bin/texra.js`, which each CLI
// build overwrites in place — so rebuilding the CLI updates `texra-local`
// automatically, no relinking needed.
//
//   node scripts/link-texra-local.mjs           # link into ~/.local/bin
//   TEXRA_LOCAL_BIN_DIR=/some/dir node scripts/link-texra-local.mjs
//
// Refresh the build it points at with: npm run texra-local:build

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const target = path.join(repoRoot, 'packages/cli/dist/bin/texra.js');
const binDir = process.env.TEXRA_LOCAL_BIN_DIR
  ? path.resolve(process.env.TEXRA_LOCAL_BIN_DIR)
  : path.join(homedir(), '.local/bin');
const linkPath = path.join(binDir, 'texra-local');

// `lstatSync` (unlike `existsSync`) doesn't follow symlinks, so it sees a
// dangling link too — clear whatever is there before relinking.
function pathPresent(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

mkdirSync(binDir, { recursive: true });
if (pathPresent(linkPath)) rmSync(linkPath);
symlinkSync(target, linkPath);

console.log(`Linked texra-local -> ${target}`);

if (!existsSync(target)) {
  console.warn(
    '\nThe target build does not exist yet — run `npm run texra-local:build` ' +
      'before invoking texra-local.',
  );
}

const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
if (!pathDirs.includes(binDir)) {
  console.warn(
    `\n${binDir} is not on your PATH. Add it (e.g. in your shell rc):\n` +
      `  export PATH="${binDir}:$PATH"`,
  );
}
