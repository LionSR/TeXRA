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
 * `goldenTurn` in `packages/harness/src/agent/runtime/run/validationModel.ts`, over the agents
 * in `src/test-kernel/fixtures/storage/agents/`; this script orders the runs,
 * each in its own process and every one finishes cleanly: interrupted states
 * are the crash suite's (`crashConformance.ts`), which truncates a clean
 * store at each commit.
 *
 * - `golden_parent` (headless, `yolo`): a `read_file` call; a `plan` update
 *   the policy approves (a decided `planApproval` request); and an
 *   `agent` child that looks its parent up and messages it, which
 *   is refused: a one-shot parent never reads a message. Headless
 *   delegation runs in band, so every row commits in one order.
 * - two `review` runs over the same notes: the context blobs they share.
 * - a `polish` document task with `--output`: the documents plugin's output
 *   fact and the CLI's `run.result` (producer `cliWorkflow`).
 * - `golden_chat`, the interactive `texra chat` driven under a PTY, with
 *   "Keep agents running" turned on in `/config` and a plugin's
 *   `PostToolUse` hook on `codex` enabled: a plan the user runs as a goal
 *   (`r` on the approval, the `goal` plugin fact) and the goal completed,
 *   then `/model` and a message, so the switch is recorded at the run's
 *   next model boundary; then `/compact`, whose turn commits a
 *   `context.edit` replacing the history; then a turn whose approved
 *   `codex` call runs the hook (`hook.outcome`) and launches a Codex child,
 *   on a stand-in Codex CLI first on PATH, that parks after its turn
 *   (`child.park`); then the turn held, a message typed behind it, and the
 *   user's stop, which detaches the child (`run.detach`), so that
 *   follow-up stays queued; the exit ends the child. The stand-in is a
 *   POSIX script, so the generator runs on macOS and Linux. Only the chat
 *   makes a goal: the headless policy approves a plan without one. Each
 *   keystroke
 *   waits for the screen or the store to show the step before it, so the
 *   rows commit in one order.
 * - `golden_script` (headless, `yolo`): a `script` call whose guest finds
 *   its read tool with `searchTools` and `describeTool`, then reads and runs
 *   one command in a `Promise.all`.
 * - `golden_fork` (headless), then `texra resume --fork` under a PTY: the
 *   fork, whose `run.start.provenance` names its source and whose first
 *   history row is a `context.edit` (cause `fork`); then `texra resume
 *   --handoff` on the fork: a `context.edit` (cause `handoff`).
 * - `golden_effect` (headless, `yolo`): its command
 *   appends to `approved.txt`, then a plugin's `PostToolUse` hook on `bash`
 *   holds the call, and the process is killed (`SIGKILL`) there. A call's
 *   PostToolUse rows commit with its settlement, so the store holds the
 *   command's intent and no result: the consequential crash, after an
 *   external effect and before its result commits. The file it left is the
 *   fixture's artifact (`golden-effect/approved.txt`), which the golden
 *   suite puts back before it resumes the run.
 * - one `golden_child` run, deleted with `texra history delete` once
 *   `texra serve` holds the project open: the tombstoned run, which no
 *   later open is left to collect.
 * - last, a `golden_script` task in that service (`texra tasks start`) that
 *   sends a shell command to the background, and the service's
 *   `task.resume` of the finished command: a run with no agent record, so
 *   the resume closes its input (`followup.closed`). No open follows, which
 *   would remove the finished command; `texra tasks stop` ends the task.
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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
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
/** The killed command's effect, kept beside the store it was killed in. */
const effectPath = path.join(
  path.dirname(fixturePath),
  'golden-effect',
  'approved.txt',
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
/** The processes a step starts, reaped however the generation ends. */
const spawned = new Set();
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
  writeFileSync(
    path.join(project, 'paper.tex'),
    '\\section{Input}\nThe golden document task polishes this file.\n',
  );
  // The Codex CLI the Codex child runs: first on PATH, with an empty global
  // npm prefix so no installed Codex is found first. Its one turn answers
  // once it has read its prompt and `codex.release` appears beside the flag.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const release = require('node:path').join(__dirname, '..', 'codex.release');
const events = [
  { type: 'thread.started', thread_id: 'golden-codex-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Codex answered.' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
];
process.stdin.resume();
process.stdin.on('end', function answer() {
  // A generation that failed removed its root: there is no turn to answer.
  if (!existsSync(release))
    return existsSync(__dirname) ? setTimeout(answer, 20) : process.exit(1);
  for (const event of events) console.log(JSON.stringify(event));
});
`,
    { mode: 0o755 },
  );
  // A plugin whose \`PostToolUse\` hook sees each \`codex\` call.
  const hooks = path.join(root, 'golden-hooks');
  mkdirSync(path.join(hooks, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(hooks, 'hooks'));
  writeFileSync(
    path.join(hooks, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'golden-hooks', version: '1.0.0' })}\n`,
  );
  writeFileSync(
    path.join(hooks, 'hooks', 'hooks.json'),
    `${JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'codex',
            hooks: [
              {
                type: 'command',
                command: 'node',
                args: ['-e', 'process.stdin.resume()'],
              },
            ],
          },
        ],
      },
    })}\n`,
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
    // The helper model's provider: a run's session label (`run.description`).
    DEEPSEEK_API_KEY: FAKE_KEY,
    PATH: [bin, process.env.PATH].join(path.delimiter),
    npm_config_prefix: path.join(root, 'npm'),
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
    // Each chat is its runs' one writer, in the generator's order; a
    // service would outlive the generation.
    TEXRA_NO_SERVICE: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL: '1',
    TEXRA_INTERNAL_VALIDATE_MODEL_FLAG: flag,
    TEXRA_INTERNAL_VALIDATE_REQUEST_CONTEXT: '1',
    TEXRA_INTERNAL_VALIDATE_GOLDEN: '1',
  };
  const argv = (command) => [binaryPath, ...command, '--cwd', project];
  const run = (command, input, runEnv = env) => {
    const result = spawnSync(process.execPath, argv(command), {
      cwd: project,
      env: runEnv,
      encoding: 'utf8',
      input,
    });
    if (result.status !== 0)
      fail(
        `texra ${command.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
      );
    return result.stdout;
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
    spawned.add(child);
    let done = false;
    child.onData((data) => term.write(data));
    const exited = new Promise((resolve) =>
      child.onExit((exit) => {
        spawned.delete(child);
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
      screen,
      exited,
      output: screen,
      done: () => done,
    };
  };
  // The project's store; the service keeps one for no workspace beside it.
  const store = () => {
    const dir = path.join(home, '.texra/v1/workspace-storage');
    const key = existsSync(dir)
      ? readdirSync(dir).find((name) => name.startsWith('project-'))
      : undefined;
    return key === undefined ? null : path.join(dir, key, 'texra.db');
  };
  // `texra serve` in the foreground, as a window's service, for `use`,
  // which runs its client commands (`texra tasks`) and calls procedures
  // over its socket (the Effect RPC NDJSON framing), hearing each one's
  // exit; then `texra service stop`.
  const serve = async (use) => {
    const { TEXRA_NO_SERVICE: _, ...serviceEnv } = env;
    const service = spawn(process.execPath, argv(['serve']), {
      cwd: project,
      env: serviceEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawned.add(service);
    service.on('exit', () => spawned.delete(service));
    let log = '';
    service.stderr.on('data', (data) => (log += data));
    const exited = new Promise((resolve) => service.on('exit', resolve));
    const record = path.join(home, '.texra/run/serve.json');
    const handle = { done: () => service.exitCode !== null, output: () => log };
    await until('the service', () => existsSync(record), handle);
    const { socket } = JSON.parse(readFileSync(record, 'utf8'));
    const call = (tag, payload) =>
      new Promise((resolve, reject) => {
        const client = connect(socket);
        let buffered = '';
        client.on('error', reject);
        // A connection that ends without the exit fails the call (a settled
        // call ignores it).
        client.on('close', () =>
          reject(new Error(`the service closed ${tag} unanswered\n${log}`)),
        );
        client.on('data', (data) => {
          buffered += data;
          try {
            for (let end; (end = buffered.indexOf('\n')) >= 0;) {
              const message = JSON.parse(buffered.slice(0, end));
              buffered = buffered.slice(end + 1);
              if (message._tag !== 'Exit') continue;
              resolve(message.exit);
              client.end();
            }
          } catch (error) {
            reject(error);
            client.destroy();
          }
        });
        client.write(
          `${JSON.stringify({ _tag: 'Request', id: '0', tag, payload, headers: [] })}\n`,
        );
      });
    const client = (command) => run(command, undefined, serviceEnv);
    await use({ client, call, handle });
    run(['service', 'stop']);
    const code = await exited;
    if (code !== 0) fail(`texra serve exited ${code}\n${log}`);
  };
  // A headless run in the background, for the generator to kill.
  const start = (command) => {
    const child = spawn(process.execPath, argv(command), {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        spawned.delete(child);
        resolve({ code, signal });
      }),
    );
    return {
      exited,
      kill: () => child.kill('SIGKILL'),
      done: () => child.exitCode !== null || child.signalCode !== null,
      output: () => output,
    };
  };
  return { run, start, chat, serve, store, project, hooks };
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
  cli.run(['tools', 'enable', 'multi-agent', '--print']);

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

  // A document task through `texra run --output`: the documents plugin's
  // output fact and the CLI's `run.result` (producer `cliWorkflow`).
  cli.run([
    'run',
    'polish',
    '--model',
    'gpt56',
    '--input',
    'paper.tex',
    '--output',
    'paper.polished.tex',
    '--approval-policy',
    'never',
    '--output-format',
    'json',
    '--print',
  ]);

  // The chat's Codex call runs the hook plugin's `PostToolUse` hook.
  cli.run(['tools', 'enable', 'codex', '--print']);
  cli.run(['plugin', 'install', cli.hooks, '--print']);
  cli.run(['plugin', 'enable', 'golden-hooks', '--print'], 'y\n');

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
  // "Keep agents running" on, in `/config`: the user's stop detaches the
  // chat's Codex child instead of stopping it.
  /** Press the hotkey the open list shows for `label`. */
  const pick = async (label) => {
    const pattern = new RegExp(`(\\w)\\. ${label}`);
    const [, key] = await until(
      `the ${label} row`,
      () => pattern.exec(tty.screen()),
      tty,
    );
    tty.write(key);
  };
  await send('/config');
  await pick('Tasks and agents');
  await pick('Keep agents running — off');
  await shows('the setting on', 'Keep agents running — on');
  tty.write('\x1b');
  await shows('the settings categories', 'Tasks and agents —');
  tty.write('\x1b');
  await until(
    'the closed /config',
    () => !tty.screen().includes('/config'),
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
  // A `/compact` wakes the chat: its turn's request commits the
  // `context.edit` that replaces the history with its summary.
  await send('/compact');
  await shows('the compaction notice', 'Context compaction requested');
  await waiting(3);
  // A turn that launches a Codex child and is then held, a message typed
  // behind it, and the user's stop: the follow-up stays queued on the
  // stopped run, and the stop detaches the parked child.
  await send('Hold this turn.');
  await shows('the Codex call approval', 'y approve');
  tty.write('y');
  const rowsOf = (runId, sql) =>
    query(
      cli.store(),
      `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
       WHERE s.logical_id = ? AND ${sql}`,
      [runId],
    ).length;
  const chatRows = (sql) => rowsOf(chatRun(), sql);
  const codexRows = (sql) =>
    rowsOf(query(cli.store(), RUN_OF_AGENT, ['codex'])[0]?.id, sql);
  // The held model call, after the Codex call's result: the Codex turn
  // answers only then, so its rows commit after the chat's.
  await until(
    'the held model call',
    () =>
      chatRows(`e.type = 'model.message'
        AND json_extract(e.data, '$.payload.kind') = 'attempt'
        AND e."commit" > (SELECT r."commit" FROM event r
          WHERE r.aggregate = e.aggregate AND r.type = 'tool.result'
            AND json_extract(r.data, '$.payload.callId') LIKE 'validation-codex-%')`) >
        0 && tty.screen().includes('Ctrl-C stop'),
    tty,
  );
  writeFileSync(path.join(root, 'codex.release'), '');
  await until(
    'the parked Codex child',
    () =>
      codexRows(`e.type = 'child.park'
        AND json_extract(e.data, '$.phase') = 'parked'`) > 0,
    tty,
  );
  tty.write('Queued behind the held turn.');
  await shows('the typed follow-up', '› Queued behind the held turn.');
  tty.write('\r');
  // Two messages typed to the open chat, the Codex turn's result, and this.
  await until(
    'the queued follow-up',
    () =>
      chatRows(`e.type = 'followup.queued'
        AND json_extract(e.data, '$.control') IS NULL`) === 4,
    tty,
  );
  tty.write('\x03');
  await until(
    'the stopped chat',
    () =>
      chatRows(`e.type = 'run.position'
        AND json_extract(e.data, '$.payload.at') = 'halted'`) > 0 &&
      codexRows(`e.type = 'run.detach'`) > 0,
    tty,
  );
  await shows('the idle prompt', 'Ctrl-C exit');
  tty.write('\x03');
  const exit = await tty.exited;
  if (exit.exitCode !== 0)
    fail(`texra chat exited ${exit.exitCode}\n${tty.screen()}`);
  cli.run(['plugin', 'disable', 'golden-hooks', '--print']);

  cli.run([
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

  // The fork and its handoff (durable harness, H5): a headless run answers
  // once; `texra resume --fork` continues a new task holding that
  // conversation, whose `run.start` names its source; `texra resume
  // --handoff` then continues the fork from a note alone. Each reply names
  // the user messages its view held.
  cli.run([
    'run',
    'golden_fork',
    '--model',
    'gpt56',
    '--instruction',
    'Before the fork.',
    '--approval-policy',
    'never',
    '--output-format',
    'json',
    '--print',
  ]);
  const forkSource = query(cli.store(), RUN_OF_AGENT, ['golden_fork'])[0]?.id;
  if (forkSource === undefined) fail('no golden_fork run to fork');
  /** Resume under a PTY with `flags`, type `message` once the chat idles
   *  (null: the flags start the turn), and exit once `reply` shows. */
  const resumeChat = async (flags, message, reply) => {
    const starts = () =>
      query(cli.store(), `SELECT 1 FROM event WHERE type = 'run.start'`).length;
    const before = starts();
    const tty = await cli.chat(['resume', ...flags]);
    const shows = (label, text) =>
      until(label, () => tty.screen().includes(text), tty);
    if (message !== null) {
      // Typed once the new run has offered its tools, so the message
      // commits after its activation, not among its rows.
      await until(
        'the new run offering its tools',
        () =>
          starts() > before &&
          query(
            cli.store(),
            `SELECT 1 FROM event e WHERE e.type = 'tools.offered'
             AND e.aggregate = (SELECT aggregate FROM event
               WHERE type = 'run.start' ORDER BY "commit" DESC LIMIT 1)`,
          ).length > 0,
        tty,
      );
      await shows('the idle resumed chat', 'Ctrl-C exit');
      tty.write(message);
      await shows(`the typed ${JSON.stringify(message)}`, `› ${message}`);
      tty.write('\r');
    }
    await shows(`the reply ${JSON.stringify(reply)}`, reply);
    await shows('the idle prompt', 'Ctrl-C exit');
    tty.write('\x03');
    const exit = await tty.exited;
    if (exit.exitCode !== 0)
      fail(
        `texra resume ${flags.join(' ')} exited ${exit.exitCode}\n${tty.screen()}`,
      );
  };
  await resumeChat(
    [forkSource, '--fork'],
    'After the fork.',
    'Saw: Before the fork. | After the fork.',
  );
  const forked = query(cli.store(), RUN_OF_AGENT, ['golden_fork']).find(
    (row) => row.id !== forkSource,
  )?.id;
  if (forked === undefined) fail('the fork started no run');
  await resumeChat(
    [forked, '--handoff', 'The handoff note.'],
    null,
    'Saw: The handoff note.',
  );

  // The consequential crash: the command's effect lands, then its
  // PostToolUse hook holds the call until the process is killed, before
  // the command's result commits.
  const held = path.join(root, 'golden-effect-hooks');
  mkdirSync(path.join(held, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(held, 'hooks'));
  writeFileSync(
    path.join(held, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'golden-effect-hooks', version: '1.0.0' })}\n`,
  );
  const started = path.join(root, 'golden-effect.started');
  writeFileSync(
    path.join(held, 'hooks', 'hooks.json'),
    `${JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'bash',
            hooks: [
              {
                type: 'command',
                command: 'node',
                args: [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(started)}, ''); setTimeout(() => {}, 60_000)`,
                ],
              },
            ],
          },
        ],
      },
    })}\n`,
  );
  cli.run(['plugin', 'install', held, '--print']);
  cli.run(['plugin', 'enable', 'golden-effect-hooks', '--print'], 'y\n');
  const effect = cli.start([
    'run',
    'golden_effect',
    '--model',
    'gpt56',
    '--instruction',
    'Run the command.',
    '--approval-policy',
    'yolo',
    '--output-format',
    'json',
    '--print',
  ]);
  await until('the held command', () => existsSync(started), effect);
  effect.kill();
  await effect.exited;
  cli.run(['plugin', 'disable', 'golden-effect-hooks', '--print']);
  mkdirSync(path.dirname(effectPath), { recursive: true });
  cpSync(path.join(cli.project, 'approved.txt'), effectPath);

  // The tombstone's run: a finished run, deleted in the service step below
  // with no later open left to collect it.
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

  // The service (`texra serve`, a window's), last: its task sends a shell
  // command to the background, which runs once `bash.release` appears and
  // reports back. The service's `task.resume` of that finished command, a
  // run with no agent record, closes its input (`followup.closed`) and
  // refuses it. No open follows, which would remove the finished command.
  // The service follows the project's persisted policy (the user's local
  // config beside its store), never a client's: Auto-approve, so the
  // background command runs unasked.
  const localConfig = path.join(path.dirname(cli.store()), 'config.json');
  writeFileSync(
    localConfig,
    `${JSON.stringify({
      ...(existsSync(localConfig)
        ? JSON.parse(readFileSync(localConfig, 'utf8'))
        : {}),
      'texra.approvalPolicy': 'yolo',
    })}\n`,
  );
  await cli.serve(async ({ client, call, handle: service }) => {
    // The tombstone, made once the service holds the project open (any
    // project call opens it): a later open would collect it.
    await call('request.preview', { workspace: cli.project, requestId: '-' });
    cli.run(['history', 'delete', doomed, '--yes', '--print']);
    const { runId: task } = JSON.parse(
      client([
        'tasks',
        'start',
        'golden_script',
        '--model',
        'gpt56',
        '--instruction',
        'Run in the background.',
        '--approval-policy',
        'yolo',
        '--output-format',
        'json',
      ]),
    );
    const rowsOf = (runId, sql) =>
      query(
        cli.store(),
        `SELECT 1 FROM event e JOIN event_sequence s ON s.id = e.aggregate
         WHERE s.logical_id = ? AND ${sql}`,
        [runId],
      ).length;
    const waited = (turn) =>
      until(
        `the service task waiting after turn ${turn}`,
        () =>
          rowsOf(
            task,
            `e.type = 'run.position'
             AND json_extract(e.data, '$.payload.at') = 'waiting'
             AND json_extract(e.data, '$.payload.turn') = ${turn}`,
          ) > 0,
        service,
      );
    await waited(1);
    writeFileSync(path.join(root, 'bash.release'), '');
    await waited(2);
    const [shell] = query(
      cli.store(),
      `SELECT s.logical_id AS id FROM event e
       JOIN event_sequence s ON s.id = e.aggregate
       WHERE e.type = 'run.start'
         AND json_extract(e.data, '$.identity.tool') = 'bash'`,
    );
    if (shell === undefined) fail('no background command run to resume');
    const resumed = await call('task.resume', {
      workspace: cli.project,
      runId: shell.id,
    });
    if (resumed._tag !== 'Failure')
      fail(`the service resumed ${shell.id}: ${JSON.stringify(resumed)}`);
    await until(
      'the closed input',
      () => rowsOf(shell.id, `e.type = 'followup.closed'`) > 0,
      service,
    );
    client(['tasks', 'stop', task]);
    await until(
      'the stopped service task',
      () => rowsOf(task, `e.type = 'run.end'`) > 0,
      service,
    );
  });

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
const NANO_KEYS = new Set([
  'id',
  'logId',
  'stageId',
  'attemptId',
  'requestId',
  'operationId',
]);
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
          other.value.payload.callId === scriptCallId,
      )?.value.payload.origin.responseId;
    for (const intent of intents) {
      const { origin, attempt } = intent.value.payload;
      if (origin.kind !== 'script' || intent.value.payload.callId !== callId)
        continue;
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
    // The project's storage folder, named by a hash of its temporary path.
    [
      /workspace-storage\/project-[0-9a-f]+/g,
      'workspace-storage/project-golden',
    ],
    [/Date: \d{4}-\d{2}-\d{2}/g, 'Date: 2026-01-01'],
    [/Platform: [^\n]*/g, 'Platform: golden'],
    [/Shell: [^\n]*/g, 'Shell: golden'],
    [/<wall-time>[^<]*<\/wall-time>/g, '<wall-time>0s</wall-time>'],
    [/"durationMs":\d+/g, '"durationMs":0'],
    // A process child's turn time in its run-log line.
    [/Turn completed in [\dhms ]+/g, 'Turn completed in 1s'],
    // A call's wall time in its run-log line.
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
  for (const child of spawned) child.kill('SIGKILL');
  if (!keep) rmSync(root, { recursive: true, force: true });
}
