#!/usr/bin/env node

import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const sourceDir = path.join(repoRoot, 'skills');
const destinationDir = path.join(
  repoRoot,
  'packages',
  'extension',
  'resources',
  'skills',
);

await rm(destinationDir, { force: true, recursive: true });
await cp(sourceDir, destinationDir, { recursive: true });
