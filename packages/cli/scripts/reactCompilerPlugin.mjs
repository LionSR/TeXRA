// React Compiler Babel pre-pass for esbuild.
//
// Scope: `packages/cli/src/chat/tui/**/*.tsx` and `packages/cli/src/tui/**/*.tsx`
// only, per docs/prds/cli-tui-ink/2026-05-14-20-implementation.md (Phase 0).
// The latter is the shared Ink UI kit (Select, BorderedPanel, KeyHints,
// LoadingIndicator, …) reused by chat and by other CLI entry points
// (onboarding, config, orchestration, init wizard, login picker) — it must
// stay in scope alongside chat/tui or those components silently lose
// compiler memoization on relocation. Limiting the pre-pass to these two
// directories keeps risk R12 (toolchain bloat) bounded — the rest of the CLI
// is built by esbuild alone.
//
// Behavior: when esbuild loads a matching .tsx file, run @babel/core with
// babel-plugin-react-compiler + preset-typescript + preset-react (automatic
// runtime). Hand the transformed JS back to esbuild.

import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';

const TUI_PATH_SEGMENTS = [
  normalize('packages/cli/src/chat/tui/'),
  normalize('packages/cli/src/tui/'),
  normalize('src/chat/tui/'),
  normalize('src/tui/'),
];

let babelPromise;
async function getBabel() {
  babelPromise ??= import('@babel/core');
  return babelPromise;
}

function isTuiTsx(filePath) {
  return (
    TUI_PATH_SEGMENTS.some((segment) => filePath.includes(segment)) &&
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
            // `@babel/preset-typescript` requires `allExtensions: true` when
            // `isTSX: true` — otherwise the preset throws on the first .tsx
            // it sees.
            [
              '@babel/preset-typescript',
              {
                isTSX: true,
                allExtensions: true,
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
