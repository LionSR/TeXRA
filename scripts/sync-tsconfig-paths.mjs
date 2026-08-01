import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// `tsconfig.build.json` is NOT derived. It is a deliberate subset of the root
// map: the agent package's declaration build emits for core only, so host-side
// and ambient-shim aliases must stay out, and its values differ in shape
// (`src/types/*.ts` rather than `src/types/*`) because they resolve for `.d.ts`
// emit. Deriving it would be wrong. What it lacked was a gate — which is how a
// `@logger` entry pointing at a nonexistent `src/logger/index.ts` survived.
//
// Every root alias must be either present in the build map or listed here, so
// adding a root alias forces a conscious include/exclude decision.
const BUILD_MAP_EXCLUSIONS = new Set([
  // Host-side zones — never part of the core declaration build.
  '@cli/*',
  '@commands/*',
  '@desktop/*',
  '@extensionSchemas/*',
  '@frontend/*',
  '@progressView/*',
  '@resources/*',
  '@settingsView/*',
  '@webview/*',
  '@common/state',
  '@common/state/*',
  '@common/webview',
  '@common/webview/*',
  // Host-neutral but not part of the emitted surface.
  '@controllers/*',
  '@test/*',
  // Ambient / vendored type shims, resolved by `include` rather than by alias.
  '@openrouter/sdk',
  '@openrouter/sdk/models',
  '@openrouter/sdk/models/errors',
  'data-uri-to-buffer',
  'turndown-plugin-gfm',
  'vscode-jsonrpc/node',
]);

function validateBuildMap(rootPathsMap) {
  const buildPath = path.join(rootDir, 'tsconfig.build.json');
  const buildJson = JSON.parse(
    // Strip line comments; this file is JSONC.
    readFileSync(buildPath, 'utf8').replaceAll(/^\s*\/\/.*$/gm, ''),
  );
  const buildPaths = buildJson.compilerOptions?.paths ?? {};
  const problems = [];

  for (const key of Object.keys(buildPaths)) {
    if (!(key in rootPathsMap)) {
      problems.push(
        `tsconfig.build.json declares "${key}", which no longer exists in the root tsconfig.json.`,
      );
    }
  }

  for (const [key, targets] of Object.entries(buildPaths)) {
    for (const target of targets) {
      if (target.includes('*')) continue;
      if (!existsSync(path.join(rootDir, target))) {
        problems.push(
          `tsconfig.build.json maps "${key}" to "${target}", which does not exist on disk.`,
        );
      }
    }
  }

  for (const key of Object.keys(rootPathsMap)) {
    if (key in buildPaths) continue;
    if (BUILD_MAP_EXCLUSIONS.has(key)) continue;
    problems.push(
      `Root alias "${key}" is neither in tsconfig.build.json nor in BUILD_MAP_EXCLUSIONS ` +
        `(scripts/sync-tsconfig-paths.mjs). Add it to one so the omission is deliberate.`,
    );
  }

  return problems;
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

const buildMapProblems = validateBuildMap(rootPaths);
for (const problem of buildMapProblems) console.error(problem);
if (buildMapProblems.length > 0) outOfSync = true;
else console.log('tsconfig.build.json is a declared subset of the root map.');

if (check) {
  if (outOfSync) {
    throw new Error(
      'One or more tsconfig paths maps are out of sync with the root tsconfig.json.',
    );
  }
  console.log(
    'packages/extension/tsconfig.json and packages/desktop/tsconfig.paths.json paths are in sync with the root.',
  );
} else if (outOfSync) {
  // The build map is validated, never rewritten — syncing cannot repair it.
  throw new Error(
    'tsconfig.build.json needs a manual fix; see the errors above.',
  );
}
