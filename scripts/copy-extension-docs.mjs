#!/usr/bin/env node

import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const extensionDir = path.join(repoRoot, 'packages', 'extension');

const docs = ['README.md', 'CHANGELOG.md'];

await Promise.all(
  docs.map((name) =>
    copyFile(path.join(repoRoot, name), path.join(extensionDir, name)),
  ),
);
