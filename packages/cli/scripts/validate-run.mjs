#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs as parseCittyArgs } from 'citty';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));
const require = createRequire(import.meta.url);
const defaultValidationRoot = path.join(cliRoot, '.texra-validate-run');
const defaultValidationBinaryPath = path.join(
  defaultValidationRoot,
  'bin',
  'texra.js',
);
const binaryPath = process.env.TEXRA_CLI_RUN_VALIDATOR_BINARY?.trim()
  ? path.resolve(process.env.TEXRA_CLI_RUN_VALIDATOR_BINARY)
  : defaultValidationBinaryPath;
const validationRoot = path.dirname(path.dirname(binaryPath));
const validationResourcesPath = path.join(validationRoot, 'resources');
const validationEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER';
const validationFlagEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG';
const validationFlagContent = 'texra-cli-run-validation\n';
const validationBundleMarker = validationFlagContent.trim();
const VALIDATION_FAKE_API_KEY = 'texra-validation-fake-key';
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
const validationModelProviderEnv = Object.fromEntries(
  validationProviderApiKeyEnv.map((name) => [name, VALIDATION_FAKE_API_KEY]),
);

function isolatedCliHomeEnv(home, overrides = {}) {
  return {
    ...Object.fromEntries(
      validationProviderApiKeyEnv.map((name) => [name, '']),
    ),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TEXRA_NO_UPDATE_CHECK: '1',
    ...overrides,
  };
}

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
    Object.assign(env, validationModelProviderEnv);
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

function readNamedFiles(root, name) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return readNamedFiles(entryPath, name);
    return entry.isFile() && entry.name === name
      ? [readFileSync(entryPath, 'utf8')]
      : [];
  });
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
    '  --no-build  Reuse the existing validator-only CLI bundle instead of rebuilding it',
    '  -h, --help  Show this help',
  ].join('\n');
}

function printUsage(stream = console.log) {
  stream(formatUsage());
}

const PARSE_ARGS_DEF = {
  help: { type: 'boolean', alias: 'h' },
  // citty's parser intercepts any `--no-X` token as negation of `X` before
  // the schema is even consulted, so a literal `noBuild: {type:'boolean'}`
  // can never observe `--no-build` (it lands on the nonexistent `build`
  // property instead). Modeling the positive form and negating it is the
  // only way citty's `--no-*` negation syntax can drive this flag.
  build: { type: 'boolean', default: true },
};
const KNOWN_FLAG_TOKENS = new Set(['--help', '-h', '--no-build']);

function parseArgs(argv) {
  // pnpm can forward a leading separator to scripts (`pnpm run x -- --flag`).
  // Treat that package-manager separator as transparent when it precedes a
  // script option; a later `--` still marks end-of-options below.
  const rest =
    argv[0] === '--' && argv[1]?.startsWith('-') ? argv.slice(1) : argv;

  // This script never accepts positional arguments, so anything at or past
  // an end-of-options `--` is unconditionally an error, same as an
  // unrecognized flag before it.
  const separatorIndex = rest.indexOf('--');
  const flagTokens =
    separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  const trailingToken =
    separatorIndex === -1 ? undefined : rest[separatorIndex + 1];

  const unknownToken =
    flagTokens.find((token) => !KNOWN_FLAG_TOKENS.has(token)) ?? trailingToken;
  if (unknownToken !== undefined) {
    console.error(`[validate-run] unknown argument: ${unknownToken}`);
    printUsage(console.error);
    process.exit(2);
  }

  let args;
  try {
    args = parseCittyArgs(flagTokens, PARSE_ARGS_DEF);
  } catch (error) {
    console.error(
      `[validate-run] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  return { noBuild: args.build === false };
}

function preflightExistingValidationBundle() {
  if (!existsSync(binaryPath)) {
    console.error(
      `[validate-run] --no-build requires an existing validator-only CLI bundle: ${binaryPath}`,
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
      '[validate-run] omit --no-build once so the validator can build its private bundle.',
    );
    process.exit(1);
  }

  if (!existsSync(validationResourcesPath)) {
    console.error(
      `[validate-run] --no-build requires validator resources: ${validationResourcesPath}`,
    );
    console.error(
      '[validate-run] omit --no-build once so the validator can copy its private resources.',
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

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} produced invalid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}`,
    );
  }
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
    const listEnv = isolatedCliHomeEnv(home);
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
      leanProjectAvailability?.agents?.toolUse?.label != null,
      `multi-agent list JSON should include planned availability\nstdout:\n${json.stdout}`,
    );
    assert(
      leanProjectAvailability?.status === 'degraded' ||
        leanProjectAvailability?.status === 'unavailable',
      `lean-project JSON should report degraded or unavailable status\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );
    assert(
      leanProjectAvailability?.agents?.toolUse?.label !== '7',
      `lean-project JSON should not claim full tool-use availability\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );

    const ndjson = runList(['--output-format', 'ndjson']);
    assertSuccess(ndjson, 'texra multi-agent list NDJSON');
    const leanProjectNdjson = parseNdjson(
      ndjson.stdout,
      'multi-agent list NDJSON',
    ).find((record) => record.preset?.id === 'lean-project');
    assert(
      leanProjectNdjson?.preset?.availability?.agents?.toolUse?.label != null,
      `multi-agent list NDJSON should include planned availability\nstdout:\n${ndjson.stdout}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function findToolRecord(records, id) {
  return records.find((record) => record.id === id);
}

function validateToolsCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-tools-cwd-'));
  const home = mkdtempSync(path.join(tmpdir(), 'texra-cli-tools-home-'));
  try {
    const env = isolatedCliHomeEnv(home);
    const runTools = (args) =>
      run(
        process.execPath,
        [binaryPath, 'tools', ...args, '--cwd', cwd, '--print', '--no-color'],
        { cwd: repoRoot, env },
      );

    const initial = runTools(['list', '--output-format', 'json']);
    assertSuccess(initial, 'texra tools list JSON');
    const records = parseJson(initial.stdout, 'tools list JSON');
    assert(Array.isArray(records), 'tools list JSON should be an array');
    const target = records.find(
      (record) => record.toggleable === true && record.comingSoon !== true,
    );
    assert(
      target,
      `tools list should include a toggleable integration\nstdout:\n${initial.stdout}`,
    );

    const disabled = runTools(['disable', target.id]);
    assertSuccess(disabled, `texra tools disable ${target.id}`);
    assert(
      disabled.stdout.includes(`Disabled ${target.id}.`),
      `tools disable should confirm the target id\nstdout:\n${disabled.stdout}`,
    );

    const afterDisable = runTools(['list', '--output-format', 'json']);
    assertSuccess(afterDisable, 'texra tools list JSON after disable');
    const disabledRecord = findToolRecord(
      parseJson(afterDisable.stdout, 'tools list JSON after disable'),
      target.id,
    );
    assert(
      disabledRecord?.enabled === false,
      `tools disable should persist enabled=false for ${target.id}\nstdout:\n${afterDisable.stdout}`,
    );

    const enabled = runTools(['enable', target.id]);
    assertSuccess(enabled, `texra tools enable ${target.id}`);
    assert(
      enabled.stdout.includes(`Enabled ${target.id}.`),
      `tools enable should confirm the target id\nstdout:\n${enabled.stdout}`,
    );

    const afterEnable = runTools(['list', '--output-format', 'json']);
    assertSuccess(afterEnable, 'texra tools list JSON after enable');
    const enabledRecord = findToolRecord(
      parseJson(afterEnable.stdout, 'tools list JSON after enable'),
      target.id,
    );
    assert(
      enabledRecord?.enabled === true,
      `tools enable should persist enabled=true for ${target.id}\nstdout:\n${afterEnable.stdout}`,
    );

    const ndjson = runTools(['list', '--output-format', 'ndjson']);
    assertSuccess(ndjson, 'texra tools list NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'tools list NDJSON').every(
        (record) => record.kind === 'tool-status',
      ),
      'tools list NDJSON records should have kind=tool-status',
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
        pty.output.includes('Start a session or configure model access')
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
        ...isolatedCliHomeEnv(home),
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
          pty.output.includes('Start a session or configure model access')
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
      !result.output.includes('Start a session or configure model access'),
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
  const truncatedOnboardingLabels = [
    ...oldTruncatedLabels,
    'Sign in — free for acad…',
    'Use ChatGPT subscription…',
    'Use your own provider A…',
  ];

  await validateOrchestrateOnboardingPicker({
    label: 'texra orchestrate first-run onboarding',
    args: ['orchestrate'],
    env: {},
    expected: [
      'Use ChatGPT subscription',
      'Use your own API keys',
      'Skip for now',
    ],
    forbidden: truncatedOnboardingLabels,
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
      text.stderr.includes(' · completed ·'),
      `text run progress should end with the shared completed label\nstderr:\n${text.stderr}`,
    );
    assert(
      !text.stderr.includes(' · stopped ·'),
      `a successful text run should not report the cancelled stopped label\nstderr:\n${text.stderr}`,
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
      String(jsonResult.response ?? '').includes('Validated CLI Runtime'),
      'tool-use agent run should return the validation model response',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateWorkflowScriptAgentRunCommand() {
  const cwd = mkdtempSync(
    path.join(tmpdir(), 'texra-cli-workflow-script-run-'),
  );
  try {
    const home = path.join(cwd, 'home');
    const globalStorage = path.join(home, '.texra', 'global-storage');
    const customAgents = path.join(globalStorage, 'custom_agents');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    mkdirSync(customAgents, { recursive: true });
    writeFileSync(
      path.join(globalStorage, 'state.json'),
      JSON.stringify({
        'texra.cli.bundledAgents.lastKnownVersion': 'validation',
      }),
    );
    writeFileSync(
      path.join(customAgents, 'workflow-script-validation.yaml'),
      `name: workflow_script_validation
description: Exercise workflow-script dispatch from the headless CLI.

settings:
  agentCategory: toolUse
  tools:
    - delegate_multi_agents

prompts:
  systemPrompt: |
    Call the requested workflow script exactly once, then finish.
  userRequest: |
    {{ INSTRUCTION }}
`,
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const result = run(
      process.execPath,
      [
        binaryPath,
        'agents',
        'run',
        'workflow_script_validation',
        '--model',
        'gpt56',
        '--instruction',
        'Solve the validation problems through workflow-script dispatch.',
        '--cwd',
        cwd,
        '--approval-policy',
        'never',
        '--output-format',
        'ndjson',
        '--print',
      ],
      {
        cwd: repoRoot,
        validationModel: true,
        validationFlagPath,
        env: isolatedCliHomeEnv(home, {
          TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT: '1',
        }),
      },
    );
    assertSuccess(result, 'texra agents run workflow script NDJSON');
    const records = parseNdjson(result.stdout, 'workflow-script run NDJSON');
    const workflowCompletedIndex = records.findIndex(
      (record) =>
        record.kind === 'progress' &&
        record.event === 'updateStreamStatus' &&
        record.payload?.streamId?.startsWith('workflow-script#') &&
        record.payload?.status === 'completed',
    );
    const parentResultIndex = records.findIndex(
      (record) => record.kind === 'agent-result',
    );
    assert(
      workflowCompletedIndex >= 0 && parentResultIndex > workflowCompletedIndex,
      'workflow-script run should wait for and return the terminal child report to the headless parent',
    );
    const reports = readNamedFiles(home, 'report.json').join('\n');
    assert(
      reports.includes('<workflow-script-result'),
      'workflow-script run should persist its terminal child report',
    );
    assert(
      reports.includes('(±23,±22)') &&
        reports.includes('det(I+A)=4') &&
        reports.includes('1/4'),
      'workflow-script run should contain all structured mathematical results',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateMultiAgentRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-multi-agent-run-'));
  // This preset has a local built-in delegating root; remote-catalog teams such as
  // mathematician are unavailable in signed-out validation environments.
  const validationPreset = 'software-engineer';
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
      validationPreset,
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
      jsonResult.preset?.id === validationPreset,
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
      String(jsonResult.result?.response ?? '').includes(
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
        validationPreset,
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
      inlineJsonResult.preset?.id === validationPreset,
      'instruction-only multi-agent JSON output should identify the preset',
    );
    assert(
      inlineJsonResult.result?.category === 'toolUse',
      'instruction-only multi-agent JSON output should serialize the tool-use result',
    );
    assert(
      String(inlineJsonResult.result?.response ?? '').includes(
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
          record.preset?.id === validationPreset &&
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
    buildValidationBundle();
  }
  validateBinarySmoke();
  validateMultiAgentListAvailability();
  validateToolsCommand();
  validateFileFlagMissingValues();
  await validateOrchestratePreservesScrollback();
  await validateOrchestrateOnboardingPickers();
  validateRunCommand();
  validateToolUseAgentRunCommand();
  validateWorkflowScriptAgentRunCommand();
  validateMultiAgentRunCommand();
  console.log('CLI run validation passed');
}

function runCliPackageScript(script, options = {}) {
  const result = run('pnpm', ['run', script], {
    cwd: cliRoot,
    env: options.env,
  });
  assertSuccess(result, `pnpm run ${script}`);
}

function buildValidationBundle() {
  runCliPackageScript('typecheck');
  runCliPackageScript('check:architecture');
  runCliPackageScript('smoke:react-compiler');
  runCliPackageScript('bundle', {
    env: {
      TEXRA_CLI_BUNDLE_OUTFILE: binaryPath,
      TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
    },
  });
  runCliPackageScript('copy:resources', {
    env: { TEXRA_CLI_RESOURCES_OUTDIR: validationResourcesPath },
  });
}

const args = parseArgs(process.argv.slice(2));

await validateCliRunArtifacts(args);
