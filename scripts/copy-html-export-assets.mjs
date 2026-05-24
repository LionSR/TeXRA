#!/usr/bin/env node
/**
 * Copies the static CSS + fonts needed by the HTML chat export into
 * `packages/extension/resources/htmlExport/`. The runtime export handler
 * copies this folder alongside each exported HTML file so the document is
 * viewable offline with the same KaTeX/highlight.js styling as the webview.
 *
 * Run as part of `compile:fast` / `package:fast` so the resources are in
 * place before vsce packages the extension.
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nodeModules = path.join(repoRoot, 'node_modules');
const destRoot = path.join(
  repoRoot,
  'packages',
  'extension',
  'resources',
  'htmlExport',
);

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
const chatCssSrc = path.join(
  repoRoot,
  'packages',
  'extension',
  'src',
  'commands',
  'history',
  'htmlExport',
  'chat.css',
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

async function main() {
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
  await copyFile(chatCssSrc, path.join(destRoot, 'chat.css'));
}

main().catch((err) => {
  console.error('[html-export-assets] failed:', err);
  process.exit(1);
});
