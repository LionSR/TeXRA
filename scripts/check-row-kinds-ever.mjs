#!/usr/bin/env node
// config/storage/row-kinds-ever.json lists every row kind a build ever stored.
// A kind removed from it would let its reader go too, and a store holding that
// kind would then refuse to open, so the list only grows: this fails a kind the
// merge base lists and the tree does not (ratchet-base.mjs: `--base <ref>` or
// TEXRA_RATCHET_BASE, origin/main by default).

import console from 'node:console';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { git, ratchetBase } from './ratchet-base.mjs';

const FILE = 'config/storage/row-kinds-ever.json';
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const { values } = parseArgs({ options: { base: { type: 'string' } } });
const { target, base } = ratchetBase(values.base);
const kinds = (text) => JSON.parse(text).kinds;
const now = new Set(kinds(readFileSync(path.join(rootDir, FILE), 'utf8')));
const removed = kinds(git('show', `${base}:${FILE}`)).filter(
  (kind) => !now.has(kind),
);
if (removed.length > 0) {
  console.error(
    `${FILE}: ${removed.join(', ')} removed against ${target}; the list only grows`,
  );
  process.exitCode = 1;
} else
  console.log(
    `row-kinds-ever: ${now.size} kinds, none removed against ${target}`,
  );
