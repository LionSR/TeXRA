#!/usr/bin/env node
// CI gate: enforce the public docs boundary and internal-doc naming rules.
//
// VitePress publishes every root-level *.md (and content directory) to texra.ai
// unless it is listed in `srcExclude`. The deploy workflow has an allowlist that
// catches a stray internal doc, but only at deploy time on main — which fails
// the whole Deploy Docs run and silently freezes the site. This gate moves that
// check to PR time: a doc added without being classified as public or internal
// fails the author's PR, loudly, before merge.
//
// It is intentionally dependency-free (bare Node, only the local publicDocs.js
// import) so it runs without installing the docs sub-project.

import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicRootDocs,
  publicRootDirs,
  srcExclude,
} from '../.vitepress/publicDocs.js';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const TRAILING_DATE_SUFFIX = /-20\d{2}(?:-\d{2}(?:-\d{2})?)?\.md$/;
const TIMESTAMPED_DIRS = [
  'architecture',
  'design',
  'dev/audits',
  'prds',
  'proposals',
];
const INTERNAL_DOC_MARKER = /(?:^|[-_])(audit|prd|proposal)(?:[-_.]|$)/i;

// Build/system entries that are never publishable content and need no
// classification (VitePress internals, static-asset dir, deps, this script's
// own folder).
const SYSTEM_ENTRIES = new Set([
  '.vitepress',
  'public',
  'node_modules',
  'scripts',
]);

const publicDocs = new Set(publicRootDocs);
const publicDirs = new Set(publicRootDirs);
// Root-level entries named directly in srcExclude, with any `/**` glob suffix
// stripped so a directory matches its `name/**` exclusion.
const excluded = new Set(srcExclude.map((e) => e.replace(/\/\*\*$/, '')));
const missingInternalExclusions = TIMESTAMPED_DIRS.map((dir) =>
  dir.split('/').at(0),
)
  .filter((dir, index, dirs) => dirs.indexOf(dir) === index)
  .filter((dir) => !excluded.has(dir));

if (missingInternalExclusions.length > 0) {
  const ghError = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(`${ghError}Internal docs directories missing from srcExclude:`);
  for (const dir of missingInternalExclusions) {
    console.error(`${ghError}  docs/${dir}/**`);
  }
  process.exit(1);
}

const entries = readdirSync(docsDir, { withFileTypes: true });
const unclassified = [];

for (const entry of entries) {
  const { name } = entry;
  if (SYSTEM_ENTRIES.has(name)) continue;

  if (entry.isDirectory()) {
    // A content directory must be published (publicRootDirs) or excluded.
    if (publicDirs.has(name) || excluded.has(name)) continue;
    unclassified.push(`${name}/ (directory)`);
    continue;
  }

  // Only markdown is rendered into the public site; other root files
  // (package.json, lockfiles, …) are not published.
  if (!name.endsWith('.md')) continue;
  if (publicDocs.has(name) || excluded.has(name)) continue;
  unclassified.push(name);
}

if (unclassified.length > 0) {
  const ghError = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(
    `${ghError}Unclassified root-level docs entries (neither public nor internal):`,
  );
  for (const name of unclassified) console.error(`${ghError}  docs/${name}`);
  console.error('');
  console.error('Each must be classified in docs/.vitepress/publicDocs.js:');
  console.error(
    '  - publish to texra.ai -> add to publicRootDocs / publicRootDirs',
  );
  console.error('  - keep internal      -> add to srcExclude');
  process.exit(1);
}

function markdownFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(file);
    return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
  });
}

const untimestamped = TIMESTAMPED_DIRS.flatMap((dir) =>
  markdownFilesUnder(join(docsDir, dir)),
)
  .filter((file) => basename(file) !== 'README.md')
  .filter((file) => !TIMESTAMP_PREFIX.test(basename(file)));

const duplicateDateSuffixes = TIMESTAMPED_DIRS.flatMap((dir) =>
  markdownFilesUnder(join(docsDir, dir)),
).filter((file) => TRAILING_DATE_SUFFIX.test(basename(file)));

const misplacedInternalDocs = markdownFilesUnder(docsDir)
  .filter((file) => INTERNAL_DOC_MARKER.test(basename(file)))
  .filter((file) => !TIMESTAMP_PREFIX.test(basename(file)));

const invalidInternalDocs = [
  ...new Set([
    ...untimestamped,
    ...duplicateDateSuffixes,
    ...misplacedInternalDocs,
  ]),
].toSorted();

if (invalidInternalDocs.length > 0) {
  const ghError = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(
    `${ghError}Architecture, design, audit, PRD, and proposal Markdown files require a YYYY-MM-DD- prefix:`,
  );
  for (const file of invalidInternalDocs) {
    console.error(`${ghError}  docs/${relative(docsDir, file)}`);
  }
  console.error(
    `${ghError}Use one YYYY-MM-DD- prefix; README.md index files are the only exception.`,
  );
  process.exit(1);
}

console.log(
  `docs boundary OK: every root-level entry is classified ` +
    `(${publicDocs.size} public docs, ${publicDirs.size} public dirs); ` +
    `${TIMESTAMPED_DIRS.length} internal doc areas are excluded and timestamped.`,
);
