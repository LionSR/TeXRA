#!/usr/bin/env node

// Bind `texra-local` to this checkout's built launcher. The published
// command remains available as `texra`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const target = path.join(repoRoot, 'packages/cli/dist/texra.js');
const binDir = process.env.TEXRA_LOCAL_BIN_DIR
  ? path.resolve(process.env.TEXRA_LOCAL_BIN_DIR)
  : path.join(homedir(), '.local/bin');
const linkPath = path.join(binDir, 'texra-local');

if (!existsSync(target)) {
  console.error('Run `npm run texra-local:build` to build and link the CLI.');
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
// `lstatSync` sees a dangling link, which can still be relinked.
const existing = lstatSync(linkPath, { throwIfNoEntry: false });
if (existing && !existing.isSymbolicLink()) {
  console.error(`Move ${linkPath} aside before linking texra-local.`);
  process.exit(1);
}
if (!existing || readlinkSync(linkPath) !== target) {
  if (existing) unlinkSync(linkPath);
  symlinkSync(target, linkPath);
  console.log(`Linked texra-local -> ${target}`);
}

const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
if (!pathDirs.includes(binDir)) {
  console.warn(
    `\n${binDir} is not on your PATH. Add it (e.g. in your shell rc):\n` +
      `  export PATH="${binDir}:$PATH"`,
  );
}
