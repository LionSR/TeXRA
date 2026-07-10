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

// Remove any stale mirror first so a skill/file renamed or deleted at the
// source doesn't linger in the packaged copy.
await rm(destinationDir, { recursive: true, force: true });
await cp(sourceDir, destinationDir, { recursive: true });
