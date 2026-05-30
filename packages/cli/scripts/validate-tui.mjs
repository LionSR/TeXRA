#!/usr/bin/env node
// Deterministic PTY frame-capture validator for the CLI TUI (issue #4709).
//
// Launches the bundled `dist/bin/tui-harness.js` under a pseudo-terminal,
// renders the byte stream through a headless terminal emulator, drives a few
// product-focused scenarios with raw keystrokes, and asserts that the text a
// human would see is actually on screen. It fails with a readable frame
// snippet when expected UI text disappears — the regression we keep hitting as
// the live-region / scrollback layout evolves.
//
// This is intentionally small: a handful of scenarios that exercise the
// transcript, queued follow-ups, a slash command, an approval modal, the
// subagent panel + task picker, and the Ctrl-C exit path. It is NOT a general
// terminal-automation framework.
//
// Run:  node scripts/validate-tui.mjs        (from packages/cli)
//   or: pnpm --filter @texra-ai/cli validate:tui
//
// Deps: node-pty (PTY; optional — native) and @xterm/headless (pure JS). If
// node-pty is unavailable (e.g. CI without build tools), the validator prints a
// notice and exits 0 so it never breaks installs that opt out of the native dep.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3); // Ctrl-C

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(dirname, '..');
const HARNESS =
  process.env.TEXRA_TUI_HARNESS ||
  path.join(CLI_ROOT, 'dist', 'bin', 'tui-harness.js');

// --- scenarios (verified against the committed harness) ------------------
const SCENARIOS = [
  {
    name: 'transcript',
    env: { HARNESS_ENTRIES: '8' },
    expect: [
      'TeXRA',
      'agent: chat · model: harness-model',
      'chat history line to grow the transcript pane',
      '◆',
      '[Ctrl-C]exit',
    ],
  },
  {
    name: 'queued-followups',
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_QUEUED_FOLLOWUPS:
        'First queued follow-up||Second queued follow-up',
    },
    frame: 'tail',
    expect: ['queued 2', 'First queued', 'Second queued'],
  },
  {
    name: 'slash-palette',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/mo'],
    expect: ['/model', 'List available models', 'navigate', 'Tab complete'],
  },
  {
    name: 'edit-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    expect: ['Apply edit to draft.tex?', 'y approve', 'n reject', 'approval'],
  },
  {
    name: 'subagents',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    expect: ['strategy', 'leanSolver', 'reviewer', '3 sub', '[Tab]streams'],
  },
  {
    name: 'task-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    keys: [ESC + 'p'], // Option/Alt-p
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'Enter view',
      'k kill',
      'Esc close',
    ],
  },
  {
    name: 'empty-task-picker',
    env: {
      HARNESS_ENTRIES: '4',
    },
    keys: [ESC + 'p'],
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'No active tasks or sub-workflows.',
      'Esc close',
    ],
    unexpect: ['Enter view', 'k kill', 'navigate'],
  },
  {
    name: 'task-picker-parent-fallback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    keys: [ESC + 's', '\r', ESC + 'p'],
    expect: [
      'Tasks and sub-workflows',
      'Stream: main (strategy has no tasks or sub-workflows)',
      'strategy',
      'latex build',
    ],
  },
  {
    name: 'todos',
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    expect: [
      'Split theorem into algebraic and analytic checks',
      'Route proof obligations',
    ],
  },
  {
    name: 'ctrl-c-exit',
    env: { HARNESS_ENTRIES: '4' },
    keys: [ETX],
    expectExit: true,
  },
];

const only = process.argv.slice(2);
const scenarioNames = new Set(SCENARIOS.map((s) => s.name));
const unknownScenarios = [
  ...new Set(only.filter((name) => !scenarioNames.has(name))),
];
if (unknownScenarios.length > 0) {
  console.error(
    `[validate-tui] unknown scenario${unknownScenarios.length === 1 ? '' : 's'}: ${unknownScenarios.join(', ')}`,
  );
  console.error(
    `[validate-tui] available scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}
const scenarios = only.length
  ? SCENARIOS.filter((s) => only.includes(s.name))
  : SCENARIOS;

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;

  try {
    const require = createRequire(import.meta.url);
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

// --- optional deps (guarded) ---------------------------------------------
let ptySpawn;
let Terminal;
try {
  ensureNodePtySpawnHelperExecutable();
  const ptyMod = await import('node-pty');
  ptySpawn = ptyMod.spawn ?? ptyMod.default?.spawn;
  const xtermMod = await import('@xterm/headless');
  Terminal = xtermMod.Terminal ?? xtermMod.default?.Terminal;
  if (typeof ptySpawn !== 'function' || typeof Terminal !== 'function') {
    throw new Error('node-pty/@xterm/headless did not expose the expected API');
  }
} catch (err) {
  console.error(
    '[validate-tui] skipped — install the TUI dev deps to run this validator:\n' +
      '  pnpm --filter @texra-ai/cli add -D node-pty @xterm/headless\n' +
      `  (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(0);
}

// --- harness bundle ------------------------------------------------------
if (process.env.TEXRA_TUI_HARNESS) {
  if (!existsSync(HARNESS)) {
    console.error('[validate-tui] custom harness does not exist:', HARNESS);
    process.exit(1);
  }
} else {
  // Rebuild the committed harness on every run so local TUI source edits are
  // tested against the current tree instead of a stale dist/bin artifact.
  console.error('[validate-tui] building tui-harness bundle…');
  const r = spawnSync(
    process.execPath,
    [path.join(CLI_ROOT, 'scripts', 'build-harness.mjs')],
    { cwd: CLI_ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0 || !existsSync(HARNESS)) {
    console.error('[validate-tui] failed to build', HARNESS);
    process.exit(1);
  }
}

const COLS = Number(process.env.TUI_VALIDATE_COLS ?? '100');
const ROWS = Number(process.env.TUI_VALIDATE_ROWS ?? '40');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTerm() {
  return new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 8000,
    allowProposedApi: true,
  });
}

// Render the whole buffer (scrollback included) so finalized <Static> rows that
// scrolled above the viewport still count as "on screen for the session".
function renderFrame(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i += 1) {
    const ln = buf.getLine(i);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function frameTail(frame) {
  const lines = frame.split('\n');
  return lines.slice(-Math.min(lines.length, ROWS)).join('\n');
}

async function runScenario(scenario) {
  const term = makeTerm();
  let lastData = Date.now();
  let exited = null;
  let writeQueue = Promise.resolve();
  const frameSnapshot = async () => {
    await writeQueue;
    return renderFrame(term);
  };
  const childEnv = {
    ...process.env,
    ...scenario.env,
    TERM: 'xterm-256color',
    FORCE_COLOR: '3',
    COLUMNS: String(COLS),
    LINES: String(ROWS),
  };
  // The validator intentionally exercises an interactive TTY. Inherited CI
  // markers make Ink choose a non-interactive render mode and hide the live
  // input/status surface this script is meant to inspect.
  delete childEnv.CI;
  delete childEnv.NO_COLOR;
  const child = ptySpawn(process.execPath, [HARNESS], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: CLI_ROOT,
    env: childEnv,
  });
  child.onExit((e) => (exited = e));
  child.onData((d) => {
    lastData = Date.now();
    writeQueue = writeQueue.then(
      () => new Promise((resolve) => term.write(d, resolve)),
    );
  });

  // boot: wait for the interactive input/status area to settle. Static
  // transcript user rows also contain "›", so use the status binding instead
  // of the prompt glyph as the readiness sentinel.
  const bootDeadline = Date.now() + 15000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    await sleep(150);
    if (exited) break;
    if (
      (await frameSnapshot()).includes('[/status]details') &&
      Date.now() - lastData > 600
    ) {
      booted = true;
      break;
    }
  }

  for (const key of scenario.keys ?? []) {
    child.write(key);
    await sleep(500);
  }

  // settle after keystrokes
  const settleDeadline = Date.now() + 4000;
  while (Date.now() < settleDeadline && Date.now() - lastData < 500)
    await sleep(120);
  await sleep(250);

  const fullFrame = await frameSnapshot();
  const frame = scenario.frame === 'tail' ? frameTail(fullFrame) : fullFrame;

  // exit cleanly: Ctrl-C (a second one if the first only interrupts a run)
  for (let attempt = 0; attempt < 2 && !exited; attempt += 1) {
    child.write(ETX);
    const ctrlcDeadline = Date.now() + 2500;
    while (!exited && Date.now() < ctrlcDeadline) await sleep(100);
  }
  const exitedCleanly = exited?.exitCode === 0 && !exited.signal;
  if (!exited) {
    try {
      child.kill();
    } catch {}
  }

  const missing = (scenario.expect ?? []).filter((t) => !frame.includes(t));
  const present = (scenario.unexpect ?? []).filter((t) => frame.includes(t));
  const failures = [];
  if (!booted) failures.push('input prompt never rendered (boot timeout)');
  for (const t of missing)
    failures.push(`expected text missing: ${JSON.stringify(t)}`);
  for (const t of present)
    failures.push(`unexpected text present: ${JSON.stringify(t)}`);
  if (scenario.expectExit && !exitedCleanly) {
    const exitDetails = exited
      ? ` (exitCode ${exited.exitCode}, signal ${exited.signal || 'none'})`
      : '';
    failures.push(`Ctrl-C did not exit the TUI cleanly${exitDetails}`);
  }

  return { name: scenario.name, ok: failures.length === 0, failures, frame };
}

let failed = 0;
for (const scenario of scenarios) {
  // eslint-disable-next-line no-await-in-loop
  const result = await runScenario(scenario);
  if (result.ok) {
    console.log(`✓ ${result.name}`);
  } else {
    failed += 1;
    console.log(`✗ ${result.name}`);
    for (const f of result.failures) console.log(`    - ${f}`);
    console.log('    --- captured frame (tail) ---');
    console.log(
      frameTail(result.frame)
        .split('\n')
        .map((l) => `    | ${l}`)
        .join('\n'),
    );
  }
}

console.log('');
console.log(
  failed === 0
    ? `validate-tui: all ${scenarios.length} scenarios passed`
    : `validate-tui: ${failed}/${scenarios.length} scenario(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
