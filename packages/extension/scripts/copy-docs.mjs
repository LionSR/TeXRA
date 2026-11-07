// Copy the repo-root README and CHANGELOG into the package, so vsce
// includes them in the VSIX.
import { copyFile } from 'node:fs/promises';

await Promise.all(
  ['README.md', 'CHANGELOG.md'].map((name) =>
    copyFile(
      new URL(`../../../${name}`, import.meta.url),
      new URL(`../${name}`, import.meta.url),
    ),
  ),
);
