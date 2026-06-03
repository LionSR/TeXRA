#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
const validationBundleMarker = validationFlagContent.trim();
const ESC = String.fromCharCode(27);
const validationProviderApiKeyEnv = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'MINIMAX_API_KEY',
  'GLM_API_KEY',
];

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

function assertUsageError(result, label, expectedText) {
  assert(
    result.status === 2,
    `${label} should fail with usage exit 2, got ${result.status}${result.signal ? ` signal ${result.signal}` : ''}${result.error ? ` error ${result.error}` : ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert(
    `${result.stdout}\n${result.stderr}`.includes(expectedText),
    `${label} should include ${JSON.stringify(expectedText)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function formatUsage() {
  return [
    '[validate-run] usage: node scripts/validate-run.mjs [--no-build]',
    '',
    'Options:',
    '  --no-build  Reuse the existing dist/bin/texra.js validation bundle instead of rebuilding it',
    '  -h, --help  Show this help',
  ].join('\n');
}

function printUsage(stream = console.log) {
  stream(formatUsage());
}

function parseArgs(argv) {
  let noBuild = false;
  let endOfOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!endOfOptions && arg === '--') {
      // pnpm can forward a leading separator to scripts (`pnpm run x -- --flag`).
      // Treat that package-manager separator as transparent when it precedes a
      // script option; later `--` still follows normal end-of-options behavior.
      if (index === 0 && argv[1]?.startsWith('-')) continue;
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === '--help' || arg === '-h')) {
      printUsage();
      process.exit(0);
    }
    if (!endOfOptions && arg === '--no-build') {
      noBuild = true;
      continue;
    }
    console.error(`[validate-run] unknown argument: ${arg}`);
    printUsage(console.error);
    process.exit(2);
  }
  return { noBuild };
}

function preflightExistingValidationBundle() {
  if (!existsSync(binaryPath)) {
    console.error(
      `[validate-run] --no-build requires an existing CLI bundle: ${binaryPath}`,
    );
    console.error(
      '[validate-run] omit --no-build once to build the validation bundle.',
    );
    process.exit(1);
  }

  const bundle = readFileSync(binaryPath, 'utf8');
  if (!bundle.includes(validationBundleMarker)) {
    console.error(
      `[validate-run] --no-build requires ${binaryPath} to include the internal validation model.`,
    );
    console.error(
      '[validate-run] omit --no-build once, or run `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1 pnpm --filter @texra-ai/cli run build`.',
    );
    process.exit(1);
  }
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

function validateMultiAgentListAvailability() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-list-cwd-'));
  const home = mkdtempSync(path.join(tmpdir(), 'texra-cli-list-home-'));
  try {
    const env = Object.fromEntries(
      validationProviderApiKeyEnv.map((name) => [name, '']),
    );
    const listEnv = {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      TEXRA_NO_UPDATE_CHECK: '1',
    };
    const runList = (args = []) =>
      run(
        process.execPath,
        [
          binaryPath,
          'multi-agent',
          'list',
          '--cwd',
          cwd,
          ...args,
          '--no-color',
        ],
        {
          cwd: repoRoot,
          env: listEnv,
        },
      );

    const text = runList();
    assertSuccess(text, 'texra multi-agent list');
    const leanProjectLine = text.stdout
      .split('\n')
      .find((line) => line.includes('\tlean-project\t'));
    assert(
      leanProjectLine != null,
      `multi-agent list should include lean-project\nstdout:\n${text.stdout}`,
    );
    assert(
      /\ttool-use:\d+\/7\t(degraded|unavailable)(\t|$)/.test(leanProjectLine),
      `lean-project should show no-auth available/total tool-use availability\nline:\n${leanProjectLine}`,
    );
    assert(
      !leanProjectLine.includes('\ttool-use:7'),
      `lean-project should not claim the full preset is available without auth\nline:\n${leanProjectLine}`,
    );

    const json = runList(['--output-format', 'json']);
    assertSuccess(json, 'texra multi-agent list JSON');
    const jsonRecords = JSON.parse(json.stdout);
    const leanProjectJson = jsonRecords.find(
      (record) => record.id === 'lean-project',
    );
    const leanProjectAvailability = leanProjectJson?.availability;
    assert(
      leanProjectAvailability?.toolUse?.label != null,
      `multi-agent list JSON should include planned availability\nstdout:\n${json.stdout}`,
    );
    assert(
      leanProjectAvailability?.status === 'degraded' ||
        leanProjectAvailability?.status === 'unavailable',
      `lean-project JSON should report degraded or unavailable status\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );
    assert(
      leanProjectAvailability?.toolUse?.label !== '7',
      `lean-project JSON should not claim full tool-use availability\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );

    const ndjson = runList(['--output-format', 'ndjson']);
    assertSuccess(ndjson, 'texra multi-agent list NDJSON');
    const leanProjectNdjson = parseNdjson(
      ndjson.stdout,
      'multi-agent list NDJSON',
    ).find((record) => record.preset?.id === 'lean-project');
    assert(
      leanProjectNdjson?.preset?.availability?.toolUse?.label != null,
      `multi-agent list NDJSON should include planned availability\nstdout:\n${ndjson.stdout}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function validateFileFlagMissingValues() {
  assertUsageError(
    run(process.execPath, [binaryPath, 'run', 'polish', '--input', '--print']),
    'texra run missing --input value',
    'Missing value for --input',
  );
  assertUsageError(
    run(process.execPath, [binaryPath, 'run', 'polish', '-i', '-p']),
    'texra run missing -i value',
    'Missing value for -i',
  );
  assertUsageError(
    run(process.execPath, [
      binaryPath,
      'run',
      'polish',
      '--input',
      'paper.tex',
      '--output',
      '--print',
    ]),
    'texra run missing --output value',
    'Missing value for --output',
  );
  assertUsageError(
    run(process.execPath, [
      binaryPath,
      'agents',
      'run',
      'review',
      '--instruction-file',
      '--print',
    ]),
    'texra agents run missing --instruction-file value',
    'Missing value for --instruction-file',
  );
  assertUsageError(
    run(process.execPath, [
      binaryPath,
      'multi-agent',
      'run',
      'mathematician',
      '--input',
      '--print',
    ]),
    'texra multi-agent run missing --input value',
    'Missing value for --input',
  );
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;

  try {
    const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
    const helperPath = path.join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    if (!existsSync(helperPath)) return;

    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) chmodSync(helperPath, mode | 0o755);
  } catch {
    // node-pty will report the underlying PTY load/spawn failure below.
  }
}

function createInteractivePtyEnv(overrides = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    FORCE_COLOR: '3',
    TEXRA_NO_UPDATE_CHECK: '1',
    ...overrides,
  };
  // Exercise the same interactive path a real terminal uses. CI markers make
  // Ink switch render modes, which hides the behavior these PTY checks cover.
  delete env.CI;
  delete env.NO_COLOR;
  return env;
}

async function loadPtySpawn(label) {
  ensureNodePtySpawnHelperExecutable();
  const ptyMod = await import('node-pty');
  const ptySpawn = ptyMod.spawn ?? ptyMod.default?.spawn;
  assert(
    typeof ptySpawn === 'function',
    `node-pty should expose spawn for ${label}`,
  );
  return ptySpawn;
}

async function runTexraPty(args, options = {}) {
  const label = options.label ?? `texra ${args.join(' ')}`;
  const ptySpawn = await loadPtySpawn(label);
  const env = createInteractivePtyEnv(options.env);

  return await new Promise((resolve, reject) => {
    let output = '';
    let exited = false;
    let settled = false;
    const timers = new Set();

    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback();
    };
    const setTimer = (callback, delayMs) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!settled) callback();
      }, delayMs);
      timers.add(timer);
      return timer;
    };

    const child = ptySpawn(process.execPath, [binaryPath, ...args], {
      name: 'xterm-256color',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd ?? cliRoot,
      env,
    });

    const rejectWithKill = (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (!exited) {
        try {
          child.kill();
        } catch {}
      }
      reject(err);
    };

    const controller = {
      get output() {
        return output;
      },
      write(data) {
        if (exited || settled) return;
        try {
          child.write(data);
        } catch (err) {
          if (!exited) rejectWithKill(err);
        }
      },
      setTimer,
    };

    setTimer(() => {
      rejectWithKill(new Error(`${label} did not exit\noutput:\n${output}`));
    }, options.timeoutMs ?? 12_000);

    child.onData((data) => {
      output += data;
      try {
        options.onData?.(data, controller);
      } catch (err) {
        rejectWithKill(err);
      }
    });

    child.onExit((exit) => {
      exited = true;
      settle(() => resolve({ output, exit }));
    });

    try {
      options.onStart?.(controller);
    } catch (err) {
      rejectWithKill(err);
    }
  });
}

async function validateOrchestratePreservesScrollback() {
  let exitSent = false;
  let promptExitTimer;
  const sendExit = (pty) => {
    if (exitSent) return;
    exitSent = true;
    pty.write(ESC);
  };

  const result = await runTexraPty(['orchestrate'], {
    label: 'texra orchestrate',
    cwd: cliRoot,
    onStart: (pty) => {
      pty.setTimer(() => sendExit(pty), 4_000);
    },
    onData: (_data, pty) => {
      if (
        !exitSent &&
        promptExitTimer == null &&
        pty.output.includes('Choose how to start this CLI session')
      ) {
        promptExitTimer = pty.setTimer(() => sendExit(pty), 100);
      }
    },
  });

  assert(
    result.exit.exitCode === 0 && !result.exit.signal,
    `texra orchestrate Esc exit should succeed (exit ${result.exit.exitCode}, signal ${result.exit.signal || 'none'})`,
  );
  assert(
    result.output.includes(`${ESC}[2J`),
    'texra orchestrate should clear the visible launcher screen on exit',
  );
  assert(
    !result.output.includes(`${ESC}[3J`),
    'texra orchestrate should not erase terminal scrollback on exit',
  );
}

async function validateOrchestrateOnboardingPicker(options) {
  const root = mkdtempSync(path.join(tmpdir(), 'texra-cli-onboarding-'));
  try {
    const home = path.join(root, 'home');
    const env = Object.fromEntries(
      validationProviderApiKeyEnv.map((name) => [name, '']),
    );
    let exitSent = false;
    let welcomeExitTimer;
    const sendEsc = (pty) => {
      if (exitSent) return;
      exitSent = true;
      pty.write(ESC);
    };

    const result = await runTexraPty(options.args, {
      label: options.label,
      cwd: repoRoot,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_STATE_HOME: path.join(home, '.local/state'),
        ...env,
        ...options.env,
      },
      onData: (_data, pty) => {
        if (
          !exitSent &&
          welcomeExitTimer == null &&
          pty.output.includes('Welcome to TeXRA')
        ) {
          welcomeExitTimer = pty.setTimer(() => sendEsc(pty), 100);
        }
        if (
          !exitSent &&
          pty.output.includes('Choose how to start this CLI session')
        ) {
          exitSent = true;
          pty.write('\r');
        }
      },
    });

    assert(
      result.exit.exitCode === 0 && !result.exit.signal,
      `${options.label} should exit cleanly after Esc (exit ${result.exit.exitCode}, signal ${result.exit.signal || 'none'})\noutput:\n${result.output}`,
    );
    assert(
      result.output.includes('Welcome to TeXRA'),
      `${options.label} should show onboarding`,
    );
    assert(
      !result.output.includes('Choose how to start this CLI session'),
      `${options.label} should not show launcher actions before onboarding`,
    );
    assert(
      !result.output.includes('New chat'),
      `${options.label} should not offer New chat before onboarding`,
    );
    assert(
      !result.output.includes('Model "deepseekT" is not available'),
      `${options.label} should not fall through to model resolution`,
    );
    for (const text of options.expected) {
      assert(
        result.output.includes(text),
        `${options.label} should show ${JSON.stringify(text)}`,
      );
    }
    for (const text of options.forbidden) {
      assert(
        !result.output.includes(text),
        `${options.label} should not show ${JSON.stringify(text)}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function validateOrchestrateOnboardingPickers() {
  const oldTruncatedLabels = [
    'Sign in for included re…',
    'Use my own provider API…',
  ];

  await validateOrchestrateOnboardingPicker({
    label: 'texra orchestrate first-run onboarding',
    args: ['orchestrate'],
    env: {},
    expected: [
      'Not signed in, and no provider API key is configured. Choose how to power model calls:',
      'Included relay access',
      'Provider API key',
      'sign in, no API key needed (recommended)',
      'paste Anthropic / OpenAI / Google',
    ],
    forbidden: oldTruncatedLabels,
  });
  await validateOrchestrateOnboardingPicker({
    label: 'texra orchestrate included-mode onboarding',
    args: ['orchestrate', '--api-mode', 'included'],
    env: { ANTHROPIC_API_KEY: 'texra-validation-fake-key' },
    expected: [
      'Included relay access needs sign-in for this run:',
      'Included relay access',
      'sign in, no API key needed (recommended)',
    ],
    forbidden: [
      'Provider API key',
      'paste Anthropic / OpenAI / Google',
      ...oldTruncatedLabels,
    ],
  });
  await validateOrchestrateOnboardingPicker({
    label: 'texra orchestrate personal-mode onboarding',
    args: ['orchestrate', '--api-mode', 'personal'],
    env: {},
    expected: [
      'Personal API-key mode needs a provider key for this run:',
      'Provider API key',
      'paste Anthropic / OpenAI / Google',
    ],
    forbidden: [
      'Included relay access',
      'sign in, no API key needed',
      ...oldTruncatedLabels,
    ],
  });
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
    assert(
      text.stderr.includes(' · done ·'),
      `text run progress should end with a neutral done label\nstderr:\n${text.stderr}`,
    );
    assert(
      !text.stderr.includes(' · stopped ·'),
      `text run progress should not leak the internal stopped stream status\nstderr:\n${text.stderr}`,
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

function validateToolUseAgentRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-agent-run-'));
  try {
    const promptPath = path.join(cwd, 'review-prompt.md');
    const contextPath = path.join(cwd, 'pr.diff');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    writeFileSync(
      promptPath,
      'Review this change for mathematical and physical correctness.\n',
    );
    writeFileSync(
      contextPath,
      String.raw`diff --git a/paper.tex b/paper.tex
+\section{Validation}
`,
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const result = run(
      process.execPath,
      [
        binaryPath,
        'agents',
        'run',
        'review',
        '--instruction-file',
        'review-prompt.md',
        '--context',
        'pr.diff',
        '--cwd',
        cwd,
        '--approval-policy',
        'never',
        '--output-format',
        'json',
        '--print',
      ],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(result, 'texra agents run review JSON');

    const jsonResult = JSON.parse(result.stdout);
    assert(
      jsonResult.category === 'toolUse',
      'JSON agent run output should serialize the tool-use result',
    );
    assert(
      String(jsonResult.lastResponse ?? '').includes('Validated CLI Runtime'),
      'tool-use agent run should return the validation model response',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateMultiAgentRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-multi-agent-run-'));
  try {
    const inputPath = path.join(cwd, 'math-problem.md');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    writeFileSync(
      inputPath,
      'Problem: Prove that if n is odd, then n^2 is congruent to 1 modulo 8.\n',
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const baseArgs = [
      binaryPath,
      'multi-agent',
      'run',
      'mathematician',
      '--input',
      'math-problem.md',
      '--cwd',
      cwd,
      '--approval-policy',
      'never',
      '--print',
    ];

    const json = run(
      process.execPath,
      [...baseArgs, '--output-format', 'json'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(json, 'texra multi-agent run JSON');
    const jsonResult = JSON.parse(json.stdout);
    assert(
      jsonResult.preset?.id === 'mathematician',
      'multi-agent JSON output should identify the preset',
    );
    assert(
      typeof jsonResult.rootAgent === 'string' &&
        jsonResult.rootAgent.length > 0,
      'multi-agent run should select an available preset root agent',
    );
    assert(
      jsonResult.result?.category === 'toolUse',
      'multi-agent JSON output should serialize the tool-use result',
    );
    assert(
      String(jsonResult.result?.lastResponse ?? '').includes(
        'Validated CLI Runtime',
      ),
      'multi-agent run should return the validation model response',
    );

    const inlineInstruction = run(
      process.execPath,
      [
        binaryPath,
        'multi-agent',
        'run',
        'mathematician',
        '--instruction',
        'Prove that every odd square is congruent to 1 modulo 8.',
        '--cwd',
        cwd,
        '--approval-policy',
        'never',
        '--print',
        '--output-format',
        'json',
      ],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(inlineInstruction, 'texra multi-agent instruction-only JSON');
    const inlineJsonResult = JSON.parse(inlineInstruction.stdout);
    assert(
      inlineJsonResult.preset?.id === 'mathematician',
      'instruction-only multi-agent JSON output should identify the preset',
    );
    assert(
      inlineJsonResult.result?.category === 'toolUse',
      'instruction-only multi-agent JSON output should serialize the tool-use result',
    );
    assert(
      String(inlineJsonResult.result?.lastResponse ?? '').includes(
        'Validated CLI Runtime',
      ),
      'instruction-only multi-agent run should return the validation model response',
    );

    const ndjson = run(
      process.execPath,
      [...baseArgs, '--output-format', 'ndjson'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(ndjson, 'texra multi-agent run NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'multi-agent run NDJSON').some(
        (record) =>
          record.kind === 'multi-agent-result' &&
          record.preset?.id === 'mathematician' &&
          record.rootAgent === jsonResult.rootAgent,
      ),
      'multi-agent run NDJSON should include a preset result record with the selected root agent',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function validateCliRunArtifacts(options = {}) {
  if (options.noBuild) {
    preflightExistingValidationBundle();
  } else {
    const buildResult = run('pnpm', ['run', 'build'], {
      cwd: cliRoot,
      env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1' },
    });
    assertSuccess(buildResult, 'pnpm run build');
  }
  validateBinarySmoke();
  validateMultiAgentListAvailability();
  validateFileFlagMissingValues();
  await validateOrchestratePreservesScrollback();
  await validateOrchestrateOnboardingPickers();
  validateRunCommand();
  validateToolUseAgentRunCommand();
  validateMultiAgentRunCommand();
  console.log('CLI run validation passed');
}

function rebuildCliWithoutInternalValidationModel() {
  const rebuildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '' },
  });
  assertSuccess(rebuildResult, 'pnpm run build after validation');
}

const args = parseArgs(process.argv.slice(2));

try {
  await validateCliRunArtifacts(args);
} finally {
  if (!args.noBuild) {
    rebuildCliWithoutInternalValidationModel();
  }
}
