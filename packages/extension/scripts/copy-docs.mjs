// Copy the repo-root CHANGELOG into the package so vsce includes it in the
// VSIX. The Marketplace README lives directly at packages/extension/README.md.
import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../../../CHANGELOG.md', import.meta.url),
  new URL('../CHANGELOG.md', import.meta.url),
);
