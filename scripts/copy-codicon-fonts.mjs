#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const codiconFont = path.join(
  repoRoot,
  'node_modules',
  '@vscode',
  'codicons',
  'dist',
  'codicon.ttf',
);
const extensionDist = path.join(repoRoot, 'packages', 'extension', 'dist');
const webviewDistDirs = ['progressView', 'settingsView', 'webview'].map(
  (name) => path.join(extensionDist, name),
);

await Promise.all(
  webviewDistDirs.map(async (targetDir) => {
    await mkdir(targetDir, { recursive: true });
    await copyFile(codiconFont, path.join(targetDir, 'codicon.ttf'));
  }),
);
