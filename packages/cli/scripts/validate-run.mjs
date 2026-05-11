#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const cliRoot = path.dirname(dirnameFromMeta(import.meta.url));
const repoRoot = path.dirname(path.dirname(cliRoot));
const binaryPath = path.join(cliRoot, 'dist/bin/texra.js');

function dirnameFromMeta(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSuccess(result, label) {
  assert(
    result.status === 0,
    `${label} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function assertUsage(result, label) {
  assert(
    result.status === 64,
    `${label} should fail with usage exit 64, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
  const records = parseNdjson(agentsNdjson.stdout, 'agents list NDJSON');
  assert(
    records.every((record) => record.kind === 'agent'),
    'agents list NDJSON records should have kind=agent',
  );
}

async function buildRunHarness(tempDir) {
  const entryPath = path.join(tempDir, 'validate-run-harness.ts');
  const outputPath = path.join(tempDir, 'validate-run-harness.mjs');
  writeFileSync(
    entryPath,
    `
      import { DEFAULT_AGENT_MODEL, type AgentConfigPayload } from '@agent/core/AgentConfig';
      import { runCliWithDependencies } from '${pathToFileURL(path.join(cliRoot, 'src/commands/root.ts')).href}';

      const expected = JSON.parse(process.env.TEXRA_VALIDATE_EXPECTED ?? '{}') as {
        outputFormat?: 'text' | 'json' | 'ndjson';
        cwd?: string;
        approvalPolicy?: string;
        model?: string;
        instruction?: string;
      };

      const runtimeHost = {
        close: async () => undefined,
      } as any;

      const dependencies = {
        initPlatform: async () => undefined,
        installApprovalHandlers: () => undefined,
        loadAgents: async () => undefined,
        createRuntimeHost: () => runtimeHost,
        executeAgent: async (config: AgentConfigPayload, _token: unknown, options: { runtimeHost?: unknown }) => {
          if (options.runtimeHost !== runtimeHost) throw new Error('runtime host was not passed to executeAgent');
          if (config.agent !== 'polish') throw new Error('unexpected agent: ' + config.agent);
          if (config.inputFile !== 'paper.tex') throw new Error('unexpected input: ' + config.inputFile);
          if (config.outputFiles?.[0] !== 'paper.polished.tex') throw new Error('unexpected output file');
          if (config.workingDirectory !== expected.cwd) throw new Error('unexpected cwd: ' + config.workingDirectory);
          if (config.model !== (expected.model ?? DEFAULT_AGENT_MODEL)) throw new Error('unexpected model: ' + config.model);
          if (config.instruction !== (expected.instruction ?? '')) throw new Error('unexpected instruction: ' + config.instruction);
          return {
            category: 'workflow' as const,
            status: 'completed' as const,
            outputs: [
              {
                round: 1,
                relativePath: 'paper.polished.tex',
                absolutePath: '/tmp/paper.polished.tex',
                location: 'external' as const,
                originalPath: null,
                added: null,
                removed: null,
              },
            ],
            compileFailures: [],
            executionId: 'validation-execution',
            streamId: 'validation-stream',
          };
        },
      };

      const result = await runCliWithDependencies(process.argv.slice(2), dependencies);
      process.exitCode = result.exitCode;
    `,
  );

  await build({
    entryPoints: [entryPath],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    absWorkingDir: repoRoot,
    external: ['fsevents'],
    logLevel: 'silent',
  });
  return outputPath;
}

function runHarness(harnessPath, args, expected = {}) {
  const result = spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      TEXRA_VALIDATE_EXPECTED: JSON.stringify(expected),
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function validateRunCommand() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'texra-cli-run-'));
  try {
    const harnessPath = await buildRunHarness(tempDir);
    const cwd = tempDir;

    const baseArgs = [
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

    const text = runHarness(harnessPath, baseArgs, { cwd });
    assertSuccess(text, 'texra run text');
    assert(
      text.stdout.trim() === 'paper.polished.tex',
      'text run output should print the final output path',
    );

    const json = runHarness(
      harnessPath,
      [...baseArgs, '--output-format', 'json'],
      { cwd },
    );
    assertSuccess(json, 'texra run JSON');
    assert(
      JSON.parse(json.stdout).category === 'workflow',
      'JSON run output should serialize the workflow result',
    );

    const ndjson = runHarness(
      harnessPath,
      [...baseArgs, '--output-format', 'ndjson'],
      { cwd },
    );
    assertSuccess(ndjson, 'texra run NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'run NDJSON').some(
        (record) => record.kind === 'result',
      ),
      'run NDJSON should include a result record',
    );

    const emptyValues = runHarness(
      harnessPath,
      [...baseArgs, '--model=', '--instruction', '', '--output-format', 'json'],
      { cwd, instruction: '' },
    );
    assertSuccess(emptyValues, 'texra run empty value-bearing flags');

    const badFormat = runHarness(harnessPath, [
      ...baseArgs,
      '--output-format',
      'xml',
    ]);
    assertUsage(badFormat, 'texra run invalid output format');
    assert(
      badFormat.stderr.includes('Unsupported --output-format'),
      'invalid output format should explain the accepted formats',
    );

    const badPolicy = runHarness(harnessPath, [
      'run',
      'polish',
      '--input',
      'paper.tex',
      '--output',
      'paper.polished.tex',
      '--cwd',
      cwd,
      '--print',
      '--approval-policy',
      'sometimes',
    ]);
    assertUsage(badPolicy, 'texra run invalid approval policy');
    assert(
      badPolicy.stderr.includes('Unsupported --approval-policy'),
      'invalid approval policy should explain the accepted policies',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const buildResult = run('pnpm', ['run', 'build'], { cwd: cliRoot });
assertSuccess(buildResult, 'pnpm run build');
validateBinarySmoke();
await validateRunCommand();
console.log('CLI run validation passed');
