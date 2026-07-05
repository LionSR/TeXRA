#!/usr/bin/env node
/* global console, process */
/**
 * Copies the static third-party CSS + fonts needed by the HTML chat export
 * into a destination `htmlExport/` folder, sourced straight from the repo
 * root's `node_modules` (katex, highlight.js, markdown-it-texmath). Runtime
 * export handlers copy/stage this folder alongside each exported HTML
 * document so it's viewable offline with the same KaTeX/highlight.js styling
 * as the webview.
 *
 * TeXRA's own styling (tokens + document sheet) is NOT copied here — it lives
 * in `src/shared/htmlExport/styles/` and is inlined into each export's <head>
 * by buildExportTemplate, so only third-party assets need staging.
 *
 * Exports `stageHtmlExportAssets(destRoot)` so any package (the VS Code
 * extension, the CLI, …) can regenerate its own copy independently — no
 * package needs another package's build to have already run. When invoked
 * directly, stages into `packages/extension/resources/htmlExport/` as part
 * of `compile:fast` / `package:fast` so the resources are in place before
 * vsce packages the extension.
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nodeModules = path.join(repoRoot, 'node_modules');

const katexSrc = path.join(nodeModules, 'katex', 'dist');
const hljsThemeSrc = path.join(
  nodeModules,
  'highlight.js',
  'styles',
  'github.css',
);
const hljsDarkThemeSrc = path.join(
  nodeModules,
  'highlight.js',
  'styles',
  'github-dark.css',
);
const texmathCssSrc = path.join(
  nodeModules,
  'markdown-it-texmath',
  'css',
  'texmath.css',
);

async function copyDir(src, dest, filter = () => true) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDir(from, to, filter);
      } else if (filter(entry.name)) {
        await copyFile(from, to);
      }
    }),
  );
}

/**
 * Stage the KaTeX / highlight.js / texmath CSS + font assets into `destRoot`.
 * Wipes and recreates `destRoot` so stale files never linger.
 */
export async function stageHtmlExportAssets(destRoot) {
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });

  await copyFile(
    path.join(katexSrc, 'katex.min.css'),
    path.join(destRoot, 'katex.min.css'),
  );
  await copyDir(
    path.join(katexSrc, 'fonts'),
    path.join(destRoot, 'fonts'),
    (name) => name.endsWith('.woff2'),
  );
  await copyFile(hljsThemeSrc, path.join(destRoot, 'hljs-light.css'));
  await copyFile(hljsDarkThemeSrc, path.join(destRoot, 'hljs-dark.css'));
  await copyFile(texmathCssSrc, path.join(destRoot, 'texmath.css'));
}

async function main() {
  const destRoot = path.join(
    repoRoot,
    'packages',
    'extension',
    'resources',
    'htmlExport',
  );
  await stageHtmlExportAssets(destRoot);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('[html-export-assets] failed:', err);
    process.exit(1);
  });
}
