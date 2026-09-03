import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// Code-generate every publishable package's NOTICE.txt from the root NOTICE —
// the single hand-edited source of truth for third-party attribution. Each
// artifact must ship its own copy (the VSIX, the Electron installers and the
// two npm packages are distributed separately, and an attribution obligation
// attaches to each), so the duplication is required; what is NOT required is
// maintaining five copies by hand and hoping they agree.
// Mirrors sync-tsconfig-paths.mjs: in `--check` mode this is the CI diff gate,
// failing when a copy has drifted out of sync with the root NOTICE.

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** Every package whose published artifact carries its own attribution copy. */
const PACKAGE_NOTICES = [
  'packages/agent/NOTICE.txt',
  'packages/cli/NOTICE.txt',
  'packages/desktop/NOTICE.txt',
  'packages/extension/NOTICE.txt',
];

const check = process.argv.includes('--check');
const sourcePath = path.join(rootDir, 'NOTICE');
const sourceText = await readFile(sourcePath, 'utf8');

const normalizeLineEndings = (text) => text.replaceAll('\r\n', '\n');

let outOfSync = false;

for (const relativePath of PACKAGE_NOTICES) {
  const targetPath = path.join(rootDir, relativePath);
  const currentText = await readFile(targetPath, 'utf8').catch(() => undefined);

  if (check) {
    if (
      currentText === undefined ||
      normalizeLineEndings(currentText) !== normalizeLineEndings(sourceText)
    ) {
      console.error(
        `${relativePath} is out of sync with the root NOTICE. Run npm run sync:notice.`,
      );
      outOfSync = true;
    }
  } else {
    await writeFile(targetPath, sourceText);
    console.log(`Synced ${relativePath} from NOTICE`);
  }
}

if (check) {
  if (outOfSync) {
    throw new Error(
      'One or more package NOTICE.txt files are out of sync with the root NOTICE.',
    );
  }
  console.log(
    `All ${PACKAGE_NOTICES.length} package NOTICE.txt files are in sync with the root NOTICE.`,
  );
}
