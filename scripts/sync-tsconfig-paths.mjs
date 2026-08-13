import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import prettier from 'prettier';
import {
  loadRootPaths,
  deriveDesktopPaths,
  deriveBuildPaths,
  parseJsonc,
  pathTargetExists,
} from './aliasUtils.mjs';

// Code-generate the `compilerOptions.paths` block of the desktop and
// build tsconfig copies from the root tsconfig.json — the single
// hand-edited source of truth for path aliases. The extension tsconfig
// now extends root directly and inherits its paths.
// Mirrors sync-package-contributes.mjs: in `--check` mode this is the
// CI diff gate, failing when a copy has drifted out of sync with the
// root map.

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const targets = [
  {
    tsconfigPath: path.join(rootDir, 'tsconfig.build.json'),
    derive: deriveBuildPaths,
    validateTargets: true,
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

for (const { tsconfigPath, derive, validateTargets = false } of targets) {
  const currentText = await readFile(tsconfigPath, 'utf8');
  const currentJson = parseJsonc(currentText);
  const derivedPaths = derive(rootPaths);
  if (validateTargets) {
    const unresolved = Object.entries(derivedPaths).filter(
      ([, pathTargets]) =>
        !pathTargets.some((target) => pathTargetExists(rootDir, target)),
    );
    if (unresolved.length > 0) {
      const details = unresolved
        .map(
          ([key, pathTargets]) =>
            `${path.relative(rootDir, tsconfigPath)} maps "${key}" only to targets with no matches: ${pathTargets.join(', ')}.`,
        )
        .join('\n');
      throw new Error(details);
    }
  }
  const nextJson = {
    ...currentJson,
    compilerOptions: {
      ...currentJson.compilerOptions,
      paths: derivedPaths,
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
    'tsconfig.build.json and the desktop path map are in sync with the root.',
  );
}
