#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));
const binaryPath = path.join(cliRoot, 'dist/bin/texra.js');
const validationEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER';
const validationFlagEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG';
const validationFlagContent = 'texra-cli-run-validation\n';

function run(command, args, options = {}) {
  const env = {
    ...process.env,
    CI: '1',
    ...options.env,
  };
  if (options.validationModel) {
    if (!options.validationFlagPath) {
      throw new Error('validationModel requires validationFlagPath');
    }
    env[validationEnv] = '1';
    env[validationFlagEnv] = options.validationFlagPath;
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
    signal: result.signal ?? '',
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSuccess(result, label) {
  assert(
    result.status === 0,
    `${label} failed with exit ${result.status}${result.signal ? ` signal ${result.signal}` : ''}${result.error ? ` error ${result.error}` : ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseNdjson(stdout, label) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length > 0, `${label} produced no NDJSON records`);
  return lines.map((line) => JSON.parse(line));
}

function validateBinarySmoke() {
  const help = run(process.execPath, [binaryPath, '--help']);
  assertSuccess(help, 'texra --help');
  assert(
    help.stdout.includes('TeXRA CLI'),
    'help output should name TeXRA CLI',
  );

  const version = run(process.execPath, [binaryPath, 'version']);
  assertSuccess(version, 'texra version');
  assert(
    version.stdout.trim().length > 0,
    'version output should be non-empty',
  );

  const agentsText = run(process.execPath, [binaryPath, 'agents', 'list']);
  assertSuccess(agentsText, 'texra agents list');
  assert(
    agentsText.stdout.trim().length > 0,
    'agents list should prove resource-backed agent loading',
  );

  const agentsNdjson = run(process.execPath, [
    binaryPath,
    '--output-format',
    'ndjson',
    'agents',
    'list',
  ]);
  assertSuccess(agentsNdjson, 'texra --output-format ndjson agents list');
  assert(
    parseNdjson(agentsNdjson.stdout, 'agents list NDJSON').every(
      (record) => record.kind === 'agent',
    ),
    'agents list NDJSON records should have kind=agent',
  );
}

function validateRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-run-'));
  try {
    const inputPath = path.join(cwd, 'paper.tex');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    writeFileSync(inputPath, '\\section{Input}\nOriginal text.\n');
    writeFileSync(validationFlagPath, validationFlagContent);

    const baseArgs = [
      binaryPath,
      'run',
      'polish',
      '--input',
      'paper.tex',
      '--output',
      'paper.polished.tex',
      '--cwd',
      cwd,
      '--approval-policy',
      'never',
      '--print',
    ];

    const text = run(process.execPath, baseArgs, {
      cwd: repoRoot,
      validationModel: true,
      validationFlagPath,
    });
    assertSuccess(text, 'texra run text');
    const copiedOutputPath = path.join(realpathSync(cwd), 'paper.polished.tex');
    const outputPathPattern = /^r\d+\/paper\.polished\.tex$/;
    assert(
      text.stdout.trim() === copiedOutputPath,
      'text run output should print the filesystem copy path when --output is used',
    );

    const json = run(
      process.execPath,
      [...baseArgs, '--output-format', 'json'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(json, 'texra run JSON');
    const jsonResult = JSON.parse(json.stdout);
    assert(
      jsonResult.category === 'workflow',
      'JSON run output should serialize the workflow result',
    );
    const finalOutput = jsonResult.outputs.at(-1);
    assert(
      outputPathPattern.test(finalOutput?.relativePath ?? ''),
      'JSON run output should report the run-storage output path',
    );
    assert(
      finalOutput.location === 'runStorage',
      'JSON run output should identify extracted output as run storage',
    );
    assert(
      jsonResult.runDirectory ===
        path.dirname(path.dirname(finalOutput.absolutePath)),
      'JSON run output should report the execution run directory',
    );
    assert(
      jsonResult.copiedOutput === copiedOutputPath,
      'JSON run output should report the filesystem copy path',
    );
    assert(
      readFileSync(finalOutput.absolutePath, 'utf8').includes(
        'Validated CLI Runtime',
      ),
      'texra run should write the validation output through the real workflow path',
    );

    const ndjson = run(
      process.execPath,
      [...baseArgs, '--output-format', 'ndjson'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(ndjson, 'texra run NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'run NDJSON').some(
        (record) => record.kind === 'result',
      ),
      'run NDJSON should include a result record',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

try {
  const buildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1' },
  });
  assertSuccess(buildResult, 'pnpm run build');
  validateBinarySmoke();
  validateRunCommand();
  console.log('CLI run validation passed');
} finally {
  const rebuildResult = run('pnpm', ['run', 'build'], { cwd: cliRoot });
  assertSuccess(rebuildResult, 'pnpm run build after validation');
}
