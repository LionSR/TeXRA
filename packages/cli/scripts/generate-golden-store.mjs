#!/usr/bin/env node
/**
 * Regenerate the golden 1.0 session store,
 * `src/test-kernel/fixtures/storage/golden-1.0.sql`
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §11):
 *
 *   pnpm --filter @texra-ai/cli run golden:store            # build, then write
 *   pnpm --filter @texra-ai/cli run golden:store -- --no-build
 *
 * It drives the real CLI, built with the internal validation model (the
 * bundle `validate-run.mjs` builds), against a temporary HOME and project
 * from `mkdtemp`, set only in each child's environment: no live model, no API
 * key, and never the developer's `~/.texra`. The scripted conversation is
 * `goldenTurn` in `src/agent/runtime/run/validationModel.ts`, over the agents
 * in `src/test-kernel/fixtures/storage/agents/`; this script orders the runs,
 * each in its own process:
 *
 * - `golden_park`: killed (`SIGKILL`) while its model call is open, the
 *   parked run the conformance suite resumes.
 * - `golden_parent` (headless, `yolo`): a `read_file` call; a `plan` update
 *   the policy approves (a decided `planApproval` request); a workflow
 *   script with one attempt of one child (`workflow.script`,
 *   `workflow.attempt`, `workflow.journal` and the child run); and a
 *   `delegate_agent` child that looks its parent up and messages it, which
 *   is refused: a one-shot parent never reads a message. Headless
 *   delegation runs in band, so every row commits in one order.
 * - two `review` runs over the same notes: the context blobs they share.
 * - `golden_chat`, the interactive `texra chat` driven under a PTY: a plan
 *   the user runs as a goal (`r` on the approval, the `goal` plugin fact)
 *   and the goal completed, then `/model` and a message, so the switch is
 *   recorded at the run's next model boundary; then a held turn, a message
 *   typed behind it, and the user's stop, so that follow-up stays queued.
 *   Only the chat makes a goal: the headless policy approves a plan
 *   without one. Each keystroke
 *   waits for the screen or the store to show the step before it, so the
 *   rows commit in one order.
 * - `golden_approval`, a second `texra chat` under a PTY: a `bash` command
 *   waiting for its approval, bound to its call, killed (`SIGKILL`) before
 *   anyone answers, the pending approval the conformance suite resumes.
 * - `golden_script` (headless, `yolo`): a `script` call whose guest finds
 *   its read tool with `searchTools` and `describeTool`, then reads twice
 *   and runs one command in a `Promise.all`, killed (`SIGKILL`) while
 *   the command waits, after the first read settled: the interrupted script
 *   the conformance suite resumes. The command is a barrier, so the second
 *   read waits behind it and every row commits in one order.
 * - `golden_fanout` (headless, `yolo`): a `script` call whose guest awaits
 *   two `agent()` calls in one `Promise.all`, one child at a time under a
 *   project child-run budget of 1, killed (`SIGKILL`) after the first child
 *   completed and its call settled, while the second child's model call
 *   waits for `golden-fanout.release`: the interrupted fan-out the
 *   conformance suite resumes.
 * - `golden_background`, a third `texra chat` under a PTY (`yolo`): a
 *   `script` call sent to the background, whose run (`{ kind: 'script' }`)
 *   awaits one `agent()` call, and the parent's turn ended; killed
 *   (`SIGKILL`) while that child's model call waits for
 *   `golden-background.release`: the background script the conformance
 *   suite resumes. The parent's reply waits for
 *   `golden-background-reply.release` until that child is at its model
 *   call, so the two runs of one process do not race their rows.
 * - one `golden_child` run deleted last with `texra history delete`: the
 *   tombstoned run, which no later open is left to collect.
 *
 * What differs between two generations is normalized before the dump: the
 * temporary paths, the process identities, the clock, the random ids, and
 * the date and platform in a system prompt. A content address over a
 * normalized value is recomputed, so every digest still names its value.
 * Two generations on one tree give the same file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import stableStringify from 'safe-stable-stringify';

import { ensureNodePtySpawnHelperExecutable } from './nodePtySpawnHelper.mjs';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));
const validationRoot = path.join(cliRoot, '.texra-validate-run');
const binaryPath = path.join(validationRoot, 'bin', 'texra.js');
const fixturePath = path.join(
  repoRoot,
  'src/test-kernel/fixtures/storage/golden-1.0.sql',
);
const FLAG_CONTENT = 'texra-cli-run-validation\n';
const FAKE_KEY = 'texra-validation-fake-key';
const PROVIDER_KEYS = [
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

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const noBuild = args.includes('--no-build');
const keep = args.includes('--keep');
if (args.some((arg) => !['--no-build', '--keep'].includes(arg))) {
  console.error(
    'usage: node scripts/generate-golden-store.mjs [--no-build] [--keep]',
  );
  process.exit(2);
}

function fail(message) {
  throw new Error(`[golden-store] ${message}`);
}

function build() {
  for (const [script, env] of [
    [
      'bundle',
      {
        TEXRA_CLI_BUNDLE_OUTFILE: binaryPath,
        TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1',
      },
    ],
    [
      'copy:resources',
      { TEXRA_CLI_RESOURCES_OUTDIR: path.join(validationRoot, 'resources') },
    ],
  ]) {
    const result = spawnSync('pnpm', ['run', script], {
      cwd: cliRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    if (result.status !== 0) fail(`pnpm run ${script} failed`);
  }
}

// ---------------------------------------------------------------------------
// The runs
// ---------------------------------------------------------------------------

/** The agents the scripted conversation names, beside the fixture: the
 *  conformance suite resumes the parked run under the same definition. */
const agentsDir = path.join(path.dirname(fixturePath), 'agents');

function scenario(root) {
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const flag = path.join(root, 'flag');
  const agents = path.join(home, '.texra/v1/global-storage/custom_agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(flag, FLAG_CONTENT);
  cpSync(agentsDir, agents, { recursive: true });
  writeFileSync(
    path.join(project, 'notes.tex'),
    '\\section{Notes}\nThe golden store reads this file.\n',
  );
  // The caller's environment (Windows needs `SystemRoot` and the like), less
  // its TeXRA settings, provider keys and `CI` (which would force the chat
  // headless), with every home the CLI could resolve (`HOME`, and
  // `USERPROFILE` on Windows) in the temporary root.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith('TEXRA_') && name !== 'CI',
      ),
    ),
    ...Object.fromEntries(PROVIDER_KEYS.map((name) => [name, ''])),
    OPENAI_API_KEY: FAKE_KEY,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    // The system prompt names the shell (normalized away, but named on
    // every machine) and dates in this zone.
    SHELL: '/bin/sh',
    TZ: 'UTC',
    LANG: 'C',
    TEXRA_NO_UPDATE_CHECK: '1',
    TEXRA_NO_TELEMETRY: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
    TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const argv = (command) => [binaryPath, ...command, '--cwd', project];
  const run = (command) => {
    const result = spawnSync(process.execPath, argv(command), {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    if (result.status !== 0)
      fail(
        `texra ${command.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
      );
    return result.stdout;
  };
  const start = (command) => {
    const child = spawn(process.execPath, argv(command), {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        done = true;
        resolve({ code, signal, output });
      }),
    );
    return { child, exited, output: () => output, done: () => done };
  };
  // The interactive chat, on a PTY whose screen a headless terminal keeps.
  const chat = async (command) => {
    ensureNodePtySpawnHelperExecutable();
    const require = createRequire(import.meta.url);
    const { spawn: spawnPty } = require('node-pty');
    const { Terminal } = require('@xterm/headless');
    const cols = 100;
    const rows = 40;
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const child = spawnPty(process.execPath, argv(command), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: project,
      env: { ...env, TERM: 'xterm-256color' },
    });
    let done = false;
    child.onData((data) => term.write(data));
    const exited = new Promise((resolve) =>
      child.onExit((exit) => {
        done = true;
        resolve(exit);
      }),
    );
    const screen = () => {
      const buffer = term.buffer.active;
      return Array.from(
        { length: rows },
        (_, i) =>
          buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '',
      ).join('\n');
    };
    return {
      write: (data) => child.write(data),
      kill: (signal) => child.kill(signal),
      screen,
      exited,
      output: screen,
      done: () => done,
    };
  };
  const store = () => {
    const dir = path.join(home, '.texra/v1/workspace-storage');
    const [key] = existsSync(dir) ? readdirSync(dir) : [];
    return key === undefined ? null : path.join(dir, key, 'texra.db');
  };
  return { run, start, chat, store, project };
}

/** Rows of the workspace store, read from outside the CLI. */
function query(file, sql, params = []) {
  if (file === null || !existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** Poll `check` until it answers, the deadline passes, or `handle` exits. A
 *  read that fails (a store not created yet, or held by the CLI's write) is
 *  "not yet", and the last such failure is reported if the wait fails. */
async function until(label, check, handle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline || handle?.done())
      fail(
        `timed out waiting for ${label}${lastError ? ` (last read: ${lastError.message})` : ''}\n${handle?.output() ?? ''}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const RUN_OF_AGENT = `SELECT s.logical_id AS id FROM event e
  JOIN event_sequence s ON s.id = e.aggregate
  WHERE e.type = 'run.start' AND json_extract(e.data, '$.identity.agent') = ?
  ORDER BY e."commit"`;

async function generate(root) {
  const cli = scenario(root);
  cli.run(['tools', 'enable', 'workflow-script', '--print']);

  // The parked run: its model call held open, then killed.
  const park = cli.start([
    'run',
    'golden_park',
    '--model',
    'gpt56',
    '--instruction',
    'Park at the model call.',
    '--approval-policy',
    'never',
    '--output-format',
    'json',
    '--print',
  ]);
  const parkId = await until(
    'the parked run',
    () => query(cli.store(), RUN_OF_AGENT, ['golden_park'])[0]?.id,
    park,
  );
  await until(
    'the open model call of the parked run',
    () =>
      query(
        cli.store(),
        `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = ? AND e.type = 'model.message'
           AND json_extract(e.data, '$.payload.kind') = 'attempt'`,
        [parkId],
      ).length > 0,
    park,
  );

  park.child.kill('SIGKILL');
  await park.exited;

  cli.run([
    'run',
    'golden_parent',
    '--model',
    'gpt56',
    '--instruction',
    'Work through the golden parent task.',
    '--approval-policy',
    'yolo',
    '--output-format',
    'json',
    '--print',
  ]);

  // Two runs of one agent over one file: the blobs they share.
  for (let i = 0; i < 2; i += 1)
    cli.run([
      'run',
      'review',
      '--model',
      'gpt56',
      '--instruction',
      'Review the notes.',
      '--context',
      'notes.tex',
      '--approval-policy',
      'never',
      '--output-format',
      'json',
      '--print',
    ]);

  // The interactive chat: each keystroke waits for the step before it.
  const tty = await cli.chat([
    'chat',
    '--agent',
    'golden_chat',
    '--model',
    'gpt56',
  ]);
  const shows = (label, text) =>
    until(label, () => tty.screen().includes(text), tty);
  const send = async (text) => {
    await shows('the idle prompt', 'Ctrl-C exit');
    tty.write(text);
    await shows(`the typed ${JSON.stringify(text)}`, `› ${text}`);
    tty.write('\r');
  };
  const chatRun = () =>
    query(cli.store(), RUN_OF_AGENT, ['golden_chat'])[0]?.id;
  const waiting = (turn) =>
    until(
      `the chat waiting after turn ${turn}`,
      () =>
        query(
          cli.store(),
          `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
           WHERE s.logical_id = ? AND e.type = 'run.position'
             AND json_extract(e.data, '$.payload.at') = 'waiting'
             AND json_extract(e.data, '$.payload.turn') = ?`,
          [chatRun(), turn],
        ).length > 0,
      tty,
    );
  await send('Start the golden chat.');
  await until(
    'the plan approval',
    () =>
      query(
        cli.store(),
        `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = ? AND e.type = 'request.opened'
           AND json_extract(e.data, '$.payload.kind') = 'planApproval'`,
        [chatRun()],
      ).length > 0 && tty.screen().includes('r run as goal'),
    tty,
  );
  tty.write('r');
  await waiting(1);
  await send('/model gemini38f');
  await shows('the model switch notice', 'Model switched to gemini38f');
  await send('After the model switch.');
  await waiting(2);
  // A held turn, a message typed behind it, and the user's stop: the
  // follow-up stays queued on the stopped run.
  await send('Hold this turn.');
  const chatRows = (sql) =>
    query(
      cli.store(),
      `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = ? AND ${sql}`,
      [chatRun()],
    ).length;
  await until(
    'the held model call',
    () =>
      chatRows(`e.type = 'run.position'
        AND json_extract(e.data, '$.payload.at') = 'turn.begin'
        AND json_extract(e.data, '$.payload.turn') = 3`) > 0 &&
      tty.screen().includes('Ctrl-C stop'),
    tty,
  );
  tty.write('Queued behind the held turn.');
  await shows('the typed follow-up', '› Queued behind the held turn.');
  tty.write('\r');
  await until(
    'the queued follow-up',
    () => chatRows(`e.type = 'followup.queued'`) === 3,
    tty,
  );
  tty.write('\x03');
  await until(
    'the stopped chat',
    () =>
      chatRows(`e.type = 'run.position'
        AND json_extract(e.data, '$.payload.at') = 'halted'`) > 0,
    tty,
  );
  await shows('the idle prompt', 'Ctrl-C exit');
  tty.write('\x03');
  const exit = await tty.exited;
  if (exit.exitCode !== 0)
    fail(`texra chat exited ${exit.exitCode}\n${tty.screen()}`);

  // The pending approval: a command waits for its approval in the chat, and
  // the process is killed before anyone answers it.
  const asking = await cli.chat([
    'chat',
    '--agent',
    'golden_approval',
    '--model',
    'gpt56',
  ]);
  await until(
    'the idle approval chat',
    () => asking.screen().includes('Ctrl-C exit'),
    asking,
  );
  asking.write('Run the command.');
  await until(
    'the typed instruction',
    () => asking.screen().includes('› Run the command.'),
    asking,
  );
  asking.write('\r');
  const approvalRun = () =>
    query(cli.store(), RUN_OF_AGENT, ['golden_approval'])[0]?.id;
  await until(
    'the bound command approval',
    () =>
      query(
        cli.store(),
        `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = ? AND e.type = 'tool.binding'
           AND json_extract(e.data, '$.payload.role') = 'call'`,
        [approvalRun()],
      ).length > 0 && asking.screen().includes('echo approved'),
    asking,
  );
  asking.kill('SIGKILL');
  await asking.exited;
  // The interrupted script: killed while its command waits for the release
  // file, which only the orphaned command reads once the process is gone.
  const scripted = cli.start([
    'run',
    'golden_script',
    '--model',
    'gpt56',
    '--instruction',
    'Gather the notes in one script.',
    '--approval-policy',
    'yolo',
    '--output-format',
    'json',
    '--print',
  ]);
  await until(
    'the script command waiting',
    () => existsSync(path.join(cli.project, 'golden-script.started')),
    scripted,
  );
  scripted.child.kill('SIGKILL');
  await scripted.exited;
  writeFileSync(path.join(cli.project, 'golden-script.release'), '');

  // The fan-out: a script's two `agent()` calls under one `Promise.all`,
  // one child at a time under a project child-run budget of 1, killed after
  // the first child completed while the second waits on its model call.
  mkdirSync(path.join(cli.project, '.texra'), { recursive: true });
  writeFileSync(
    path.join(cli.project, '.texra/config.json'),
    `${JSON.stringify({ 'texra.childRunConcurrencyBudget': 1 })}\n`,
  );
  const fanout = cli.start([
    'run',
    'golden_fanout',
    '--model',
    'gpt56',
    '--instruction',
    'Fan out in one script.',
    '--approval-policy',
    'yolo',
    '--output-format',
    'json',
    '--print',
  ]);
  const fanoutRun = await until(
    'the fan-out run',
    () => query(cli.store(), RUN_OF_AGENT, ['golden_fanout'])[0]?.id,
    fanout,
  );
  const fanoutRows = (child, type, extra = '') =>
    query(
      cli.store(),
      `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = ? AND e.type = ? ${extra}`,
      [child, type],
    ).length;
  await until(
    'the first fan-out child completed and the second waiting',
    () => {
      const [first, second] = query(
        cli.store(),
        `SELECT s.logical_id AS id FROM event e
         JOIN event_sequence s ON s.id = e.aggregate
         WHERE e.type = 'run.start' AND json_extract(e.data, '$.parent.id') = ?
         ORDER BY e."commit"`,
        [fanoutRun],
      ).map((row) => row.id);
      return (
        first !== undefined &&
        second !== undefined &&
        fanoutRows(first, 'run.end') > 0 &&
        fanoutRows(
          fanoutRun,
          'tool.result',
          `AND json_extract(e.data, '$.payload.callId') LIKE '%/0'`,
        ) > 0 &&
        fanoutRows(
          second,
          'model.message',
          `AND json_extract(e.data, '$.payload.kind') = 'attempt'`,
        ) > 0
      );
    },
    fanout,
  );
  fanout.child.kill('SIGKILL');
  await fanout.exited;

  // The background script: the parent's turn ends while its script's one
  // `agent()` child waits for its release, and the chat is killed there.
  const background = await cli.chat([
    'chat',
    '--agent',
    'golden_background',
    '--model',
    'gpt56',
    '--approval-policy',
    'yolo',
  ]);
  await until(
    'the idle background chat',
    () => background.screen().includes('Ctrl-C exit'),
    background,
  );
  background.write('Send the script to the background.');
  await until(
    'the typed background instruction',
    () => background.screen().includes('› Send the script to the background.'),
    background,
  );
  background.write('\r');
  const childOf = (parent) =>
    query(
      cli.store(),
      `SELECT s.logical_id AS id FROM event e
       JOIN event_sequence s ON s.id = e.aggregate
       WHERE e.type = 'run.start' AND json_extract(e.data, '$.parent.id') = ?
       ORDER BY e."commit"`,
      [parent],
    )[0]?.id;
  const backgroundRows = (run, sql) =>
    query(
      cli.store(),
      `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = ? AND ${sql}`,
      [run],
    ).length;
  // The parent and its script run are two fibers of one process: the
  // parent's reply is held (`golden-background-reply.release`) until the
  // script's child waits at its model call, then the parent ends its turn
  // alone, so the two runs' rows commit in one order.
  const backgroundParent = await until(
    'the background child at its model call',
    () => {
      const parent = query(cli.store(), RUN_OF_AGENT, ['golden_background'])[0]
        ?.id;
      const script = parent && childOf(parent);
      const child = script && childOf(script);
      return (
        child !== undefined &&
        backgroundRows(
          child,
          `e.type = 'model.message'
           AND json_extract(e.data, '$.payload.kind') = 'attempt'`,
        ) > 0 &&
        parent
      );
    },
    background,
  );
  writeFileSync(path.join(root, 'golden-background-reply.release'), '');
  // The turn's last row is its `conversation.progress`, published after
  // `waiting`: the kill waits for it too.
  await until(
    'the background parent waiting',
    () =>
      backgroundRows(
        backgroundParent,
        `e.type = 'run.position'
         AND json_extract(e.data, '$.payload.at') = 'waiting'
         AND json_extract(e.data, '$.payload.turn') = 1`,
      ) > 0 &&
      backgroundRows(backgroundParent, `e.type = 'conversation.progress'`) > 0,
    background,
  );
  background.kill('SIGKILL');
  await background.exited;

  // The tombstone: a finished run deleted last, before any later open could
  // collect it.
  const before = new Set(
    query(cli.store(), RUN_OF_AGENT, ['golden_child']).map((row) => row.id),
  );
  cli.run([
    'run',
    'golden_child',
    '--model',
    'gpt56',
    '--instruction',
    'A run to delete.',
    '--approval-policy',
    'never',
    '--output-format',
    'json',
    '--print',
  ]);
  const doomed = query(cli.store(), RUN_OF_AGENT, ['golden_child'])
    .map((row) => row.id)
    .find((id) => !before.has(id));
  if (doomed === undefined) fail('no golden_child run to delete');
  cli.run(['history', 'delete', doomed, '--yes', '--print']);
  return cli.store();
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ZSTD_LEVEL_3 = { params: { [constants.ZSTD_c_compressionLevel]: 3 } };
const REF_SHAPED = /^\$+b$/;
const renameKeys = (value, rename) =>
  Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      REF_SHAPED.test(key) ? rename(key) : key,
      field,
    ]),
  );

/** A row's payload with its blob references inflated and its escaped keys
 *  restored: the value the codec encoded (`rowCodec.ts`, `parseData`). */
function inflate(data, blobs) {
  return JSON.parse(data, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return value;
    if (!('$b' in value)) return renameKeys(value, (key) => key.slice(1));
    const text = blobs.get(value.$b);
    if (text === undefined) fail(`missing blob ${value.$b}`);
    return JSON.parse(text);
  });
}

/** The codec's encoding of a payload (`rowCodec.ts`, `encodeDraft`): each
 *  string of 4096+ characters outlined under the sha256 of its JSON text. */
function outline(payload) {
  const blobs = new Map();
  const data = JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'string' && value.length >= 4096) {
      const json = JSON.stringify(value);
      const digest = sha256(json);
      blobs.set(digest, json);
      return { $b: digest };
    }
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? renameKeys(value, (key) => `$${key}`)
      : value;
  });
  return { data, blobs };
}

/** One replacement per distinct value, handed out in the order values are
 *  first met. */
function tokens(make) {
  const seen = new Map();
  return {
    seen,
    get(value) {
      if (!seen.has(value)) seen.set(value, make(seen.size + 1, value));
      return seen.get(value);
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Keys whose value is a random 21-character id, alone or behind a prefix
 *  such as `plan-`. */
const NANO_KEYS = new Set(['id', 'logId', 'stageId', 'attemptId', 'requestId']);
const NANO = /^(?:[a-z]+-)?([A-Za-z0-9_-]{21})$/;
/** A goal's random id (`goal_` and 12 hex digits). */
const GOAL_ID = /goal_[0-9a-f]{12}/g;
/** Numbers that measure wall time. */
const TIMING_KEYS = new Set([
  'wallTimeMs',
  'durationMs',
  'responseTimeMs',
  'elapsedMs',
  'elapsedTime',
]);
const BASE_AT = Date.UTC(2026, 0, 1);

function normalize(file, root) {
  const db = new DatabaseSync(file);
  const events = db
    .prepare(
      'SELECT "commit", aggregate, type, origin, data FROM event ORDER BY "commit"',
    )
    .all();
  const stored = new Map(
    db
      .prepare('SELECT digest, value FROM blob')
      .all()
      .map((row) => [
        row.digest,
        zstdDecompressSync(row.value).toString('utf8'),
      ]),
  );
  const sequences = db
    .prepare('SELECT * FROM event_sequence ORDER BY id')
    .all();
  const origins = tokens((n) =>
    JSON.stringify(['golden-host', n, `process-${n}`]),
  );
  const uuids = tokens(
    (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
  );
  const nanos = tokens((n) => `golden${n.toString().padStart(15, '0')}`);
  const goals = tokens((n) => `goal_${n.toString(16).padStart(12, '0')}`);
  const times = tokens((n) => new Date(BASE_AT + n * 1000).toISOString());
  const ids = tokens(
    (n, id) => `a${n.toString(16).padStart(id.length - 1, '0')}`,
  );
  for (const row of sequences) uuids.get(row.uid);
  const rows = events.map((row) => ({
    ...row,
    value: inflate(row.data, stored),
  }));
  // The random ids a row names, so every occurrence maps alike.
  const collect = (value, key) => {
    if (typeof value === 'string') {
      for (const match of value.match(UUID) ?? []) uuids.get(match);
      for (const match of value.match(ISO) ?? []) times.get(match);
      for (const match of value.match(GOAL_ID) ?? []) goals.get(match);
      if (NANO_KEYS.has(key) && NANO.test(value))
        nanos.get(NANO.exec(value)[1]);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value))
      collect(v, Array.isArray(value) ? key : k);
  };
  for (const row of rows) collect(row.value, '');

  // An `agent` call's child run is named by the call (`agentChildRunId`:
  // its run, response, call and attempt), so a resume finds it by deriving
  // that name again. Such a child is renamed by the same derivation over
  // the normalized names, not by order, or no resume would find it.
  const derive = (fields) =>
    createHash('sha256')
      .update(stableStringify(fields))
      .digest('hex')
      .slice(0, 24);
  const logicalOf = new Map(sequences.map((row) => [row.id, row.logical_id]));
  const children = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.type !== 'script.call' || row.value.payload.toolName !== 'agent')
      continue;
    const { scriptCallId, callId } = row.value.payload;
    const intents = rows.filter(
      (other) =>
        other.aggregate === row.aggregate && other.type === 'tool.intent',
    );
    const responseId = rows
      .slice(0, index)
      .findLast(
        (other) =>
          intents.includes(other) &&
          other.value.payload.origin.kind === 'response' &&
          other.value.payload.callIds.includes(scriptCallId),
      )?.value.payload.origin.responseId;
    for (const intent of intents) {
      const { origin, callIds, attempt } = intent.value.payload;
      if (origin.kind !== 'script' || !callIds.includes(callId)) continue;
      const parentRunId = logicalOf.get(row.aggregate);
      const fields = { parentRunId, responseId, callId, attempt };
      children.set(derive(fields), fields);
    }
  }
  // A background script's run is named by the `script` call that sent it,
  // the same derivation: the parent's settled call names the run it
  // launched (`{ runId }`).
  for (const row of rows) {
    if (row.type !== 'run.start' || row.value.identity?.kind !== 'script')
      continue;
    const runId = logicalOf.get(row.aggregate);
    const parentRunId = row.value.parent?.id;
    const launch = rows.find(
      (other) =>
        other.type === 'tool.result' &&
        logicalOf.get(other.aggregate) === parentRunId &&
        other.value.payload.result.value?.runId === runId,
    );
    if (launch === undefined) fail(`no launching call for script run ${runId}`);
    const { responseId, callId, attempt } = launch.value.payload;
    const fields = { parentRunId, responseId, callId, attempt };
    if (derive(fields) !== runId)
      fail(`script run ${runId} is not named by its launching call`);
    children.set(runId, fields);
  }
  for (const row of sequences) {
    const fields = children.get(row.logical_id);
    if (fields === undefined) ids.get(row.logical_id);
    else
      ids.seen.set(
        row.logical_id,
        derive({
          ...fields,
          parentRunId: ids.get(fields.parentRunId),
          responseId: uuids.get(fields.responseId),
        }),
      );
  }

  const roots = [...new Set([realpathSync.native(root), root])].sort(
    (a, b) => b.length - a.length,
  );
  const replacements = [
    ...roots.map((prefix) => [prefix, '/golden']),
    // The bundle's own resources, which the system prompt lists.
    [realpathSync.native(validationRoot), '/texra'],
    ...goals.seen,
    ...[...ids.seen].map(([from, to]) => [
      new RegExp(`(?<![0-9a-f])${from}(?![0-9a-f])`, 'g'),
      to,
    ]),
    ...uuids.seen,
    ...nanos.seen,
    ...times.seen,
    [/Date: \d{4}-\d{2}-\d{2}/g, 'Date: 2026-01-01'],
    [/Platform: [^\n]*/g, 'Platform: golden'],
    [/Shell: [^\n]*/g, 'Shell: golden'],
    [/<wall-time>[^<]*<\/wall-time>/g, '<wall-time>0s</wall-time>'],
    [/"durationMs":\d+/g, '"durationMs":0'],
    // A workflow call's wall time in its run-log line.
    [/ · (?:\d+m )?\d+s · \$/g, ' · 0s · $'],
  ];
  const digests = new Map();
  const scrubText = (text) => {
    let out = text;
    for (const [from, to] of replacements)
      out =
        typeof from === 'string'
          ? out.split(from).join(to)
          : out.replace(from, to);
    return out.replace(
      /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g,
      (digest) => digests.get(digest) ?? digest,
    );
  };
  const scrub = (value, key = '') => {
    if (typeof value === 'string') return scrubText(value);
    if (typeof value === 'number') return TIMING_KEYS.has(key) ? 0 : value;
    if (Array.isArray(value)) return value.map((item) => scrub(item, key));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [scrubText(k), scrub(v, k)]),
    );
  };
  const canonical = (text) => stableStringify(scrub(JSON.parse(text)));
  // A context blob is stored as its canonical JSON under that text's
  // sha256, and one blob names others (a request names its tools), so the
  // new addresses are found to a fixed point.
  const contexts = rows.filter((row) => row.type === 'context.blob');
  for (let changed = true; changed;) {
    changed = false;
    for (const { value } of contexts) {
      const next = sha256(canonical(value.payload.value));
      if (digests.get(value.payload.digest) !== next) {
        digests.set(value.payload.digest, next);
        changed = true;
      }
    }
  }

  db.exec('PRAGMA foreign_keys = OFF; BEGIN');
  db.exec('DELETE FROM event_blob; DELETE FROM blob');
  const updateEvent = db.prepare(
    'UPDATE event SET origin = ?, at = ?, data = ? WHERE "commit" = ?',
  );
  const insertBlob = db.prepare('INSERT OR IGNORE INTO blob VALUES (?, ?)');
  const insertRef = db.prepare('INSERT INTO event_blob VALUES (?, ?)');
  for (const row of rows) {
    let payload = scrub(row.value);
    if (row.type === 'context.blob') {
      const value = canonical(row.value.payload.value);
      payload = { ...payload, payload: { digest: sha256(value), value } };
    }
    const encoded = outline(payload);
    updateEvent.run(
      origins.get(row.origin),
      // One second per commit: two batches can share a millisecond, so the
      // stamps a batch shares cannot be told apart from the rows.
      BASE_AT + row.commit * 1000,
      encoded.data,
      row.commit,
    );
    for (const [digest, json] of encoded.blobs) {
      insertBlob.run(digest, zstdCompressSync(json, ZSTD_LEVEL_3));
      insertRef.run(row.commit, digest);
    }
  }
  const updateSequence = db.prepare(
    'UPDATE event_sequence SET logical_id = ?, uid = ?, owner_id = ? WHERE id = ?',
  );
  for (const row of sequences)
    updateSequence.run(
      ids.get(row.logical_id),
      uuids.get(row.uid),
      row.owner_id === null ? null : origins.get(row.owner_id),
      row.id,
    );
  for (const [table, column, keys] of [
    ['projected_row', 'data', ['"commit"', 'type']],
    ['run_usage', 'usage', ['aggregate']],
    ['current_value', 'value', ['family', 'key']],
  ]) {
    const where = keys.map((key) => `${key} = ?`).join(' AND ');
    const update = db.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE ${where}`,
    );
    for (const row of db
      .prepare(`SELECT ${column} AS v, ${keys.join(', ')} FROM ${table}`)
      .all())
      update.run(
        JSON.stringify(scrub(JSON.parse(row.v))),
        ...keys.map((key) => row[key.replaceAll('"', '')]),
      );
  }
  const updateKey = db.prepare(
    'UPDATE listing_entry SET key = ? WHERE aggregate = ? AND key = ?',
  );
  for (const row of db
    .prepare('SELECT aggregate, key FROM listing_entry')
    .all())
    updateKey.run(scrubText(row.key), row.aggregate, row.key);
  db.exec('UPDATE current_value SET at = 0; COMMIT');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0)
    fail(`foreign keys broken: ${JSON.stringify(violations)}`);
  db.close();
}

/** SQLite's `.dump` of the store, with the two header fields `.dump` leaves
 *  out and a store needs to open: `user_version` and `application_id`. */
function dump(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const quote = (value) => {
    if (value === null) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint')
      return String(value);
    if (value instanceof Uint8Array)
      return `X'${Buffer.from(value).toString('hex').toUpperCase()}'`;
    return `'${String(value).replaceAll("'", "''")}'`;
  };
  const lines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  const schema = db
    .prepare(
      'SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid',
    )
    .all();
  for (const { type, name, sql } of schema) {
    if (type !== 'table' || name === 'sqlite_sequence') continue;
    lines.push(`${sql};`);
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
    const order = columns.map((_, i) => i + 1).join(', ');
    for (const row of db
      .prepare(`SELECT * FROM "${name}" ORDER BY ${order}`)
      .all())
      lines.push(
        `INSERT INTO ${name} VALUES(${columns.map((c) => quote(row[c.name])).join(',')});`,
      );
  }
  lines.push('DELETE FROM sqlite_sequence;');
  for (const row of db
    .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
    .all())
    lines.push(
      `INSERT INTO sqlite_sequence VALUES(${quote(row.name)},${row.seq});`,
    );
  for (const { type, sql } of schema)
    if (type !== 'table') lines.push(`${sql};`);
  const header = (pragma) => db.prepare(`PRAGMA ${pragma}`).get()[pragma];
  lines.push(`PRAGMA user_version=${header('user_version')};`);
  lines.push(`PRAGMA application_id=${header('application_id')};`);
  lines.push('COMMIT;');
  db.close();
  return `${lines.join('\n')}\n`;
}

if (!noBuild) build();
if (!existsSync(binaryPath)) fail(`no validation bundle at ${binaryPath}`);
const root = mkdtempSync(path.join(tmpdir(), 'texra-golden-'));
try {
  const store = await generate(root);
  const copy = path.join(root, 'golden.db');
  const source = new DatabaseSync(store, { readOnly: true });
  source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  source.close();
  normalize(copy, root);
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, dump(copy));
  console.log(`[golden-store] wrote ${path.relative(repoRoot, fixturePath)}`);
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}
