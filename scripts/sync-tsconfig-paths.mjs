import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import prettier from 'prettier';
import {
  loadRootPaths,
  deriveExtensionPaths,
  deriveDesktopPaths,
} from './aliasUtils.mjs';

// Code-generate the `compilerOptions.paths` block of the extension and
// desktop tsconfig copies from the root tsconfig.json — the single
// hand-edited source of truth for path aliases. Mirrors
// sync-package-contributes.mjs: in `--check` mode this is the CI diff gate,
// failing when a copy has drifted out of sync with the root map.

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const targets = [
  {
    tsconfigPath: path.join(rootDir, 'packages', 'extension', 'tsconfig.json'),
    derive: deriveExtensionPaths,
  },
  {
    tsconfigPath: path.join(
      rootDir,
      'packages',
      'desktop',
      'tsconfig.paths.json',
    ),
    derive: deriveDesktopPaths,
  },
];

async function formatJson(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...options, filepath });
}

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const check = process.argv.includes('--check');
const rootPaths = loadRootPaths(rootDir);
let outOfSync = false;

for (const { tsconfigPath, derive } of targets) {
  const currentText = await readFile(tsconfigPath, 'utf8');
  const currentJson = JSON.parse(currentText);
  const nextJson = {
    ...currentJson,
    compilerOptions: {
      ...currentJson.compilerOptions,
      paths: derive(rootPaths),
    },
  };
  const nextText = await formatJson(
    `${JSON.stringify(nextJson, null, 2)}\n`,
    tsconfigPath,
  );
  const relativePath = path.relative(rootDir, tsconfigPath);

  if (check) {
    if (normalizeLineEndings(nextText) !== normalizeLineEndings(currentText)) {
      console.error(
        `${relativePath} paths are out of sync with the root tsconfig.json. Run npm run sync:tsconfig-paths.`,
      );
      outOfSync = true;
    }
  } else {
    await writeFile(tsconfigPath, nextText);
    console.log(`Synced ${relativePath} paths from tsconfig.json`);
  }
}

if (check) {
  if (outOfSync) {
    throw new Error(
      'One or more tsconfig paths maps are out of sync with the root tsconfig.json.',
    );
  }
  console.log(
    'packages/extension/tsconfig.json and packages/desktop/tsconfig.paths.json paths are in sync with the root.',
  );
}
