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
// With `--dist <dir>` it instead checks a finished build: the dist root may hold
// only the public surface declared in publicDocs.js, the static assets under
// public/, and VitePress's own fixed outputs. The deploy workflow runs that mode
// after the build, so the publish boundary and the post-build allowlist read one
// source and cannot drift apart.
//
// It is intentionally dependency-free (bare Node, only the local publicDocs.js
// import) so it runs without installing the docs sub-project.

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicRootDocs,
  publicRootDirs,
  srcExclude,
} from '../.vitepress/publicDocs.js';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ghError = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';

const distFlag = process.argv.indexOf('--dist');
if (distFlag !== -1) {
  const distDir = process.argv[distFlag + 1];
  if (!distDir) {
    console.error('Usage: check-root-docs.mjs --dist <build output dir>');
    process.exit(2);
  }
  process.exit(checkDist(distDir));
}

/**
 * Compare a finished build's root against the declared public surface.
 * Returns the process exit code.
 */
function checkDist(distDir) {
  // VitePress's fixed outputs, plus the two Pages files the deploy step adds.
  const buildOutputs = [
    'assets',
    '404.html',
    'hashmap.json',
    'vp-icons.css',
    '.nojekyll',
    'CNAME',
  ];
  const publicPages = publicRootDocs.map((doc) =>
    doc.replace(/\.md$/, '.html'),
  );
  const allowed = new Set([
    ...buildOutputs,
    ...publicPages,
    ...publicRootDirs,
    ...readdirSync(join(docsDir, 'public')),
  ]);
  const required = [
    ...publicPages,
    ...publicRootDirs.map((dir) => `${dir}/index.html`),
  ];

  const unexpected = readdirSync(distDir).filter((name) => !allowed.has(name));
  const missing = required.filter((page) => !existsSync(join(distDir, page)));
  for (const name of unexpected) {
    console.error(`${ghError}Unexpected entry in build output: ${name}`);
  }
  for (const page of missing) {
    console.error(`${ghError}Expected public page missing from build: ${page}`);
  }
  if (unexpected.length > 0) {
    console.error(
      `${ghError}Classify it in docs/.vitepress/publicDocs.js, or add a new VitePress output to buildOutputs in this script.`,
    );
  }
  if (unexpected.length > 0 || missing.length > 0) return 1;
  console.log(
    `docs build output OK: ${allowed.size} allowed root entries, ` +
      `${required.length} required pages present.`,
  );
  return 0;
}

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const TRAILING_DATE_SUFFIX = /-20\d{2}(?:-\d{2}(?:-\d{2})?)?\.md$/;
// The former prds/ and proposals/ trees moved to the repo-root .agents/docs/
// note tree, which is outside docs/ and therefore outside this gate's scope.
const TIMESTAMPED_DIRS = ['architecture'];
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
const missingInternalExclusions = TIMESTAMPED_DIRS.filter(
  (dir) => !excluded.has(dir),
);

if (missingInternalExclusions.length > 0) {
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
  console.error(
    `${ghError}Architecture Markdown files require a YYYY-MM-DD- prefix:`,
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
    `internal doc areas (${TIMESTAMPED_DIRS.join(', ')}) are excluded and timestamped.`,
);
