#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const extensionDist = path.join(repoRoot, 'packages', 'extension', 'dist');

const webviewOnly = process.argv.includes('--webviews-only');
const targets = webviewOnly
  ? ['progressView', 'settingsView', 'webview', 'shared'].map((name) =>
      path.join(extensionDist, name),
    )
  : [extensionDist];

await Promise.all(
  targets.map((target) => rm(target, { recursive: true, force: true })),
);
