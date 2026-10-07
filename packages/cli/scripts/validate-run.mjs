#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
// The editor-less window the host-call validation attaches to the service.
const hostHarnessPath = path.join(
  path.dirname(binaryPath),
  'service-host-harness.js',
);
// The same CLI stamped as a newer build: what a client of a later release
// finds when an older build's service runs.
const NEXT_BUILD = '999.0.0';
const nextBuildPath = path.join(path.dirname(binaryPath), 'texra-next.js');
// An SDK embedder on the validation model (scripts/sdk-harness.ts).
const sdkHarnessPath = path.join(path.dirname(binaryPath), 'sdk-harness.js');
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
    ...(options.input === undefined ? {} : { input: options.input }),
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

/** Poll `check` until it holds, failing the scenario after `timeoutMs`. */
async function waitFor(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
  const cwd = makeScratch('texra-cli-list-cwd-');
  const home = makeScratch('texra-cli-list-home-');
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
      /\tagents:7$/.test(leanProjectLine),
      `lean-project should show its bundled agents as available without auth\nline:\n${leanProjectLine}`,
    );

    const json = runList(['--output-format', 'json']);
    assertSuccess(json, 'texra team list JSON');
    const jsonRecords = JSON.parse(json.stdout);
    const leanProjectJson = jsonRecords.find(
      (record) => record.id === 'lean-project',
    );
    const leanProjectAvailability = leanProjectJson?.availability;
    assert(
      leanProjectAvailability?.agents?.label != null,
      `team list JSON should include planned availability\nstdout:\n${json.stdout}`,
    );
    const leanProjectAgents = leanProjectAvailability?.agents;
    assert(
      leanProjectAvailability?.status === 'available' &&
        leanProjectAgents?.available === 7 &&
        leanProjectAgents?.total === 7 &&
        leanProjectAgents?.missing?.length === 0,
      `lean-project JSON should report its bundled agents as available without auth\nrecord:\n${JSON.stringify(leanProjectJson, null, 2)}`,
    );

    const ndjson = runList(['--output-format', 'ndjson']);
    assertSuccess(ndjson, 'texra team list NDJSON');
    const leanProjectNdjson = parseNdjson(
      ndjson.stdout,
      'team list NDJSON',
    ).find((record) => record.preset?.id === 'lean-project');
    assert(
      leanProjectNdjson?.preset?.availability?.agents?.label != null,
      `team list NDJSON should include planned availability\nstdout:\n${ndjson.stdout}`,
    );
  } finally {
    removeScratch(cwd);
    removeScratch(home);
  }
}

function findToolRecord(records, id) {
  return records.find((record) => record.id === id);
}

function validateToolsCommand() {
  const cwd = makeScratch('texra-cli-tools-cwd-');
  const home = makeScratch('texra-cli-tools-home-');
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
    removeScratch(cwd);
    removeScratch(home);
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
    liveChildren.add(child);

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
      kill(signal) {
        if (!exited) child.kill(signal);
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
      liveChildren.delete(child);
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
  const root = makeScratch('texra-cli-onboarding-');
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
    removeScratch(root);
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
  const cwd = makeScratch('texra-cli-run-');
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
    // packages/harness/src/shared/runs/runStatusDisplay.ts (RUN_STATUS_LABELS).
    assert(
      text.stderr.includes(' · Completed ·'),
      `text run progress should end with the shared completed label\nstderr:\n${text.stderr}`,
    );
    assert(
      !text.stderr.includes(' · Stopped ·'),
      `a successful text run should not report the cancelled stopped label\nstderr:\n${text.stderr}`,
    );

    // Opt-in reflection: the bundled critic reviews revision 1, and revision
    // 2 reads its critique.
    const reflected = run(process.execPath, [...baseArgs, '--reflect'], {
      cwd: repoRoot,
      validationModel: true,
      validationFlagPath,
    });
    assertSuccess(reflected, 'texra run --reflect');
    assert(
      reflected.stderr.includes('Critique 1 · critic'),
      `a --reflect run should call the critic between revisions\nstderr:\n${reflected.stderr}`,
    );

    const json = run(
      process.execPath,
      [...baseArgs, '--output-format', 'json'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(json, 'texra run JSON');
    const jsonResult = JSON.parse(json.stdout);
    assert(
      jsonResult.output?.documents != null,
      'JSON run output should serialize the document task result',
    );
    const finalOutput = jsonResult.output.documents.outputs.at(-1);
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
    removeScratch(cwd);
  }
}

function validateToolUseAgentRunCommand() {
  const cwd = makeScratch('texra-cli-agent-run-');
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
      jsonResult.output != null && jsonResult.output.documents === undefined,
      'JSON agent run output should serialize the chat result',
    );
    assert(
      String(jsonResult.output?.response ?? '').includes(
        'Validated CLI Runtime',
      ),
      'agent run should return the validation model response',
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * The executions `query` action end to end: an agent whose (canned)
 * model asks the run history one SQL question through the real tool schema,
 * the real session, and the history store's own process, spawned from this
 * binary. The NDJSON the run printed is kept as the artifact.
 */
function validateHistoryQueryRunCommand() {
  const cwd = makeScratch('texra-cli-history-query-');
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

tools:
  - executions
prompt: |
  Query the run history once, then report what it returned.
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
    removeScratch(cwd);
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

prompt: |
  Say what you were shown.
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
      // The project's store: a service also keeps a no-workspace one.
      const project = readdirSync(storage).find((name) =>
        name.startsWith('work-'),
      );
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
      let exitSent = false;
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
            if (at === exchanges.length) exiting = true;
          }
          // Exit once the last turn is over: a reply can show before its
          // turn ends, and a Ctrl-C then stops the turn instead.
          if (
            exiting &&
            !exitSent &&
            stripVTControlCharacters(pty.output).slice(from).includes('Idle')
          ) {
            exitSent = true;
            pty.setTimer(() => pty.write(ETX), 800);
            pty.setTimer(() => pty.write(ETX), 2_000);
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

/**
 * Remove a scratch directory, first stopping any TeXRA service a chat in it
 * started: its record names its pid, and a conversation parked there would
 * otherwise keep it running after its home is gone.
 */
/** The scratch directories made and not yet removed: what an exit or a
 *  signal before a scenario's own cleanup still has to remove. */
const liveScratch = new Set();

/** A scratch directory under the system temp folder, removed (with any
 *  service started in it) by its scenario or, failing that, at exit. */
function makeScratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  liveScratch.add(dir);
  return dir;
}

/** The PTY clients running now: killed before an exit removes the
 *  scratch they write to. */
const liveChildren = new Set();

process.on('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Exited already.
    }
  }
  for (const dir of liveScratch) removeScratch(dir);
});
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => process.exit(code));
}

function removeScratch(dir) {
  liveScratch.delete(dir);
  // Every service home under `dir`; one still starting has its run
  // directory before its record, so its record is waited for briefly.
  const runDirs = spawnSync(
    'find',
    [dir, '-type', 'd', '-path', '*/.texra/run'],
    { encoding: 'utf8' },
  );
  for (const runDir of runDirs.stdout.split('\n').filter(Boolean)) {
    const record = path.join(runDir, 'serve.json');
    for (let waited = 0; !existsSync(record) && waited < 3_000; waited += 100)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    // The record names the current service; a retired one still draining
    // is named only by its own `serve-<pid>.sock`.
    const pids = new Set(
      readdirSync(runDir).flatMap((name) => {
        const match = /^serve-(\d+)\.sock$/.exec(name);
        return match ? [Number(match[1])] : [];
      }),
    );
    try {
      pids.add(JSON.parse(readFileSync(record, 'utf8')).pid);
    } catch {
      // No record: the service never started, or its sockets name it.
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Gone already: nothing left to stop.
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeArtifact(name, value) {
  const artifactDir = path.join(validationRoot, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, name);
  writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
  return artifactPath;
}

/**
 * A plugin's `Stop` hook as a quality gate: a headless `texra run` whose
 * hook blocks the first stop goes on for one more turn with the hook's
 * reason as its instruction (the echo model's reply shows it), and the stop
 * after it, told `stop_hook_active: true`, lets the run end. The reply and
 * the run's `hook.outcome` rows are the artifact.
 */
function validateStopHookBlock() {
  const cwd = makeScratch('texra-cli-stop-hook-');
  try {
    const project = echoProject(cwd);
    const plugin = path.join(cwd, 'stopgate');
    mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    writeFileSync(
      path.join(plugin, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'stopgate', version: '1.0.0' })}\n`,
    );
    writeFileSync(
      path.join(plugin, 'hooks', 'hooks.json'),
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node',
                  args: ['${CLAUDE_PLUGIN_ROOT}/stop.mjs'],
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      path.join(plugin, 'stop.mjs'),
      `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (!input.stop_hook_active)
  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Stop gate: check the answer once more.' }));
`,
    );
    const cli = (args, label, input) => {
      const result = run(process.execPath, [binaryPath, ...args], {
        cwd: project.work,
        env: project.ptyEnv,
        input,
      });
      assertSuccess(result, label);
      return result;
    };
    cli(['plugin', 'install', plugin], 'texra plugin install');
    cli(['plugin', 'enable', 'stopgate'], 'texra plugin enable', 'y\n');
    const result = cli(
      [
        'run',
        'echo_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'First message',
        '--cwd',
        project.work,
        '--approval-policy',
        'never',
        '--output-format',
        'json',
        '--print',
      ],
      'texra run echo_validation with a Stop hook',
    );
    const response = String(
      parseJson(result.stdout, 'stop hook run').output?.response ?? '',
    );
    const outcomes = project.readStore(
      `SELECT json_extract(e.data, '$.payload.point') AS point,
         json_extract(e.data, '$.payload.status') AS status,
         json_extract(e.data, '$.payload.context') AS context,
         json_extract(e.data, '$.payload.ignored') AS ignored
       FROM event e WHERE e.type = 'hook.outcome' ORDER BY e."commit"`,
    );
    const artifactPath = writeArtifact('stop-hook-block.json', {
      response,
      outcomes,
    });
    assert(
      response.includes('First message') &&
        response.includes('Stop gate: check the answer once more.'),
      `the run should go on with the Stop hook's reason as its next instruction (artifact: ${artifactPath})\nresponse: ${response}`,
    );
    assert(
      outcomes.length === 2 &&
        outcomes[0].context?.includes('Stop gate') &&
        outcomes[1].context === null &&
        outcomes[1].ignored === '[]',
      `the first stop should block and the second, after the block's turn, should let the run end (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * An SDK run of an inline persona (`StartInput.agent` as an object): the
 * embedder writes no agent file, the echo model's reply shows the
 * instruction reached a run of that persona, and the session view names the
 * run by the persona. The reply and the run's identity are the artifact.
 */
function validateSdkInlinePersona() {
  const cwd = makeScratch('texra-sdk-inline-persona-');
  try {
    const home = path.join(cwd, 'home');
    const work = path.join(cwd, 'work');
    mkdirSync(work, { recursive: true });
    const validationFlagPath = path.join(work, validationFlagName);
    writeFileSync(validationFlagPath, validationFlagContent);
    const result = run(
      process.execPath,
      [
        sdkHarnessPath,
        work,
        path.join(cwd, 'storage'),
        'inline',
        'Inline persona message',
      ],
      {
        cwd: work,
        validationModel: true,
        validationFlagPath,
        env: isolatedCliHomeEnv(home, { TEXRA_INTERNAL_VALIDATE_ECHO: '1' }),
      },
    );
    assertSuccess(result, 'the SDK harness');
    // The embedder's own log lines come first; its answer is the last line.
    const { result: ended, identity } = parseJson(
      result.stdout.trim().split('\n').at(-1),
      'SDK harness',
    );
    const response = String(ended?.output?.response ?? '');
    const artifactPath = writeArtifact('sdk-inline-persona.json', {
      outcome: ended?.outcome,
      response,
      identity,
    });
    assert(
      ended?.outcome === 'completed' &&
        response === 'Model saw: Inline persona message' &&
        identity?.agent === 'inline_echo',
      `the inline persona's run should complete with the echoed instruction under the persona's name (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * An SDK approval that outlives its process: an embedder on a persistent
 * session starts a run whose custom tool asks for approval, and its handler
 * receives the request and leaves it pending; the process is killed there.
 * A second embedder reopens the session's store, resumes the run with the
 * same custom tool, and its handler approves the same request, so the tool
 * runs once and the run completes. Both phases' output, the run's request
 * and tool rows and the file the tool wrote are the artifact.
 */
async function validateSdkResumeApproval() {
  const cwd = makeScratch('texra-sdk-resume-');
  try {
    const home = path.join(cwd, 'home');
    const work = path.join(cwd, 'work');
    const storage = path.join(cwd, 'storage');
    mkdirSync(work, { recursive: true });
    const validationFlagPath = path.join(work, validationFlagName);
    writeFileSync(validationFlagPath, validationFlagContent);
    const golden = { TEXRA_INTERNAL_VALIDATE_GOLDEN: '1' };
    const asking = spawn(
      process.execPath,
      [sdkHarnessPath, work, storage, 'ask', 'Run the command'],
      {
        cwd: work,
        env: {
          ...process.env,
          CI: '1',
          ...isolatedCliHomeEnv(home, golden),
          ...validationModelProviderEnv,
          [validationEnv]: '1',
          [validationFlagEnv]: validationFlagPath,
          TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT: '1',
        },
      },
    );
    liveChildren.add(asking);
    let asked = '';
    asking.stdout.on('data', (chunk) => (asked += chunk));
    asking.stderr.on('data', () => {});
    const exited = new Promise((resolve) => asking.on('close', resolve));
    const line = (key) =>
      asked
        .split('\n')
        .filter((text) => text.startsWith(`{"${key}"`))
        .map((text) => JSON.parse(text)[key])
        .at(0);
    await waitFor('the SDK approval handler to be asked', () => line('asked'));
    asking.kill('SIGKILL');
    await exited;
    liveChildren.delete(asking);
    const runId = line('started');
    const resumed = run(
      process.execPath,
      [sdkHarnessPath, work, storage, 'resume', runId],
      {
        cwd: work,
        validationModel: true,
        validationFlagPath,
        env: isolatedCliHomeEnv(home, golden),
      },
    );
    assertSuccess(resumed, 'the resuming SDK harness');
    const { answered, result } = parseJson(
      resumed.stdout.trim().split('\n').at(-1),
      'resuming SDK harness',
    );
    // The workspace's store: the global one beside it holds no runs.
    const store = spawnSync(
      'find',
      [storage, '-path', '*/workspace-storage/*', '-name', 'texra.db'],
      { encoding: 'utf8' },
    ).stdout.trim();
    const db = new DatabaseSync(store, { readOnly: true });
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT e.type, json_extract(e.data, '$.requestId') AS requestId,
             json_extract(e.data, '$.decision.action') AS decision,
             json_extract(e.data, '$.payload.callId') AS callId
           FROM event e JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? AND e.type IN
             ('request.opened', 'request.decided', 'tool.result', 'run.end')
           ORDER BY e."commit"`,
        )
        .all(runId);
    } finally {
      db.close();
    }
    const approvedPath = path.join(work, 'approved.txt');
    const approved = existsSync(approvedPath)
      ? readFileSync(approvedPath, 'utf8')
      : null;
    // Ids differ per run, so the artifact names each request by whether
    // it is the one asked before the kill: the file diffs across runs.
    const { requestId: askedId, kind } = line('asked');
    const sameRequest = (row) =>
      row.requestId === null ? null : row.requestId === askedId;
    const artifactPath = writeArtifact('sdk-resume-approval.json', {
      asked: kind,
      answered: answered.map((request) => ({
        kind: request.kind,
        sameRequest: sameRequest(request),
      })),
      outcome: result?.outcome,
      response: result?.output?.response,
      rows: rows.map((row) => ({
        type: row.type,
        sameRequest: sameRequest(row),
        decision: row.decision,
        callId: row.callId,
      })),
      approved,
    });
    const requests = rows.filter((row) => row.requestId !== null);
    assert(
      answered.length === 1 &&
        sameRequest(answered[0]) &&
        requests.length === 2 &&
        requests.every(sameRequest) &&
        requests[1].type === 'request.decided' &&
        requests[1].decision === 'approve',
      `the resumed run's one request should be the one asked before the kill, approved after it (artifact: ${artifactPath})`,
    );
    assert(
      result?.outcome === 'completed' &&
        result?.output?.response === 'The approved command ran.' &&
        rows.some(
          (row) =>
            row.type === 'tool.result' &&
            row.callId === 'validation-record_approval-1',
        ) &&
        approved === 'approved\n',
      `the resumed run should run the embedder's approved tool once and complete (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * Fork, handoff and reset end to end (durable harness H5): a headless run
 * answers one message; `texra resume --fork` continues a new task holding
 * that conversation, `--handoff` continues it from a note alone, and
 * `--reset` from nothing. The store's `run.start` and `context.edit` rows
 * are kept as the artifact.
 */
async function validateForkResetHandoff() {
  const cwd = makeScratch('texra-cli-fork-');
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
    removeScratch(cwd);
  }
}

/**
 * The TUI's fork, handoff and reset (GUI lane G5): in a resumed chat,
 * `/fork` continues a new task holding the conversation (its next reply
 * names the first message), `/handoff` continues it from a note alone, and
 * `/reset` from the next message alone. The store's `run.start` and
 * `context.edit` rows and the replies are the artifact.
 */
async function validateTuiForkHandoffReset() {
  const cwd = makeScratch('texra-cli-tui-fork-');
  try {
    const project = echoProject(cwd);
    const source = project.firstRun('First message');
    const replies = [
      'Forked from',
      'First message | Second message',
      'Model saw: Handoff note',
      'Reset: the model',
      'Model saw: After reset',
    ];
    const exitId = await project.chat(
      [source],
      [
        { message: '/fork', reply: replies[0] },
        { message: 'Second message', reply: replies[1] },
        { message: '/handoff Handoff note', reply: replies[2] },
        { message: '/reset', reply: replies[3] },
        { message: 'After reset', reply: replies[4] },
      ],
    );
    const rows = project.readStore(VIEW_ROWS);
    const artifactPath = writeArtifact('tui-fork-handoff-reset.json', {
      source,
      exitId,
      replies,
      rows,
    });
    const forkStart = rows.find(
      (row) =>
        row.type === 'run.start' &&
        JSON.parse(row.provenance ?? 'null')?.from?.id === source,
    );
    const causes = rows
      .filter(
        (row) => row.run === forkStart?.run && row.type === 'context.edit',
      )
      .map((row) => row.cause);
    assert(
      forkStart !== undefined && exitId === forkStart.run,
      `/fork should continue a new task forked from ${source} (artifact: ${artifactPath})`,
    );
    assert(
      causes.join() === 'fork,handoff,reset',
      `the fork should record its seed, the handoff and the reset, got ${causes.join()} (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
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
  const cwd = makeScratch('texra-cli-compaction-');
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
    removeScratch(cwd);
  }
}

/**
 * Interrupted tasks at open (durable harness H5, gap 2): a chat killed
 * while it waits leaves its task interrupted. With its agent's file gone
 * and `texra.resumeOnOpen: auto`, the next `texra chat` finds it blocked
 * (agent missing) and does not resume it; once the file is back, the chat
 * resumes it by itself. The task's `run.activate` counts are the artifact.
 */
async function validateInterruptedTasks() {
  const cwd = makeScratch('texra-cli-interrupted-');
  try {
    const project = echoProject(cwd);
    // The chat is its task's writer here, so killing it is the crash this
    // recovers from: a service would keep the task running past the kill.
    project.ptyEnv.TEXRA_NO_SERVICE = '1';
    const globalStorage = path.join(
      cwd,
      'home',
      '.texra',
      'v1',
      'global-storage',
    );
    writeFileSync(
      path.join(globalStorage, 'config.json'),
      `${JSON.stringify({ 'texra.resumeOnOpen': 'auto' })}\n`,
    );
    const source = project.firstRun('First message');
    const activations = () =>
      project.readStore(
        `SELECT count(*) AS n FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = '${source}' AND e.type = 'run.activate'`,
      )[0].n;

    // A resumed chat killed while it waits: the task is left interrupted.
    let killed = false;
    await runTexraPty(['resume', source], {
      label: 'texra resume, then SIGKILL',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 40_000,
      env: project.ptyEnv,
      onData: (_data, pty) => {
        if (!killed && stripVTControlCharacters(pty.output).includes('Idle')) {
          killed = true;
          pty.setTimer(() => pty.kill('SIGKILL'), 800);
        }
      },
    });
    const interrupted = activations();

    // Its agent's file gone: the chat opens and leaves the task blocked.
    const agentFile = path.join(
      globalStorage,
      'custom_agents',
      'echo-validation.yaml',
    );
    renameSync(agentFile, `${agentFile}.off`);
    let whileBlocked = null;
    let resumed = null;
    let phase = 'opening';
    const chat = await runTexraPty(['chat'], {
      label: 'texra chat with an interrupted task',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 60_000,
      env: project.ptyEnv,
      onData: (_data, pty) => {
        if (phase !== 'opening') return;
        if (!stripVTControlCharacters(pty.output).includes('/ commands'))
          return;
        phase = 'blocked';
        pty.setTimer(() => {
          whileBlocked = activations();
          renameSync(`${agentFile}.off`, agentFile);
          phase = 'restored';
          const poll = () => {
            const now = activations();
            if (now > interrupted) {
              resumed = now;
              pty.setTimer(() => pty.write(ETX), 800);
              pty.setTimer(() => pty.write(ETX), 2_000);
            } else pty.setTimer(poll, 300);
          };
          poll();
        }, 3_000);
      },
    });
    const artifactPath = writeArtifact('interrupted-tasks.json', {
      source,
      activations: { interrupted, whileBlocked, resumed },
    });
    assert(
      chat.exit.exitCode === 0 &&
        whileBlocked === interrupted &&
        resumed === interrupted + 1,
      `the chat should leave the task blocked while its agent is missing and resume it once the agent is back (artifact: ${artifactPath})\noutput:\n${stripVTControlCharacters(chat.output).slice(-3000)}`,
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * Every chat is a client of the background service (D1–D4): a second
 * `texra chat` lists the first one's conversation with `/tasks` and attaches
 * to it live. The second chat's attached view is the artifact.
 */
async function validateServiceChatsSeeEachOther() {
  const cwd = makeScratch('texra-cli-service-chats-');
  const project = echoProject(cwd);
  const env = { ...project.ptyEnv, TEXRA_NO_TELEMETRY: '1' };
  const chatArgs = [
    'chat',
    '--agent',
    'echo_validation',
    '--model',
    'openai/gpt-5.6-sol',
  ];
  let first;
  let replied = false;
  try {
    const firstChat = runTexraPty(chatArgs, {
      label: 'texra chat (first)',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 240_000,
      env,
      onData: (_data, pty) => {
        first = pty;
        const plain = stripVTControlCharacters(pty.output);
        if (
          !replied &&
          plain.includes('/ commands') &&
          !plain.includes('Hello there')
        ) {
          if (!first.typed) {
            first.typed = true;
            pty.setTimer(() => pty.write('Hello there'), 600);
            pty.setTimer(() => pty.write('\r'), 1_000);
          }
        }
        // A second message goes to the live conversation in the service.
        if (plain.includes('Model saw: Hello there') && !first.followed) {
          first.followed = true;
          pty.setTimer(() => pty.write('And again'), 600);
          pty.setTimer(() => pty.write('\r'), 1_000);
        }
        if (plain.includes('Hello there | And again')) replied = true;
      },
    });
    const deadline = Date.now() + 180_000;
    while (!replied) {
      assert(
        Date.now() < deadline,
        `the first chat never answered\noutput:\n${stripVTControlCharacters(first?.output ?? '').slice(-3000)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    let phase = 'opening';
    let from = 0;
    const second = await runTexraPty(['chat'], {
      label: 'texra chat (second), /tasks',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 120_000,
      env,
      onData: (_data, pty) => {
        const plain = stripVTControlCharacters(pty.output).slice(from);
        const steps = [
          ['opening', 'list', '/ commands', ['/tasks', '\r']],
          ['list', 'attach', 'echo_validation', ['\r']],
          ['attach', 'done', 'Hello there | And again', ['\u001b', ETX, ETX]],
        ];
        const step = steps.find(([at]) => at === phase);
        if (step === undefined) return;
        const [, next, needle, keys] = step;
        if (!plain.includes(needle)) return;
        phase = next;
        from += plain.indexOf(needle) + needle.length;
        keys.forEach((key, index) =>
          pty.setTimer(() => pty.write(key), 600 + index * 400),
        );
      },
    });
    first?.write(ETX);
    first?.setTimer(() => first.write(ETX), 400);
    await firstChat;
    const artifactPath = writeArtifact('service-chats.json', {
      phase,
      tail: stripVTControlCharacters(second.output).split('\n').slice(-30),
    });
    assert(
      phase === 'done',
      `a second chat's /tasks should attach to the first chat's live conversation (artifact: ${artifactPath})\noutput:\n${stripVTControlCharacters(second.output).slice(-3000)}`,
    );
  } finally {
    first?.kill();
    run(process.execPath, [binaryPath, 'service', 'stop'], {
      cwd: project.work,
      env,
    });
    removeScratch(cwd);
  }
}

/**
 * The service's build identity (D1-D4): clients of one build share its
 * service; a client of a newer build retires it and starts its own while
 * the old one finishes the task it holds; the newer service stays
 * reachable once the old one exits; a client of the older build then
 * leaves the newer service alone. Every host stamps
 * the same workspace version, so this holds across the CLI, the extension
 * and the desktop app. The statuses each client saw are the artifact.
 */
async function validateServiceBuildIdentity() {
  const cwd = makeScratch('texra-cli-service-builds-');
  const project = echoProject(cwd);
  writeFileSync(
    path.join(
      cwd,
      'home',
      '.texra',
      'v1',
      'global-storage',
      'custom_agents',
      'park-validation.yaml',
    ),
    `name: park_validation
description: Hold its model call until released.

prompt: |
  GOLDEN-PARK
`,
  );
  const env = {
    ...project.ptyEnv,
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const texraWith = (binary, args, label) => {
    const result = run(
      process.execPath,
      [binary, ...args, '--cwd', project.work],
      { cwd: project.work, env },
    );
    assertSuccess(result, label);
    return result.stdout.trim();
  };
  const status = (binary, label) =>
    parseJson(
      texraWith(
        binary,
        ['service', 'status', '--output-format', 'json'],
        label,
      ),
      label,
    );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (label, check) => {
    const deadline = Date.now() + 30_000;
    while (!check()) {
      assert(Date.now() < deadline, `timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    // A task at work in this build's service: its model call is held.
    texraWith(
      binaryPath,
      [
        'tasks',
        'start',
        'park_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'Hold',
      ],
      'texra tasks start (this build)',
    );
    const first = status(binaryPath, 'service status (this build)');
    texraWith(
      binaryPath,
      ['tasks', 'list'],
      'texra tasks list (this build, again)',
    );
    const same = status(binaryPath, 'service status (this build, again)');
    // A newer build retires it; it drains, finishing that task, while the
    // newer service serves.
    texraWith(
      nextBuildPath,
      ['tasks', 'list'],
      'texra tasks list (next build)',
    );
    const next = status(nextBuildPath, 'service status (next build)');
    const drainingKept = alive(first.pid);
    // The retired service now exits: the newer one must still be found.
    process.kill(first.pid, 'SIGTERM');
    await until('the retired service to exit', () => !alive(first.pid));
    const reachable = status(nextBuildPath, 'service status (next, after)');
    texraWith(
      binaryPath,
      ['tasks', 'list'],
      'texra tasks list (this build, after)',
    );
    const after = status(binaryPath, 'service status (this build, after)');
    const artifactPath = writeArtifact('service-builds.json', {
      first,
      same,
      next,
      drainingKept,
      reachable,
      after,
    });
    assert(
      same.pid === first.pid,
      `two clients of one build should share its service (artifact: ${artifactPath})`,
    );
    assert(
      next.version === NEXT_BUILD && next.pid !== first.pid,
      `a newer build should retire the older service and start its own (artifact: ${artifactPath})`,
    );
    assert(
      drainingKept,
      `a retired service should keep running while its task works (artifact: ${artifactPath})`,
    );
    assert(
      reachable.pid === next.pid,
      `the newer service should stay reachable once the retired one exits (artifact: ${artifactPath})`,
    );
    assert(
      after.pid === next.pid && after.version === NEXT_BUILD,
      `an older build should leave a newer service running (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
  }
}

/**
 * Host calls (the service's runs reaching a window's editor): an
 * editor-less window attaches to the service offering `readDiagnostics`,
 * and a service task's diagnostics tool gets that window's answer. A second
 * window that never answers is killed mid-call, and the next task's tool
 * reports the typed failure instead of waiting. Both tool results are the
 * artifact.
 */
async function validateServiceHostCalls() {
  const cwd = makeScratch('texra-cli-service-host-');
  const project = echoProject(cwd);
  const storageRoot = path.join(cwd, 'home', '.texra');
  writeFileSync(
    path.join(
      storageRoot,
      'v1',
      'global-storage',
      'custom_agents',
      'diag.yaml',
    ),
    `name: diag_validation
description: Read one file's diagnostics.
tools: [diagnostics]

prompt: |
  GOLDEN-DIAGNOSTICS
`,
  );
  writeFileSync(
    path.join(project.work, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
  );
  const env = {
    ...project.ptyEnv,
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const texra = (args, label) => {
    const result = run(
      process.execPath,
      [binaryPath, ...args, '--cwd', project.work],
      { cwd: project.work, env },
    );
    assertSuccess(result, label);
    return result.stdout.trim();
  };
  // The task's tool results, from the project's store.
  const toolResults = (runId) => {
    const storage = path.join(storageRoot, 'v1', 'workspace-storage');
    const dir = readdirSync(storage).find((name) => name.startsWith('work-'));
    if (dir === undefined) return [];
    const db = new DatabaseSync(path.join(storage, dir, 'texra.db'), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          `SELECT e.data FROM event e
           JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? AND e.type = 'tool.result'
           ORDER BY e."commit"`,
        )
        .all(runId)
        .map((row) => String(row.data));
    } finally {
      db.close();
    }
  };
  const windows = [];
  const attachWindow = async (mode) => {
    const child = spawn(
      process.execPath,
      [hostHarnessPath, storageRoot, project.work, mode],
      { cwd: project.work, env: { ...process.env, ...env } },
    );
    const state = { child, stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => (state.stdout += chunk));
    child.stderr.on('data', (chunk) => (state.stderr += chunk));
    state.exited = new Promise((resolve) => child.on('close', resolve));
    windows.push(state);
    await waitFor(`the ${mode} window to attach`, () =>
      state.stdout.includes('ATTACHED'),
    );
    return state;
  };
  const startTask = () =>
    texra(
      [
        'tasks',
        'start',
        'diag_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'Read the diagnostics',
      ],
      'texra tasks start diag_validation',
    );
  try {
    // Any client starts the service; the harness only attaches to one.
    texra(['tasks', 'list'], 'texra tasks list');
    const answering = await attachWindow('answer');
    const answered = startTask();
    await waitFor('the answered read', () => toolResults(answered).length > 0);
    answering.child.kill();
    await answering.exited;
    const hanging = await attachWindow('hang');
    const detached = startTask();
    await waitFor('the hanging window to be asked', () =>
      hanging.stdout.includes('CALLED'),
    );
    hanging.child.kill('SIGKILL');
    await waitFor('the detached read', () => toolResults(detached).length > 0);
    const artifactPath = writeArtifact('service-host-calls.json', {
      answered: toolResults(answered),
      detached: toolResults(detached),
    });
    assert(
      answering.stdout.includes('CALLED') &&
        toolResults(answered).some((data) =>
          data.includes('HARNESS-DIAG in main.tex'),
        ),
      `a service task's diagnostics read should get the attached window's answer (artifact: ${artifactPath})`,
    );
    assert(
      toolResults(detached).some((data) => data.includes('(detached)')),
      `a read whose window detached mid-call should fail as detached (artifact: ${artifactPath})`,
    );
  } finally {
    for (const window of windows) window.child.kill('SIGKILL');
    run(process.execPath, [binaryPath, 'service', 'stop'], {
      cwd: project.work,
      env,
    });
    removeScratch(cwd);
  }
}

/**
 * The project's approval policy has one owner, its persisted setting, which
 * the service reads itself (audit 2026-10-07 #1). Window A attaches while
 * the setting is Auto-approve; window B then sets Ask (a settings write);
 * the service restarts and window A's link reaches the new one. A command
 * task must then wait for approval: nothing window A held replaced Ask.
 * A launch may narrow its own task for good: `tasks start
 * --approval-policy ask`, then the project widened to Auto-approve, still
 * asks. The tasks'
 * rows, the setting and window A's output are the artifacts.
 */
async function validateServicePolicyOwner() {
  const cwd = makeScratch('texra-cli-service-policy-');
  const project = echoProject(cwd);
  const storageRoot = path.join(cwd, 'home', '.texra');
  writeFileSync(
    path.join(storageRoot, 'v1', 'global-storage', 'custom_agents', 'cmd.yaml'),
    `name: approval_validation
description: Run one command once it is approved.
tools: [bash]

prompt: |
  GOLDEN-APPROVAL
`,
  );
  const env = {
    ...project.ptyEnv,
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const texra = (args, label) => {
    const result = run(
      process.execPath,
      [binaryPath, ...args, '--cwd', project.work],
      { cwd: project.work, env },
    );
    assertSuccess(result, label);
    return result;
  };
  const waitFor = async (label, check, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      assert(Date.now() < deadline, `timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const storage = path.join(storageRoot, 'v1', 'workspace-storage');
  const projectDir = () => {
    const dir = existsSync(storage)
      ? readdirSync(storage).find((name) => name.startsWith('work-'))
      : undefined;
    return dir === undefined ? null : path.join(storage, dir);
  };
  // The user's local config for the project: where a window's settings
  // view writes `texra.approvalPolicy`.
  const setPolicy = (policy) =>
    writeFileSync(
      path.join(projectDir(), 'config.json'),
      `${JSON.stringify({ 'texra.approvalPolicy': policy })}\n`,
    );
  const rowTypes = (runId) => {
    const db = new DatabaseSync(path.join(projectDir(), 'texra.db'), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          `SELECT e.type FROM event e
           JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? ORDER BY e."commit"`,
        )
        .all(runId)
        .map((row) => row.type);
    } finally {
      db.close();
    }
  };
  let windowA;
  try {
    // A first task opens the project in the service, which makes its
    // store; then the setting is Auto-approve and window A attaches.
    texra(
      [
        'tasks',
        'start',
        'echo_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'Open the project',
      ],
      'texra tasks start echo_validation',
    );
    await waitFor('the project store', () => projectDir() !== null);
    setPolicy('yolo');
    const child = spawn(
      process.execPath,
      [hostHarnessPath, storageRoot, project.work, 'answer'],
      { cwd: project.work, env: { ...process.env, ...env } },
    );
    windowA = { child, stdout: '' };
    child.stdout.on('data', (chunk) => (windowA.stdout += chunk));
    await waitFor('window A to attach', () =>
      windowA.stdout.includes('ATTACHED'),
    );
    // Window B sets Ask; the service restarts and window A reconnects.
    setPolicy('ask');
    texra(['service', 'stop'], 'texra service stop');
    texra(['tasks', 'list'], 'texra tasks list (starts the service)');
    await waitFor(
      'window A to reach the restarted service',
      () => windowA.stdout.split('LINKED').length - 1 >= 2,
    );
    const started = texra(
      [
        'tasks',
        'start',
        'approval_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'Run the command',
      ],
      'texra tasks start approval_validation',
    );
    const runId = started.stdout.trim();
    await waitFor('the command to wait for approval', () =>
      rowTypes(runId).includes('request.opened'),
    );
    // Long enough for an Auto-approve run to have run its command.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const approved = path.join(project.work, 'approved.txt');
    const rows = rowTypes(runId);
    const artifactPath = writeArtifact('service-policy-owner.json', {
      setting: JSON.parse(
        readFileSync(path.join(projectDir(), 'config.json'), 'utf8'),
      ),
      rows,
      commandRan: existsSync(approved),
      startNotice: started.stderr.trim(),
      windowA: windowA.stdout.trim().split('\n'),
    });
    assert(
      !existsSync(approved) &&
        !rows.includes('request.decided') &&
        !started.stderr.includes('approval policy'),
      `after a restart the service should follow the project's Ask setting, not a policy window A held (artifact: ${artifactPath})`,
    );
    texra(['tasks', 'stop', runId], 'texra tasks stop');
    // A launch narrows its own task for good: started with
    // `--approval-policy ask` while the project asks, then the project is
    // widened to Auto-approve, the task still waits for approval.
    const narrowed = texra(
      [
        'tasks',
        'start',
        'approval_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--approval-policy',
        'ask',
        '--instruction',
        'Run the command',
      ],
      'texra tasks start --approval-policy ask',
    ).stdout.trim();
    await waitFor('the narrowed task to start', () =>
      rowTypes(narrowed).includes('run.start'),
    );
    setPolicy('yolo');
    await waitFor('the narrowed command to wait for approval', () =>
      rowTypes(narrowed).includes('request.opened'),
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const narrowedRows = rowTypes(narrowed);
    // The limit is what holds it, recorded on its run.start; the project's
    // Auto-approve may land before or after that row.
    const db = new DatabaseSync(path.join(projectDir(), 'texra.db'), {
      readOnly: true,
    });
    let limit;
    try {
      limit = db
        .prepare(
          `SELECT json_extract(e.data, '$.approvalPolicy.limit') AS limit_ FROM event e
           JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? AND e.type = 'run.start'`,
        )
        .get(narrowed)?.limit_;
    } finally {
      db.close();
    }
    writeArtifact('service-policy-narrowed.json', {
      limit,
      rows: narrowedRows,
      commandRan: existsSync(approved),
    });
    assert(
      limit === 'ask' &&
        !existsSync(approved) &&
        !narrowedRows.includes('request.decided'),
      'a task started with --approval-policy ask should still ask after the project is widened to Auto-approve',
    );
    texra(['tasks', 'stop', narrowed], 'texra tasks stop (narrowed)');
  } finally {
    windowA?.child.kill('SIGKILL');
    run(process.execPath, [binaryPath, 'service', 'stop'], {
      cwd: project.work,
      env,
    });
    removeScratch(cwd);
  }
}

/**
 * `/tasks` in the chat (D1–D4): a task started in the service under the
 * `ask` policy opens a command approval; `texra chat` lists it with
 * `/tasks`, attaches, approves the command in place and sends a follow-up,
 * and the service runs both. The task's request and tool rows, the file
 * the command wrote and the attached view's last lines are the artifact.
 */
async function validateServiceTasksInTui() {
  const cwd = makeScratch('texra-cli-service-tui-');
  const project = echoProject(cwd);
  writeFileSync(
    path.join(
      cwd,
      'home',
      '.texra',
      'v1',
      'global-storage',
      'custom_agents',
      'approval-validation.yaml',
    ),
    `name: approval_validation
description: Run one command once it is approved.
tools: [bash]

prompt: |
  GOLDEN-APPROVAL
`,
  );
  const env = {
    ...project.ptyEnv,
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const texra = (args, label) => {
    const result = run(
      process.execPath,
      [binaryPath, ...args, '--cwd', project.work],
      { cwd: project.work, env },
    );
    assertSuccess(result, label);
    return result.stdout.trim();
  };
  // The task's rows, from the project's own store (the chat also opens
  // the no-workspace one), each with whether it carries the follow-up.
  const taskRows = (runId) => {
    const storage = path.join(cwd, 'home', '.texra', 'v1', 'workspace-storage');
    const project = readdirSync(storage).find((name) =>
      name.startsWith('work-'),
    );
    if (project === undefined) return [];
    const db = new DatabaseSync(path.join(storage, project, 'texra.db'), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          `SELECT e.type, e.data LIKE '%Ping%' AS ping FROM event e
           JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? ORDER BY e."commit"`,
        )
        .all(runId);
    } finally {
      db.close();
    }
  };
  try {
    const runId = texra(
      [
        'tasks',
        'start',
        'approval_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--approval-policy',
        'ask',
        '--instruction',
        'Run the command',
      ],
      'texra tasks start approval_validation',
    );
    let phase = 'opening';
    let from = 0;
    const chat = await runTexraPty(['chat'], {
      label: 'texra chat, /tasks',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 180_000,
      env,
      onData: (_data, pty) => {
        const plain = stripVTControlCharacters(pty.output).slice(from);
        // One step per chunk: each waits for output after the last one's.
        const steps = [
          ['opening', 'list', '/ commands', ['/tasks', '\r']],
          ['list', 'attach', 'approval_validation', ['\r']],
          ['attach', 'approved', 'Run command?', ['y']],
          ['approved', 'sent', 'The approved command ran.', ['Ping', '\r']],
        ];
        const step = steps.find(([at]) => at === phase);
        if (step === undefined) return;
        const [, next, needle, keys] = step;
        if (!plain.includes(needle)) return;
        phase = next;
        from += plain.indexOf(needle) + needle.length;
        keys.forEach((key, index) =>
          pty.setTimer(() => pty.write(key), 600 + index * 400),
        );
        if (phase !== 'sent') return;
        // The follow-up's answer is a second finalized response in the
        // task's own rows; the screen repaints old replies, so it is read
        // from the store.
        const poll = () => {
          const answered = taskRows(runId).filter(
            (row) => row.type === 'response.finalized',
          ).length;
          if (answered < 2) return pty.setTimer(poll, 500);
          phase = 'done';
          ['\u001b', ETX, ETX].forEach((key, index) =>
            pty.setTimer(() => pty.write(key), 1_500 + index * 600),
          );
        };
        pty.setTimer(poll, 1_000);
      },
    });
    const rows = taskRows(runId);
    const approved = path.join(project.work, 'approved.txt');
    const artifactPath = writeArtifact('service-tasks-tui.json', {
      runId,
      phase,
      rows: rows.map((row) => row.type),
      followUpRows: rows.filter((row) => row.ping).map((row) => row.type),
      approvedFile: existsSync(approved)
        ? readFileSync(approved, 'utf8')
        : null,
      tail: stripVTControlCharacters(chat.output).split('\n').slice(-40),
    });
    assert(
      phase === 'done' &&
        existsSync(approved) &&
        rows.some((row) => row.type === 'request.decided') &&
        rows.some((row) => row.ping) &&
        rows.filter((row) => row.type === 'response.finalized').length >= 2 &&
        stripVTControlCharacters(chat.output).includes('› Ping'),
      `/tasks should attach to the service task, approve its command and send a follow-up (artifact: ${artifactPath})\noutput:\n${stripVTControlCharacters(chat.output).slice(-3000)}`,
    );
  } finally {
    run(process.execPath, [binaryPath, 'service', 'stop'], {
      cwd: project.work,
      env,
    });
    removeScratch(cwd);
  }
}

/**
 * The background service (`texra serve`) end to end: `texra tasks start`
 * starts the service on demand and a task in it; two terminals attach to
 * that task at once, a third sends it a follow-up and then stops it. Both
 * attached terminals must print the same transcript, holding both turns;
 * those two transcripts are the artifact.
 */
async function validateServiceSharedTask() {
  const cwd = makeScratch('texra-cli-service-');
  const project = echoProject(cwd);
  const env = { ...project.ptyEnv, TEXRA_NO_TELEMETRY: '1' };
  const texra = (args, label, extraEnv = {}) => {
    const result = run(
      process.execPath,
      [binaryPath, ...args, '--cwd', project.work],
      { cwd: project.work, env: { ...env, ...extraEnv } },
    );
    assertSuccess(result, label);
    return result.stdout.trim();
  };
  const attach = (runId) => {
    const child = spawn(
      process.execPath,
      [binaryPath, 'tasks', 'attach', runId, '--cwd', project.work],
      { cwd: project.work, env: { ...process.env, CI: '1', ...env } },
    );
    const state = { stdout: '', stderr: '', exit: null };
    child.stdout.on('data', (chunk) => (state.stdout += chunk));
    child.stderr.on('data', (chunk) => (state.stderr += chunk));
    state.exited = new Promise((resolve) =>
      child.on('close', (code) => resolve((state.exit = code))),
    );
    return state;
  };
  const count = (text, needle) => text.split(needle).length - 1;
  let a;
  let b;
  try {
    const runId = texra(
      [
        'tasks',
        'start',
        'echo_validation',
        '--model',
        'openai/gpt-5.6-sol',
        '--instruction',
        'First message',
      ],
      'texra tasks start',
      // The service this starts reads the user's login shell for its
      // environment, not the PATH of whoever started it: a window opened
      // from the Dock passes one as bare as this.
      { PATH: '/usr/bin:/bin' },
    );
    assert(/^[0-9a-f]{12}$/.test(runId), `tasks start printed ${runId}`);
    a = attach(runId);
    b = attach(runId);
    await waitFor('both attaches to print the first reply', () =>
      [a, b].every((t) => t.stdout.includes('User instruction:')),
    );
    const serveLog = readFileSync(
      path.join(cwd, 'home', '.texra', 'run', 'serve.log'),
      'utf8',
    );
    const loginPath =
      /Using the login shell's environment \(PATH=([^)]*)\)/.exec(
        serveLog,
      )?.[1];
    assert(
      loginPath !== undefined,
      `the service should say which login-shell PATH it runs with\n${serveLog}`,
    );
    // Where MacTeX is installed, the login shell puts it on the PATH even
    // though the starter's PATH did not have it.
    if (existsSync('/Library/TeX/texbin/latexmk'))
      assert(
        loginPath.split(':').includes('/Library/TeX/texbin'),
        `a service started with PATH=/usr/bin:/bin should still find latexmk (login PATH: ${loginPath})`,
      );
    const listed = parseJson(
      texra(['tasks', 'list', '--output-format', 'json'], 'texra tasks list'),
      'tasks list',
    );
    assert(
      listed.some((task) => task.runId === runId && task.live),
      `tasks list should show ${runId} running in the service`,
    );
    texra(['tasks', 'send', runId, 'Second message'], 'texra tasks send');
    await waitFor('both attaches to print the second reply', () =>
      [a, b].every(
        (t) => count(t.stdout, 'First message | Second message') >= 1,
      ),
    );
    texra(['tasks', 'stop', runId], 'texra tasks stop');
    await Promise.all([a.exited, b.exited]);
    const artifactDir = path.join(validationRoot, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const artifactA = path.join(artifactDir, 'service-attach-a.txt');
    writeFileSync(artifactA, a.stdout);
    writeFileSync(path.join(artifactDir, 'service-attach-b.txt'), b.stdout);
    assert(
      a.exit === 130 && b.exit === 130,
      `a stopped task should end both attaches as interrupted (exits ${a.exit}, ${b.exit})\n${a.stderr}\n${b.stderr}`,
    );
    assert(
      a.stdout === b.stdout && count(a.stdout, 'Second message') >= 2,
      `both attached terminals should print the same two-turn transcript (artifact: ${artifactA})\nA:\n${a.stdout}\nB:\n${b.stdout}`,
    );
  } finally {
    run(process.execPath, [binaryPath, 'service', 'stop'], {
      cwd: project.work,
      env,
    });
    removeScratch(cwd);
  }
}

/**
 * The open-time prompt and rename (GUI lane G4): a chat killed while it
 * waits leaves its task interrupted; under the default
 * `texra.resumeOnOpen: ask`, the next `texra chat` lists it above the input
 * by title and resumes nothing until `/resume all`. A resumed chat's
 * `/rename` then writes the user's title. The notice's lines, the
 * activation counts and the task's `run.description` rows are the artifact.
 */
async function validateOpenTimePrompt() {
  const cwd = makeScratch('texra-cli-open-prompt-');
  try {
    const project = echoProject(cwd);
    // The chat is its task's writer here, so killing it is the crash this
    // recovers from: a service would keep the task running past the kill.
    project.ptyEnv.TEXRA_NO_SERVICE = '1';
    const source = project.firstRun('First message');
    const activations = () =>
      project.readStore(
        `SELECT count(*) AS n FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = '${source}' AND e.type = 'run.activate'`,
      )[0].n;
    let killed = false;
    await runTexraPty(['resume', source], {
      label: 'texra resume, then SIGKILL',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 40_000,
      env: project.ptyEnv,
      onData: (_data, pty) => {
        if (!killed && stripVTControlCharacters(pty.output).includes('Idle')) {
          killed = true;
          pty.setTimer(() => pty.kill('SIGKILL'), 800);
        }
      },
    });
    const interrupted = activations();

    let phase = 'opening';
    let notice = [];
    let whileListed = null;
    let resumed = null;
    const chat = await runTexraPty(['chat'], {
      label: 'texra chat with an interrupted task (ask)',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 60_000,
      env: project.ptyEnv,
      onData: (_data, pty) => {
        const plain = stripVTControlCharacters(pty.output);
        if (phase !== 'opening' || !plain.includes('1 task was interrupted'))
          return;
        phase = 'listed';
        pty.setTimer(() => {
          const shown = stripVTControlCharacters(pty.output);
          const at = shown.lastIndexOf('1 task was interrupted');
          notice = shown
            .slice(at)
            .split('\n')
            .slice(0, 3)
            .map((line) => line.trim());
          whileListed = activations();
          pty.write('/resume all');
          pty.setTimer(() => pty.write('\r'), 400);
          const poll = () => {
            const now = activations();
            if (now > interrupted) {
              resumed = now;
              pty.setTimer(() => pty.write(ETX), 800);
              pty.setTimer(() => pty.write(ETX), 2_000);
            } else pty.setTimer(poll, 300);
          };
          pty.setTimer(poll, 600);
        }, 2_000);
      },
    });

    let renamed = false;
    await runTexraPty(['resume', source], {
      label: 'texra resume, then /rename',
      cwd: project.work,
      cols: 160,
      rows: 40,
      timeoutMs: 40_000,
      env: project.ptyEnv,
      onData: (_data, pty) => {
        const plain = stripVTControlCharacters(pty.output);
        if (!renamed && plain.includes('Idle')) {
          renamed = true;
          pty.setTimer(() => pty.write('/rename Chapter two review'), 500);
          pty.setTimer(() => pty.write('\r'), 900);
        }
        if (renamed && plain.includes('Renamed to Chapter two review')) {
          pty.setTimer(() => pty.write(ETX), 800);
          pty.setTimer(() => pty.write(ETX), 2_000);
        }
      },
    });
    const titles = project.readStore(
      `SELECT json_extract(e.data, '$.description') AS description,
              json_extract(e.data, '$.by') AS "by"
         FROM event e JOIN event_sequence s ON s.id = e.aggregate
        WHERE s.logical_id = '${source}' AND e.type = 'run.description'
        ORDER BY e."commit"`,
    );
    const artifactPath = writeArtifact('open-time-prompt.json', {
      source,
      notice,
      activations: { interrupted, whileListed, resumed },
      titles,
    });
    assert(
      chat.exit.exitCode === 0 &&
        notice.length > 1 &&
        notice[1].includes('stopped') &&
        whileListed === interrupted &&
        resumed === interrupted + 1,
      `the chat should list the interrupted task by title, resume nothing until /resume all, then resume it (artifact: ${artifactPath})\noutput:\n${stripVTControlCharacters(chat.output).slice(-3000)}`,
    );
    assert(
      titles.at(-1)?.by === 'user' &&
        titles.at(-1)?.description === 'Chapter two review',
      `/rename should write the user's title (artifact: ${artifactPath})`,
    );
  } finally {
    removeScratch(cwd);
  }
}

function validateScriptFanoutRunCommand() {
  const cwd = makeScratch('texra-cli-script-fanout-run-');
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

tools:
  - script
  - agent
prompt: |
  Run the requested script exactly once, then finish.
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
    removeScratch(cwd);
  }
}

function validateTeamRunCommand() {
  const cwd = makeScratch('texra-cli-team-run-');
  // A preset whose members are all chat agents keeps this check cheap.
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
      jsonResult.result?.output != null &&
        jsonResult.result.output.documents === undefined,
      'team JSON output should serialize the chat result',
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
      inlineJsonResult.result?.output != null &&
        inlineJsonResult.result.output.documents === undefined,
      'instruction-only team JSON output should serialize the chat result',
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
    removeScratch(cwd);
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
  validateStopHookBlock();
  validateSdkInlinePersona();
  await validateSdkResumeApproval();
  await validateForkResetHandoff();
  await validateTuiForkHandoffReset();
  await validateBackgroundCompaction();
  await validateInterruptedTasks();
  await validateOpenTimePrompt();
  await validateServiceSharedTask();
  await validateServiceTasksInTui();
  await validateServiceChatsSeeEachOther();
  await validateServiceHostCalls();
  await validateServicePolicyOwner();
  await validateServiceBuildIdentity();
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
  assertSuccess(
    run(process.execPath, ['scripts/build-bundle.mjs'], {
      cwd: cliRoot,
      env: {
        TEXRA_CLI_BUNDLE_OUTFILE: nextBuildPath,
        TEXRA_BUILD_VERSION: NEXT_BUILD,
      },
    }),
    'build the next-build CLI',
  );
  assertSuccess(
    run(process.execPath, ['scripts/build-bundle.mjs', '--host-harness'], {
      cwd: cliRoot,
      env: { TEXRA_CLI_BUNDLE_OUTFILE: hostHarnessPath },
    }),
    'build the service host harness',
  );
  assertSuccess(
    run(process.execPath, ['scripts/build-bundle.mjs', '--sdk-harness'], {
      cwd: cliRoot,
      env: {
        TEXRA_CLI_BUNDLE_OUTFILE: sdkHarnessPath,
        TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
      },
    }),
    'build the SDK harness',
  );
}

const args = parseArgs(process.argv.slice(2));

await validateCliRunArtifacts(args);
