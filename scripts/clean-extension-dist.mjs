#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

await rm(path.join(repoRoot, 'packages', 'extension', 'dist'), {
  recursive: true,
  force: true,
});
