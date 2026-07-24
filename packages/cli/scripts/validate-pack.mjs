#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageName = '@texra-ai/cli';
const packageDir = 'package/';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? cliRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEXRA_CLI_BUNDLE_OUTFILE: '',
      TEXRA_CLI_RESOURCES_OUTDIR: '',
      TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '',
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoForbiddenTarballEntries(entries) {
  const forbidden = entries.filter((entry) => {
    const relative = entry.startsWith(packageDir)
      ? entry.slice(packageDir.length)
      : entry;
    return (
      relative.endsWith('.map') ||
      relative.endsWith('.ts') ||
      relative.startsWith('src/') ||
      relative.startsWith('scripts/') ||
      // The only executable that ships under dist/bin is the CLI itself.
      // Anything else there (e.g. the PTY tui-harness) is a dev/test artifact.
      (relative.startsWith('dist/bin/') && relative !== 'dist/bin/texra.js') ||
      relative.startsWith('dist/resources/walkthroughs/') ||
      relative.startsWith('dist/resources/examples/') ||
      relative.startsWith('dist/resources/logo-') ||
      // The chat-export template is extension-only.
      relative === 'dist/resources/templates/chatExport.tex'
    );
  });

  assert(
    forbidden.length === 0,
    `npm package contains entries excluded from the public CLI artifact:\n${forbidden.join(
      '\n',
    )}`,
  );
}

function assertBundledSkillsIncluded(entries) {
  const hasBundledSkillManifest = entries.some((entry) => {
    const relative = entry.startsWith(packageDir)
      ? entry.slice(packageDir.length)
      : entry;
    return (
      relative.startsWith('dist/resources/skills/') &&
      relative.endsWith('/SKILL.md')
    );
  });

  assert(
    hasBundledSkillManifest,
    'npm package should include bundled CLI skill manifests.',
  );
}

function assertBundleHardened(bundlePath) {
  const bundle = readFileSync(bundlePath, 'utf8');
  const forbiddenFragments = [
    'sourceMappingURL',
    'sourcesContent',
    'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER',
    'Validated CLI Runtime',
    'modelHandlerValidation',
    '/Users/',
  ];
  const present = forbiddenFragments.filter((fragment) =>
    bundle.includes(fragment),
  );
  assert(
    present.length === 0,
    `CLI bundle contains forbidden production fragments: ${present.join(', ')}`,
  );
  assert(
    !/^\/\/ .*src\//m.test(bundle),
    'CLI bundle exposes source-module boundary comments.',
  );
}

function parsePackResult(stdout) {
  const jsonStart = stdout.lastIndexOf('\n[');
  const jsonText = (
    jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout
  ).trim();
  const result = JSON.parse(jsonText);
  const first = Array.isArray(result) ? result[0] : result;
  assert(first?.filename, 'npm pack did not report a tarball filename.');
  return first.filename;
}

const tmp = mkdtempSync(path.join(tmpdir(), 'texra-cli-pack-'));
try {
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', tmp]);
  const tarballPath = path.join(tmp, parsePackResult(packOutput));
  const entries = run('tar', ['-tf', tarballPath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  assertNoForbiddenTarballEntries(entries);
  assertBundledSkillsIncluded(entries);

  const installRoot = path.join(tmp, 'install');
  run('npm', ['install', '--prefix', installRoot, tarballPath]);
  const installedBin = path.join(
    installRoot,
    'node_modules',
    packageName,
    'dist',
    'bin',
    'texra.js',
  );
  assertBundleHardened(installedBin);

  const help = run(process.execPath, [installedBin, '--help']);
  assert(help.includes('TeXRA CLI'), 'installed CLI help should name TeXRA.');

  const version = run(process.execPath, [installedBin, 'version']).trim();
  assert(version.length > 0, 'installed CLI version should be non-empty.');

  console.log(`CLI npm package validation passed: ${tarballPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
