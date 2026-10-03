#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { stripVTControlCharacters } from 'node:util';
import { parseArgs as parseCittyArgs } from 'citty';

import { ensureNodePtySpawnHelperExecutable } from './nodePtySpawnHelper.mjs';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));
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
const validationEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL';
const validationFlagEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG';
const validationFlagContent = 'texra-cli-run-validation\n';
const validationFlagName = '.texra-internal-validation-model';
const validationBundleMarker = validationFlagContent.trim();
const VALIDATION_FAKE_API_KEY = 'texra-validation-fake-key';
const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3); // Ctrl-C
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
    // Its TeXRA data goes to a temporary home beside its flag file, never
    // the developer's ~/.texra, where each run left a store behind.
    if (options.env?.HOME === undefined) {
      const home = path.join(path.dirname(options.validationFlagPath), 'home');
      Object.assign(env, isolatedCliHomeEnv(home));
    }
    Object.assign(env, validationModelProviderEnv);
    env[validationEnv] = '1';
    env[validationFlagEnv] = options.validationFlagPath;
    // Every request the model sees must rebuild from the rows (#13394).
    env.TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT = '1';
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

function validateTeamListAvailability() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-list-cwd-'));
  const home = mkdtempSync(path.join(tmpdir(), 'texra-cli-list-home-'));
  try {
    const listEnv = isolatedCliHomeEnv(home);
    const runList = (args = []) =>
      run(
        process.execPath,
        [binaryPath, 'team', 'list', '--cwd', cwd, ...args, '--no-color'],
        {
          cwd: repoRoot,
          env: listEnv,
        },
      );

    const text = runList();
    assertSuccess(text, 'texra team list');
    const leanProjectLine = text.stdout
      .split('\n')
      .find((line) => line.includes('\tlean-project\t'));
    assert(
      leanProjectLine != null,
      `team list should include lean-project\nstdout:\n${text.stdout}`,
    );
    // The Lean agents ship bundled (#13080), so the preset is whole without
    // any sign-in: a full count and no degraded/unavailable marker.
    assert(
      /\ttool-use:7$/.test(leanProjectLine),
      `lean-project should show its bundled tool-use agents as available without auth\nline:\n${leanProjectLine}`,
    );

    const json = runList(['--output-format', 'json']);
    assertSuccess(json, 'texra team list JSON');
    const jsonRecords = JSON.parse(json.stdout);
    const leanProjectJson = jsonRecords.find(
      (record) => record.id === 'lean-project',
    );
    const leanProjectAvailability = leanProjectJson?.availability;
    assert(
      leanProjectAvailability?.agents?.toolUse?.label != null,
      `team list JSON should include planned availability\nstdout:\n${json.stdout}`,
    );
    const leanProjectToolUse = leanProjectAvailability?.agents?.toolUse;
    assert(
      leanProjectAvailability?.status === 'available' &&
        leanProjectToolUse?.available === 7 &&
        leanProjectToolUse?.total === 7 &&
        leanProjectToolUse?.missing?.length === 0,
      `lean-project JSON should report its bundled agents as available without auth\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );

    const ndjson = runList(['--output-format', 'ndjson']);
    assertSuccess(ndjson, 'texra team list NDJSON');
    const leanProjectNdjson = parseNdjson(
      ndjson.stdout,
      'team list NDJSON',
    ).find((record) => record.preset?.id === 'lean-project');
    assert(
      leanProjectNdjson?.preset?.availability?.agents?.toolUse?.label != null,
      `team list NDJSON should include planned availability\nstdout:\n${ndjson.stdout}`,
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
    const target = records.find((record) => record.toggleable === true);
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
      'run',
      'review',
      '--instruction-file',
      '--print',
    ]),
    'texra run missing --instruction-file value',
    'Missing value for --instruction-file',
  );
  assertUsageError(
    run(process.execPath, [
      binaryPath,
      'team',
      'run',
      'mathematician',
      '--input',
      '--print',
    ]),
    'texra team run missing --input value',
    'Missing value for --input',
  );
}

function createInteractivePtyEnv(overrides = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    FORCE_COLOR: '3',
    TEXRA_NO_UPDATE_CHECK: '1',
    TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT: '1',
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

async function validateChatOnboardingPicker(options) {
  const root = mkdtempSync(path.join(tmpdir(), 'texra-cli-onboarding-'));
  try {
    const home = path.join(root, 'home');
    let exitScheduled = false;
    // With no credential the chat still opens, the "Connect a model" panel on
    // top: Esc closes the panel into the chat, and Ctrl-C then exits the idle
    // chat. The second Ctrl-C covers a first one landing before the panel's
    // close repaints.
    const scheduleExit = (pty) => {
      exitScheduled = true;
      pty.setTimer(() => pty.write(ESC), 200);
      pty.setTimer(() => pty.write(ETX), 1_200);
      pty.setTimer(() => pty.write(ETX), 2_500);
    };

    const result = await runTexraPty(options.args, {
      label: options.label,
      cwd: repoRoot,
      timeoutMs: 30_000,
      env: {
        ...isolatedCliHomeEnv(home),
        ...options.env,
      },
      onData: (_data, pty) => {
        if (
          !exitScheduled &&
          pty.output.includes('Connect a model') &&
          pty.output.includes('No model connected')
        ) {
          scheduleExit(pty);
        }
      },
    });

    assert(
      result.exit.exitCode === 0 && !result.exit.signal,
      `${options.label} should exit cleanly after Esc and Ctrl-C (exit ${result.exit.exitCode}, signal ${result.exit.signal || 'none'})\noutput:\n${result.output}`,
    );
    assert(
      result.output.includes('Connect a model'),
      `${options.label} should open the chat with the connect-a-model panel`,
    );
    assert(
      !result.output.includes('is not available (missing api key)'),
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

async function validateChatOnboardingPickers() {
  const truncatedOnboardingLabels = [
    'Sign in for included re…',
    'Use my own provider API…',
    'Sign in — free for acad…',
    'Use ChatGPT subscription…',
    'Add a provider API key…',
  ];

  // Both the explicit subcommand and the bare command, because the bare form is
  // routed by `defaultRootSubcommand` in root.ts rather than by citty's own
  // dispatch. Only the process boundary can catch the route regressing to help,
  // to a removed subcommand, or to a model-resolution failure.
  const onboardingCases = [
    { label: 'texra chat first-run connect panel', args: ['chat'] },
    { label: 'bare texra first-run connect panel', args: [] },
  ];

  for (const { label, args } of onboardingCases) {
    await validateChatOnboardingPicker({
      label,
      args,
      env: {},
      expected: [
        'Use ChatGPT subscription',
        'Add a provider API key',
        'No model connected',
      ],
      forbidden: truncatedOnboardingLabels,
    });
  }
}

function validateRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-run-'));
  try {
    const inputPath = path.join(cwd, 'paper.tex');
    const validationFlagPath = path.join(cwd, validationFlagName);
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
    // The progress line prints the fold's status label from the one table in
    // src/shared/runs/runStatusDisplay.ts (RUN_STATUS_LABELS).
    assert(
      text.stderr.includes(' · Completed ·'),
      `text run progress should end with the shared completed label\nstderr:\n${text.stderr}`,
    );
    assert(
      !text.stderr.includes(' · Stopped ·'),
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
      jsonResult.output?.category === 'workflow',
      'JSON run output should serialize the workflow result',
    );
    const finalOutput = jsonResult.output.outputs.at(-1);
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
      'JSON run output should report the run directory',
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
    const validationFlagPath = path.join(cwd, validationFlagName);
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
    assertSuccess(result, 'texra run review JSON');

    const jsonResult = JSON.parse(result.stdout);
    assert(
      jsonResult.output?.category === 'toolUse',
      'JSON agent run output should serialize the tool-use result',
    );
    assert(
      String(jsonResult.output?.response ?? '').includes(
        'Validated CLI Runtime',
      ),
      'tool-use agent run should return the validation model response',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The executions `query` action end to end: a tool-use agent whose (canned)
 * model asks the run history one SQL question through the real tool schema,
 * the real session, and the history store's own process, spawned from this
 * binary. The NDJSON the run printed is kept as the artifact.
 */
function validateHistoryQueryRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-history-query-'));
  try {
    const home = path.join(cwd, 'home');
    const customAgents = path.join(
      home,
      '.texra',
      'v1',
      'global-storage',
      'custom_agents',
    );
    const validationFlagPath = path.join(cwd, validationFlagName);
    mkdirSync(customAgents, { recursive: true });
    writeFileSync(
      path.join(customAgents, 'history-query-validation.yaml'),
      `name: history_query_validation
description: Ask the run history one SQL question from the headless CLI.

settings:
  agentCategory: toolUse
  tools:
    - executions

prompts:
  systemPrompt: |
    Query the run history once, then report what it returned.
  userRequest: |
    {{ INSTRUCTION }}
`,
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const result = run(
      process.execPath,
      [
        binaryPath,
        'run',
        'history_query_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'List the runs in this project.',
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
          TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY: '1',
        }),
      },
    );
    const artifactDir = path.join(validationRoot, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, 'history-query-run.ndjson');
    writeFileSync(artifactPath, result.stdout);
    assertSuccess(result, 'texra run history query NDJSON');

    const records = parseNdjson(result.stdout, 'history query run NDJSON');
    const agentResult = records.find(
      (record) => record.kind === 'agent-result',
    );
    const response = String(agentResult?.result?.output?.response ?? '');
    assert(
      response.includes('name | kind | lifecycle') &&
        response.includes('history_query_validation | agent | activated'),
      `history query run should return the query page for its own run (artifact: ${artifactPath})\nresponse:\n${response}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * A project for the view-edit validators: an agent with no tools whose
 * (validation) model answers with the user messages it was shown, so each
 * reply is what the run's view held, and every request is rebuilt from the
 * rows. `config` is the project's `.texra/config.json`.
 */
function echoProject(cwd, config = null) {
  const home = path.join(cwd, 'home');
  const work = path.join(cwd, 'work');
  const customAgents = path.join(
    home,
    '.texra',
    'v1',
    'global-storage',
    'custom_agents',
  );
  const validationFlagPath = path.join(work, validationFlagName);
  mkdirSync(customAgents, { recursive: true });
  mkdirSync(path.join(work, '.texra'), { recursive: true });
  writeFileSync(
    path.join(customAgents, 'echo-validation.yaml'),
    `name: echo_validation
description: Say what the model was shown.

settings:
  agentCategory: toolUse
  tools: []

prompts:
  systemPrompt: |
    Say what you were shown.
  userRequest: |
    {{ INSTRUCTION }}
`,
  );
  writeFileSync(validationFlagPath, validationFlagContent);
  if (config !== null)
    writeFileSync(
      path.join(work, '.texra', 'config.json'),
      `${JSON.stringify(config)}\n`,
    );
  const env = isolatedCliHomeEnv(home, {
    TEXRA_INTERNAL_VALIDATE_ECHO: '1',
    TEXRA_NO_TELEMETRY: '1',
  });
  const ptyEnv = {
    ...env,
    ...validationModelProviderEnv,
    [validationEnv]: '1',
    [validationFlagEnv]: validationFlagPath,
  };
  const storage = path.join(home, '.texra', 'v1', 'workspace-storage');
  return {
    work,
    ptyEnv,
    /** A headless run of the agent on `instruction`: its run id. */
    firstRun: (instruction) => {
      const first = run(
        process.execPath,
        [
          binaryPath,
          'run',
          'echo_validation',
          '--model',
          'openai/gpt-5.6-sol',
          '--instruction',
          instruction,
          '--cwd',
          work,
          '--approval-policy',
          'never',
          '--output-format',
          'json',
          '--print',
        ],
        { cwd: work, validationModel: true, validationFlagPath, env },
      );
      assertSuccess(first, 'texra run echo_validation');
      return parseJson(first.stdout, 'echo run').runId;
    },
    /** One read of the project's store, closed again for the next writer. */
    readStore: (sql) => {
      const [project] = readdirSync(storage);
      const db = new DatabaseSync(path.join(storage, project, 'texra.db'), {
        readOnly: true,
      });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    },
    /**
     * `texra resume` with `args` under a PTY, then each exchange in turn:
     * its message typed once the chat idles (none: the resume itself starts
     * the turn), and its reply awaited. Exits once the last reply shows;
     * answers the run id the exit hint names.
     */
    chat: async (args, exchanges) => {
      let at = 0;
      let typed = false;
      let from = 0;
      let exiting = false;
      const result = await runTexraPty(['resume', ...args], {
        label: `texra resume ${args.join(' ')}`,
        cwd: work,
        cols: 160,
        rows: 40,
        timeoutMs: 40_000 * exchanges.length,
        env: ptyEnv,
        onData: (_data, pty) => {
          // One chunk can carry a reply and the next idle: take every step
          // the output already shows.
          while (!exiting) {
            const plain = stripVTControlCharacters(pty.output).slice(from);
            const exchange = exchanges[at];
            if (
              !typed &&
              (exchange.message === null || plain.includes('Idle'))
            ) {
              typed = true;
              if (exchange.message !== null) {
                pty.setTimer(() => pty.write(exchange.message), 500);
                pty.setTimer(() => pty.write('\r'), 900);
              }
            }
            if (!typed || !plain.includes(exchange.reply)) return;
            from += plain.indexOf(exchange.reply) + exchange.reply.length;
            at += 1;
            typed = false;
            if (at === exchanges.length) {
              exiting = true;
              pty.setTimer(() => pty.write(ETX), 800);
              pty.setTimer(() => pty.write(ETX), 2_000);
            }
          }
        },
      });
      const plain = stripVTControlCharacters(result.output);
      assert(
        result.exit.exitCode === 0 && at === exchanges.length,
        `texra resume ${args.join(' ')} should show ${JSON.stringify(exchanges.map(({ reply }) => reply))} and exit cleanly (exit ${result.exit.exitCode})\noutput:\n${plain.slice(-3000)}`,
      );
      return plain.match(/texra resume ([0-9a-f]{12})/)?.[1];
    },
  };
}

/** The `run.start` and `context.edit` rows of a store, kept as an artifact. */
const VIEW_ROWS = `SELECT s.logical_id AS run, e.seq, e.type,
     json_extract(e.data, '$.provenance') AS provenance,
     json_extract(e.data, '$.payload.cause') AS cause,
     json_extract(e.data, '$.payload.trigger') AS trigger,
     json_extract(e.data, '$.payload.range') AS range,
     json_array_length(e.data, '$.payload.messages') AS messages
   FROM event e JOIN event_sequence s ON s.id = e.aggregate
   WHERE e.type IN ('run.start', 'context.edit') ORDER BY e."commit"`;

function writeArtifact(name, value) {
  const artifactDir = path.join(validationRoot, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, name);
  writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
  return artifactPath;
}

/**
 * Fork, handoff and reset end to end (durable harness H5): a headless run
 * answers one message; `texra resume --fork` continues a new task holding
 * that conversation, `--handoff` continues it from a note alone, and
 * `--reset` from nothing. The store's `run.start` and `context.edit` rows
 * are kept as the artifact.
 */
async function validateForkResetHandoff() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-fork-'));
  try {
    const project = echoProject(cwd);
    const source = project.firstRun('First message');
    // The source's `turn.begin`: inside its turn, which a fork refuses.
    const [inside] = project.readStore(
      `SELECT e.seq FROM event e JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = '${source}' AND e.type = 'run.position'
         AND json_extract(e.data, '$.payload.at') = 'turn.begin'`,
    );
    const unsettled = await runTexraPty(
      ['resume', source, '--fork', '--at', String(inside.seq)],
      {
        label: 'texra resume --fork --at <turn.begin>',
        cwd: project.work,
        env: project.ptyEnv,
      },
    );
    assert(
      unsettled.exit.exitCode !== 0 &&
        stripVTControlCharacters(unsettled.output).includes(
          'A fork starts at a settled point',
        ),
      `a fork inside a turn should be refused\noutput:\n${unsettled.output}`,
    );
    const replies = [
      'First message | Second message',
      'Model saw: Handoff note',
      'Model saw: After reset',
    ];
    const fork = await project.chat(
      [source, '--fork'],
      [{ message: 'Second message', reply: replies[0] }],
    );
    assert(fork && fork !== source, 'the fork should continue a new task');
    await project.chat(
      [fork, '--handoff', 'Handoff note'],
      [{ message: null, reply: replies[1] }],
    );
    await project.chat(
      [fork, '--reset'],
      [{ message: 'After reset', reply: replies[2] }],
    );

    const rows = project.readStore(VIEW_ROWS);
    const artifactPath = writeArtifact('fork-reset-handoff.json', {
      source,
      fork,
      replies,
      rows,
    });
    const forkStart = rows.find(
      (row) => row.run === fork && row.type === 'run.start',
    );
    const provenance = JSON.parse(forkStart?.provenance ?? 'null');
    const causes = rows
      .filter((row) => row.run === fork && row.type === 'context.edit')
      .map((row) => row.cause);
    assert(
      provenance?.kind === 'fork' && provenance.from.id === source,
      `the fork's run.start should name its source (artifact: ${artifactPath})`,
    );
    assert(
      causes.join() === 'fork,handoff,reset',
      `the fork should record its seed, the handoff and the reset as context.edit rows, got ${causes.join()} (artifact: ${artifactPath})`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Background compaction end to end (durable harness H5, gap 4): at a 1%
 * threshold, a long first message puts the conversation over it. The
 * resumed chat's next turn starts the summary off the loop and still sends
 * the whole history (the reply names the first message), and the turn
 * after lands it, as an edit of the messages before that turn's request,
 * keeping what followed (the reply names the summary and the new message
 * only). The store's `context.edit` rows are kept as the artifact.
 */
async function validateBackgroundCompaction() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-compaction-'));
  try {
    const project = echoProject(cwd, {
      'texra.model.compactionThresholdPercent': 1,
    });
    const source = project.firstRun(`${'filler '.repeat(8_000)}First message`);
    const replies = [
      'First message | Second message',
      'Earlier turns, summarized. | Third message',
    ];
    await project.chat(
      [source],
      [
        { message: 'Second message', reply: replies[0] },
        { message: 'Third message', reply: replies[1] },
      ],
    );
    const rows = project.readStore(VIEW_ROWS);
    const artifactPath = writeArtifact('background-compaction.json', {
      source,
      replies,
      rows,
    });
    const edits = rows.filter((row) => row.type === 'context.edit');
    assert(
      edits.length === 1 &&
        edits[0].cause === 'compaction' &&
        edits[0].trigger === 'context-limit' &&
        JSON.parse(edits[0].range).to === 3,
      `the summary should land as one edit of the three messages before the second turn's request (artifact: ${artifactPath})`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateScriptFanoutRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-script-fanout-run-'));
  try {
    const home = path.join(cwd, 'home');
    const globalStorage = path.join(home, '.texra', 'v1', 'global-storage');
    const customAgents = path.join(globalStorage, 'custom_agents');
    const validationFlagPath = path.join(cwd, validationFlagName);
    mkdirSync(customAgents, { recursive: true });
    writeFileSync(
      path.join(customAgents, 'script-fanout-validation.yaml'),
      `name: script_fanout_validation
description: Exercise a script's agent fan-out from the headless CLI.

settings:
  agentCategory: toolUse
  tools:
    - script
    - agent

prompts:
  systemPrompt: |
    Run the requested script exactly once, then finish.
  userRequest: |
    {{ INSTRUCTION }}
`,
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const result = run(
      process.execPath,
      [
        binaryPath,
        'run',
        'script_fanout_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'Solve the validation problems through a script fan-out.',
        '--cwd',
        cwd,
        // A script's agent request is an approval request, and `never`
        // denies it like every other kind (#13376); `yolo` is the explicit
        // grant a headless run needs to launch the children at all.
        '--approval-policy',
        'yolo',
        '--output-format',
        'ndjson',
        '--print',
      ],
      {
        cwd: repoRoot,
        validationModel: true,
        validationFlagPath,
        env: isolatedCliHomeEnv(home, {
          TEXRA_INTERNAL_VALIDATE_SCRIPT_FANOUT: '1',
        }),
      },
    );
    assertSuccess(result, 'texra run script fan-out NDJSON');
    const records = parseNdjson(result.stdout, 'script fan-out run NDJSON');
    assert(
      records.every((record) => record.contract === 2),
      'every NDJSON line should carry the version-2 contract stamp',
    );
    // A progress record carries the session row: its run is the `run`
    // aggregate key, `["run", <run id>]`.
    const runIdOf = (record) => {
      const [kind, id] = JSON.parse(record.payload.aggregateId);
      return kind === 'run' ? id : undefined;
    };
    // A run id is opaque: the script's children are the child rows its
    // parent reports, never names parsed out of an id.
    const childIds = new Set(
      records.flatMap((record) =>
        record.kind === 'progress' && record.event === 'run.children'
          ? (record.payload?.children ?? []).map((child) => child.childRunId)
          : [],
      ),
    );
    const completedChildren = records.flatMap((record, index) =>
      record.kind === 'progress' &&
      record.event === 'run.end' &&
      childIds.has(runIdOf(record)) &&
      record.payload?.outcome === 'completed'
        ? [index]
        : [],
    );
    const parentResultIndex = records.findIndex(
      (record) => record.kind === 'agent-result',
    );
    assert(
      completedChildren.length === 3 &&
        completedChildren.every((index) => index < parentResultIndex),
      'the script should await its three children before the headless parent returns',
    );
    const response = String(
      records[parentResultIndex]?.result?.output?.response ?? '',
    );
    assert(
      response.includes('(±23,±22)') &&
        response.includes('det(I+A)=4') &&
        response.includes('1/4'),
      `the script result should carry all structured mathematical results\nresponse:\n${response}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateTeamRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-team-run-'));
  // A preset whose members are all tool-use agents keeps this check cheap.
  const validationPreset = 'software-engineer';
  try {
    const inputPath = path.join(cwd, 'math-problem.md');
    const validationFlagPath = path.join(cwd, validationFlagName);
    writeFileSync(
      inputPath,
      'Problem: Prove that if n is odd, then n^2 is congruent to 1 modulo 8.\n',
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const baseArgs = [
      binaryPath,
      'team',
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
    assertSuccess(json, 'texra team run JSON');
    const jsonResult = JSON.parse(json.stdout);
    assert(
      jsonResult.preset?.id === validationPreset,
      'team JSON output should identify the preset',
    );
    assert(
      typeof jsonResult.rootAgent === 'string' &&
        jsonResult.rootAgent.length > 0,
      'team run should select an available preset root agent',
    );
    assert(
      jsonResult.result?.output?.category === 'toolUse',
      'team JSON output should serialize the tool-use result',
    );
    assert(
      String(jsonResult.result?.output?.response ?? '').includes(
        'Validated CLI Runtime',
      ),
      'team run should return the validation model response',
    );

    const inlineInstruction = run(
      process.execPath,
      [
        binaryPath,
        'team',
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
    assertSuccess(inlineInstruction, 'texra team instruction-only JSON');
    const inlineJsonResult = JSON.parse(inlineInstruction.stdout);
    assert(
      inlineJsonResult.preset?.id === validationPreset,
      'instruction-only team JSON output should identify the preset',
    );
    assert(
      inlineJsonResult.result?.output?.category === 'toolUse',
      'instruction-only team JSON output should serialize the tool-use result',
    );
    assert(
      String(inlineJsonResult.result?.output?.response ?? '').includes(
        'Validated CLI Runtime',
      ),
      'instruction-only team run should return the validation model response',
    );

    const ndjson = run(
      process.execPath,
      [...baseArgs, '--output-format', 'ndjson'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(ndjson, 'texra team run NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'team run NDJSON').some(
        (record) =>
          record.kind === 'team-result' &&
          record.preset?.id === validationPreset &&
          record.rootAgent === jsonResult.rootAgent,
      ),
      'team run NDJSON should include a preset result record with the selected root agent',
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
  validateTeamListAvailability();
  validateToolsCommand();
  validateFileFlagMissingValues();
  await validateChatOnboardingPickers();
  validateRunCommand();
  validateToolUseAgentRunCommand();
  validateHistoryQueryRunCommand();
  await validateForkResetHandoff();
  await validateBackgroundCompaction();
  validateScriptFanoutRunCommand();
  validateTeamRunCommand();
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
