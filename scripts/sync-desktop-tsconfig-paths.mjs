import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import * as prettier from 'prettier';

// packages/desktop/tsconfig.paths.json used to be a hand-maintained copy of
// tsconfig.json's compilerOptions.paths (re-based to desktop's own baseUrl,
// since a plain `extends` re-resolves an inherited relative `baseUrl` against
// the extending file's own directory, not the base config's). Generate it
// from the root tsconfig instead so the two can't silently drift.
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const rootTsconfigPath = path.join(rootDir, 'tsconfig.json');
const desktopTsconfigPathsPath = path.join(
  rootDir,
  'packages',
  'desktop',
  'tsconfig.paths.json',
);

function parseArgs() {
  return { check: process.argv.includes('--check') };
}

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const { check } = parseArgs();
const rootTsconfigText = await readFile(rootTsconfigPath, 'utf8');
const rootTsconfig = JSON.parse(rootTsconfigText);
const rootPaths = rootTsconfig.compilerOptions?.paths;
if (!rootPaths || typeof rootPaths !== 'object') {
  throw new Error('tsconfig.json is missing compilerOptions.paths');
}

const desktopTsconfigPathsText = await readFile(
  desktopTsconfigPathsPath,
  'utf8',
);
const nextDesktopTsconfigPaths = {
  compilerOptions: {
    baseUrl: '../..',
    paths: rootPaths,
  },
};

// `packages/desktop/tsconfig.paths.json` isn't named package.json, so
// Prettier formats it with the regular `json` parser (which collapses short
// arrays onto one line), not the `json-stringify` parser package.json gets.
// Format through Prettier itself so the generated file matches what
// `npm run format` / the format-pr bot would otherwise rewrite it to.
const prettierConfig =
  (await prettier.resolveConfig(desktopTsconfigPathsPath)) ?? {};
const nextText = await prettier.format(
  JSON.stringify(nextDesktopTsconfigPaths),
  { ...prettierConfig, filepath: desktopTsconfigPathsPath, parser: 'json' },
);

if (check) {
  if (
    normalizeLineEndings(nextText) !==
    normalizeLineEndings(desktopTsconfigPathsText)
  ) {
    throw new Error(
      'packages/desktop/tsconfig.paths.json is out of sync with tsconfig.json. Run npm run sync:desktop-tsconfig-paths.',
    );
  }
  console.log(
    'packages/desktop/tsconfig.paths.json is in sync with tsconfig.json',
  );
} else {
  await writeFile(desktopTsconfigPathsPath, nextText);
  console.log('Synced packages/desktop/tsconfig.paths.json from tsconfig.json');
}
