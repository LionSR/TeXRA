#!/usr/bin/env node

// Publish the repo-root README (which documents both the VS Code extension and
// the CLI) as the npm package README, mirroring the extension's
// copy-extension-docs.mjs. The generated packages/cli/README.md is gitignored.
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(cliRoot, '..', '..');

await copyFile(
  path.join(repoRoot, 'README.md'),
  path.join(cliRoot, 'README.md'),
);
