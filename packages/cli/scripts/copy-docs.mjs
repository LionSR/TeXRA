#!/usr/bin/env node

// Publish the CLI-focused npm README (`README.npm.md`) as the packaged
// `packages/cli/README.md` (which is gitignored).
import { copyFile } from 'node:fs/promises';
import path from 'node:path';

const cliRoot = path.resolve(import.meta.dirname, '..');

await copyFile(
  path.join(cliRoot, 'README.npm.md'),
  path.join(cliRoot, 'README.md'),
);
