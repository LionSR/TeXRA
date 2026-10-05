// Bundle the headless TeXRA service (`texra serve` without the chat TUI)
// into `serve/texra-serve.mjs`, which the extension starts with VS Code's own
// runtime as Node (`ELECTRON_RUN_AS_NODE=1`). It sits one level below the
// extension root so it finds the extension's `resources/` and its
// `package.json` version, as the CLI's bundle finds its own.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const cliRoot = path.join(extensionRoot, '..', 'cli');
const result = spawnSync(
  process.execPath,
  [path.join(cliRoot, 'scripts', 'build-bundle.mjs'), '--serve'],
  {
    cwd: cliRoot,
    env: {
      ...process.env,
      TEXRA_CLI_BUNDLE_OUTFILE: path.join(
        extensionRoot,
        'serve',
        'texra-serve.mjs',
      ),
    },
    stdio: 'inherit',
  },
);
process.exit(result.status ?? 1);
