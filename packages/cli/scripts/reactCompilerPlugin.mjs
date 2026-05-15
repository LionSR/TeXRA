// React Compiler Babel pre-pass for esbuild.
//
// Scope: `packages/cli/src/chat/tui/**/*.tsx` only, per
// docs/prd/cli-tui-ink/20-implementation.md (Phase 0). Limiting the pre-pass
// keeps risk R12 (toolchain bloat) bounded — the rest of the CLI is built by
// esbuild alone.
//
// Behavior: when esbuild loads a matching .tsx file, run @babel/core with
// babel-plugin-react-compiler + preset-typescript + preset-react (automatic
// runtime). Hand the transformed JS back to esbuild.

import { readFile } from 'node:fs/promises';
import { sep, normalize } from 'node:path';

const TUI_PATH_SEGMENT = normalize('packages/cli/src/chat/tui/');
const FALLBACK_SEGMENT = normalize('src/chat/tui/');

let babelPromise;
async function getBabel() {
  babelPromise ??= import('@babel/core');
  return babelPromise;
}

function isTuiTsx(filePath) {
  return (
    (filePath.includes(TUI_PATH_SEGMENT) ||
      filePath.includes(FALLBACK_SEGMENT)) &&
    filePath.endsWith('.tsx')
  );
}

export function reactCompilerPlugin() {
  return {
    name: 'react-compiler',
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const normalized = normalize(args.path);
        if (!isTuiTsx(normalized)) return undefined;

        const source = await readFile(args.path, 'utf8');
        const babel = await getBabel();
        const result = await babel.transformAsync(source, {
          filename: args.path,
          babelrc: false,
          configFile: false,
          sourceMaps: 'inline',
          presets: [
            [
              '@babel/preset-typescript',
              {
                isTSX: true,
                allExtensions: false,
                onlyRemoveTypeImports: true,
              },
            ],
            ['@babel/preset-react', { runtime: 'automatic' }],
          ],
          plugins: [['babel-plugin-react-compiler', { target: '19' }]],
        });

        if (!result?.code) {
          throw new Error(
            `react-compiler plugin: empty output for ${args.path}`,
          );
        }
        return {
          contents: result.code,
          loader: 'js',
        };
      });
    },
  };
}
