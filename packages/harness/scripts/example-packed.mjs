// Installs the packed `@texra-ai/llm` and `@texra-ai/harness` the way a
// consumer off the registry gets them, then type-checks and runs
// `example/`. With `--acceptance`, runs `acceptance.ts` instead of the
// ladder, against the real route `TEXRA_EXAMPLE_MODEL` names, and writes
// its evidence under `TEXRA_ACCEPTANCE_OUT` (by default a new directory in
// `.agents/docs/evidence/<date>-harness-real-model/`). The consumer is a temporary directory outside the repository:
// from inside it, Node and TypeScript would walk up into the workspace's
// node_modules and find a package or a type the tarballs do not declare.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const acceptance = process.argv.includes('--acceptance');
const model = process.env.TEXRA_EXAMPLE_MODEL?.trim();
if (acceptance && !model?.includes('/')) {
  console.error('--acceptance needs TEXRA_EXAMPLE_MODEL=provider/model.');
  process.exit(1);
}
const consumer = mkdtempSync(join(tmpdir(), 'texra-packed-example-'));

/** Run one command; a failed step ends the check and keeps the consumer. */
const run = (command, args, cwd) => {
  const { status } = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (status !== 0) {
    console.error(`Failed: ${command} ${args.join(' ')} (in ${consumer})`);
    process.exit(status ?? 1);
  }
};

const exampleDir = join(packageRoot, 'example');
for (const file of readdirSync(exampleDir)) {
  if (file.endsWith('.ts') || file.endsWith('.json')) {
    copyFileSync(join(exampleDir, file), join(consumer, file));
  }
}
// Each pack runs its package's `prepack`, which builds what it publishes.
for (const [name, file] of [
  ['@texra-ai/llm', 'llm.tgz'],
  ['@texra-ai/harness', 'harness.tgz'],
]) {
  run(
    'corepack',
    ['pnpm', '--filter', name, 'pack', '--pack-destination', consumer],
    packageRoot,
  );
  const packed = readdirSync(consumer).find((entry) =>
    entry.startsWith(`${name.slice(1).replace('/', '-')}-`),
  );
  renameSync(join(consumer, packed), join(consumer, file));
}
// A plugin package of its own, packed as its author would publish it.
run(
  'npm',
  ['pack', join(exampleDir, 'acme-notes'), '--pack-destination', consumer],
  packageRoot,
);
renameSync(
  join(consumer, 'acme-notes-1.0.0.tgz'),
  join(consumer, 'acme-notes.tgz'),
);
// npm, not pnpm: a plain node_modules and no lockfile, so the install
// resolves what a new consumer's would, peers included.
run('npm', ['install', '--no-audit', '--no-fund'], consumer);
// The workspace's TypeScript over the installed declarations, strict and
// with skipLibCheck off, so a declaration that does not resolve fails here.
// The bin's JavaScript entry, from the package's own `bin` field (the
// workspace's `typescript` is an alias whose bin is not named `tsc`).
const typescriptManifest = createRequire(import.meta.url).resolve(
  'typescript/package.json',
);
const [tsc] = Object.values(
  JSON.parse(readFileSync(typescriptManifest, 'utf8')).bin,
);
run(
  process.execPath,
  [join(dirname(typescriptManifest), tsc), '-p', consumer],
  consumer,
);
if (acceptance) {
  // One directory per run: the model and the local time it started.
  const now = new Date();
  const day = now.toLocaleDateString('sv');
  // Absolute: the runner writes from inside the consumer, which is removed.
  const evidence = resolve(
    process.env.TEXRA_ACCEPTANCE_OUT?.trim() ||
      join(
        packageRoot,
        '../../.agents/docs/evidence',
        `${day}-harness-real-model`,
        `${model.replaceAll('/', '-')}-${now.toTimeString().slice(0, 5).replace(':', '')}`,
      ),
  );
  if (existsSync(evidence)) {
    console.error(`Evidence directory exists: ${evidence}`);
    process.exit(1);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: packageRoot,
    encoding: 'utf8',
  }).stdout.trim();
  process.env.TEXRA_ACCEPTANCE_OUT = evidence;
  process.env.TEXRA_ACCEPTANCE_COMMIT = commit;
  run(process.execPath, ['acceptance.ts'], consumer);
} else {
  run('npm', ['start'], consumer);
}
rmSync(consumer, { force: true, recursive: true });
