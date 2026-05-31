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
//   or: node scripts/validate-tui.mjs --snapshot-dir /tmp/tui-frames slash-palette
//
// Deps: node-pty (PTY; optional — native) and @xterm/headless (pure JS). If
// node-pty is unavailable (e.g. CI without build tools), the validator prints a
// notice and exits 0 so it never breaks installs that opt out of the native dep.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3); // Ctrl-C
const DC2 = String.fromCharCode(18); // Ctrl-R
const DOWN = ESC + '[B';
const LONG_BASH_APPROVAL_COMMAND = [
  "python3 << 'EOF'",
  'solutions = []',
  'for y in range(1, 100):',
  '    x2 = 1 + 2 * y * y',
  '    x = int(x2 ** 0.5)',
  '    if x * x == x2:',
  '        solutions.append((x, y))',
  '        if x != 0:',
  '            solutions.append((-x, y))',
  'solutions.sort()',
  'print("All integer pairs (x,y) with 0<y<100:")',
  'print(solutions)',
  'EOF',
].join('\n');
const LONG_EXTERNAL_INQUIRY_ANSWER =
  'Independent check agrees: there are 22 non-degenerate triples in the displayed list, plus exactly 61 degenerate triples of the form (0,b,b), and the bounded search over integer pairs proves completeness.';

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
    name: 'btw-palette',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/bt'],
    expect: [
      '/btw',
      'Queue a follow-up without interrupting the active run',
      'Enter complete',
      'Tab complete',
    ],
  },
  {
    name: 'btw-submit',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/btw check the finite case later', '\r'],
    frame: 'tail',
    expect: [
      'Queued follow-up: check the finite case later',
      'queued 1',
      'check the finite case later',
    ],
    unexpect: ['registered but has no harness action'],
  },
  {
    name: 'agent-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/agent', '\r'],
    expect: ['/agent', 'Tool-use agents', 'Esc close'],
    unexpect: ['Platform not initialized', '/agent - error'],
  },
  {
    name: 'model-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: ['/model · personal API keys', 'Available models'],
    unexpect: ['Platform not initialized', '/model - error'],
  },
  {
    name: 'api-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r'],
    frame: 'tail',
    expect: ['/api', 'Personal API keys', 'Included relay'],
    unexpect: ['ServerSideKeyService not initialized'],
  },
  {
    name: 'tools-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/tools', '\r'],
    frame: 'tail',
    expect: ['/tools', 'Toggle available external integrations'],
    unexpect: ['[TeXRA]', 'toolUtils'],
  },
  {
    name: 'slash-palette-overflow',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/', DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN],
    frame: 'tail',
    expect: [
      '… 7 earlier',
      '/status',
      'Open the session status tabs',
      '/btw',
      'Queue a follow-up without interrupting the active run',
      '/exit',
      'Exit the CLI session',
    ],
  },
  {
    name: 'edit-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    expect: [
      'Apply edit to draft.tex?',
      'y approve',
      'n reject',
      'approval',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['[Alt-p]tasks', '[Option-p]tasks', '[/model]models'],
  },
  {
    name: 'edit-approval-approve',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    keys: ['y'],
    frame: 'tail',
    expect: ['[/status]details', '[/model]models'],
    unexpect: ['Apply edit to draft.tex?', '1 approval'],
  },
  {
    name: 'bash-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    expect: [
      'Run bash command?',
      '$ npm run compile:safe',
      'y approve',
      'a approve session',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['[Alt-p]tasks', '[Option-p]tasks', '[/model]models'],
    maxBlankLinesBetween: [{ from: '╚', to: 'Tip:', max: 1 }],
  },
  {
    name: 'long-bash-approval',
    rows: 24,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: 'Use foreground panel shortcuts',
    expect: [
      'Run bash command?',
      "$ python3 << 'EOF'",
      'more rows',
      'scroll command',
      'y approve',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['╚═    print', '[Option-p]tasks'],
    maxBlankLinesBetween: [{ from: '╚', to: 'Tip:', max: 1 }],
  },
  {
    name: 'compact-long-bash-approval',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: 'Use foreground panel shortcuts',
    frame: 'tail',
    expect: [
      'Run bash command?',
      "$ python3 << 'EOF'",
      'rows hidden',
      'y approve',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['╚═    print', 'scroll command', '[Option-p]tasks'],
    maxBlankLinesBetween: [{ from: '╚', to: 'Tip:', max: 1 }],
  },
  {
    name: 'bash-approval-approve-session',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    keys: ['a'],
    frame: 'tail',
    expect: ['AUTO-BASH', '[/status]details', '[/model]models'],
    unexpect: ['AUTO-APPROVE', 'Run bash command?', '1 approval'],
  },
  {
    name: 'external-inquiry-long',
    rows: 24,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER],
    frame: 'tail',
    expect: [
      'Agent asks:',
      'more rows',
      'PgUp/PgDn question',
      'Enter submit answer',
      'Ctrl-R reject with note',
    ],
    unexpect: ['└─Degenerate triples', '[/model]models'],
    maxBlankLinesBetween: [{ from: '└', to: 'Tip:', max: 1 }],
  },
  {
    name: 'plan-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_PLAN_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'y approve',
      'n reject',
    ],
    unexpect: ['r approve & run', '[/model]models'],
  },
  {
    name: 'plan-approval-odyssey',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_ODYSSEY: '1',
    },
    bootExpect: 'Use foreground panel shortcuts',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'Split the finite and symbolic cases',
      'r approve & run',
      'y approve',
      'n reject',
    ],
    unexpect: ['[/model]models'],
  },
  {
    name: 'plan-approval-approve-odyssey',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_ODYSSEY: '1',
    },
    bootExpect: 'Use foreground panel shortcuts',
    keys: ['r'],
    frame: 'tail',
    expect: ['PLAN-ODYSSEY', '[/status]details', '[/model]models'],
    unexpect: ['Approve plan?', '1 approval'],
  },
  {
    name: 'plan-approval-ctrl-r-ignored',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_ODYSSEY: '1',
    },
    bootExpect: 'Use foreground panel shortcuts',
    keys: [DC2],
    frame: 'tail',
    expect: ['Approve plan?', 'r approve & run', '1 approval'],
    unexpect: ['PLAN-ODYSSEY', '[/model]models'],
  },
  {
    name: 'edit-approval-reject',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: 'Use foreground panel shortcuts',
    keys: ['n'],
    frame: 'tail',
    expect: ['[/status]details', '[/model]models'],
    unexpect: ['Apply edit to draft.tex?', '1 approval'],
  },
  {
    name: 'subagents',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    expect: [
      'strategy',
      'leanSolver',
      'reviewer',
      'main.tex: Proof sketch',
      '3 sub',
      '[Tab]streams',
    ],
  },
  {
    name: 'subagent-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's'], // Option/Alt-s
    expect: [
      'Subagents',
      'Stream: main',
      'strategy',
      'leanSolver',
      'reviewer',
      'Enter focus',
      'Esc close',
    ],
    unexpect: ['Tasks and sub-workflows', 'latex build'],
    maxBlankLinesBetween: [{ from: '╰', to: 'Tip:', max: 1 }],
  },
  {
    name: 'task-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p'], // Option/Alt-p
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'Enter view',
      'k kill',
      'Esc close',
    ],
    maxBlankLinesBetween: [
      {
        from: 'entry-4 chat history line',
        to: 'Tasks and sub-workflows',
        max: 3,
      },
      { from: '╰', to: 'Tip:', max: 1 },
    ],
  },
  {
    name: 'task-subworkflow-detail',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', '\r'],
    expect: [
      'Task details',
      'stream · strategy',
      'Description: strategy sub-workflow',
      'Please handle the harness-child-strategy sub-workflow.',
      'f focus stream',
      'Esc back',
    ],
    unexpect: ['Command:  strategy sub-workflow'],
  },
  {
    name: 'task-process-detail',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', DOWN, DOWN, DOWN, '\r'],
    expect: [
      'Task details',
      'shell · latex build',
      'Command:     latex build',
      'main.tex: Proof sketch needs one missing reference',
      'k kill',
      'Esc back',
    ],
  },
  {
    name: 'narrow-subagent-picker',
    cols: 60,
    rows: 18,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's'], // Option/Alt-s
    frame: 'tail',
    expect: ['Subagents', 'Stream: main', 'strategy', 'Enter focus'],
    unexpect: ['sub-workfl\now', '\n────╯'],
    maxBlankLinesBetween: [{ from: '╰', to: 'Tip:', max: 1 }],
  },
  {
    name: 'narrow-task-picker',
    cols: 60,
    rows: 18,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p'], // Option/Alt-p
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'strategy',
      'Enter view',
    ],
    unexpect: ['sub-workfl\now', '\n────╯'],
    maxBlankLinesBetween: [{ from: '╰', to: 'Tip:', max: 1 }],
  },
  {
    name: 'stopped-subagent-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', 'k', ESC + 's', DOWN, DOWN, 'k'],
    expect: [
      'Subagents',
      'Stream: main',
      '› 3. strategy — stopped',
      'Enter focus',
      'Esc close',
    ],
    unexpect: [
      'k kill',
      'Harness kill requested for harness-child-strategy.\n\nHarness kill requested for harness-child-strategy.',
    ],
    maxBlankLinesBetween: [{ from: '╰', to: 'Tip:', max: 1 }],
  },
  {
    name: 'focused-stopped-subagent',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', 'k', ESC + 's', DOWN, DOWN, '\r'],
    frame: 'tail',
    expect: ['[3:strategy](stopped)', '◆ stopped api', '[Ctrl-C]stop root'],
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
    maxBlankLinesBetween: [
      {
        from: 'entry-4 chat history line',
        to: 'Tasks and sub-workflows',
        max: 4,
      },
      { from: '╰', to: 'Tip:', max: 1 },
    ],
  },
  {
    name: 'task-picker-parent-fallback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
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
  {
    name: 'ctrl-c-interrupt-active',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ETX],
    frame: 'tail',
    expect: [
      'Harness interrupt requested.',
      '[main](stopped)',
      '◆ stopped api',
    ],
  },
];

function parseArgs(argv) {
  const scenarios = [];
  let snapshotDir;
  let endOfOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!endOfOptions && arg === '--') {
      // pnpm forwards a leading separator to scripts (`pnpm run x -- --flag`).
      // Treat only that package-manager separator as transparent; later `--`
      // still follows normal end-of-options behavior.
      if (index === 0 && argv[1]?.startsWith('--snapshot-dir')) continue;
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg === '--snapshot-dir') {
      const value = argv[index + 1];
      if (!value) {
        console.error('[validate-tui] --snapshot-dir requires a directory');
        process.exit(1);
      }
      snapshotDir = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (!endOfOptions && arg?.startsWith('--snapshot-dir=')) {
      const value = arg.slice('--snapshot-dir='.length);
      if (!value) {
        console.error('[validate-tui] --snapshot-dir requires a directory');
        process.exit(1);
      }
      snapshotDir = path.resolve(process.cwd(), value);
      continue;
    }
    if (!endOfOptions && arg?.startsWith('--')) {
      console.error(`[validate-tui] unknown option: ${arg}`);
      console.error(
        '[validate-tui] usage: node scripts/validate-tui.mjs [--snapshot-dir DIR] [scenario ...]',
      );
      process.exit(1);
    }
    scenarios.push(arg);
  }
  return { scenarios, snapshotDir };
}

const args = parseArgs(process.argv.slice(2));
const only = args.scenarios;
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
const snapshotDir = args.snapshotDir;

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

const DEFAULT_COLS = Number(process.env.TUI_VALIDATE_COLS ?? '100');
const DEFAULT_ROWS = Number(process.env.TUI_VALIDATE_ROWS ?? '40');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scenarioCols(scenario) {
  return Number(scenario.cols ?? DEFAULT_COLS);
}

function scenarioRows(scenario) {
  return Number(scenario.rows ?? DEFAULT_ROWS);
}

function makeTerm(scenario) {
  return new Terminal({
    cols: scenarioCols(scenario),
    rows: scenarioRows(scenario),
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

function frameTail(frame, rows) {
  const lines = frame.split('\n');
  return lines.slice(-Math.min(lines.length, rows)).join('\n');
}

function blankLinesBetween(frame, from, to) {
  const lines = frame.split('\n');
  const toIndex = lines.findLastIndex((line) => line.includes(to));
  if (toIndex < 0) return undefined;
  const fromIndex = lines
    .slice(0, toIndex)
    .findLastIndex((line) => line.includes(from));
  if (fromIndex < 0) return undefined;
  return lines
    .slice(fromIndex + 1, toIndex)
    .filter((line) => line.trim().length === 0).length;
}

function snapshotFileName(index, name) {
  const prefix = String(index + 1).padStart(2, '0');
  return `${prefix}-${name.replace(/[^a-z0-9._-]+/gi, '-')}.txt`;
}

function resetSnapshotDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d+-[a-z0-9._-]+\.txt$/i.test(entry.name)) {
      continue;
    }
    unlinkSync(path.join(dir, entry.name));
  }
}

function writeSnapshot(index, name, frame, rows) {
  if (!snapshotDir) return;
  const file = path.join(snapshotDir, snapshotFileName(index, name));
  const content = frameTail(frame, rows);
  writeFileSync(file, `${content}${content.endsWith('\n') ? '' : '\n'}`);
}

async function runScenario(scenario) {
  const term = makeTerm(scenario);
  const cols = scenarioCols(scenario);
  const rows = scenarioRows(scenario);
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
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  // The validator intentionally exercises an interactive TTY. Inherited CI
  // markers make Ink choose a non-interactive render mode and hide the live
  // input/status surface this script is meant to inspect.
  delete childEnv.CI;
  delete childEnv.NO_COLOR;
  const child = ptySpawn(process.execPath, [HARNESS], {
    name: 'xterm-256color',
    cols,
    rows,
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
  // transcript user rows also contain "›", so use the status-bar marker
  // instead of the prompt glyph as the readiness sentinel. Binding text is
  // width-adaptive and may omit labels such as /status in narrow terminals.
  const bootDeadline = Date.now() + 15000;
  const bootExpect = scenario.bootExpect ?? '◆';
  let booted = false;
  while (Date.now() < bootDeadline) {
    await sleep(150);
    if (exited) break;
    if (
      (await frameSnapshot()).includes(bootExpect) &&
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
  const frame =
    scenario.frame === 'tail' ? frameTail(fullFrame, rows) : fullFrame;

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
  for (const check of scenario.maxBlankLinesBetween ?? []) {
    const actual = blankLinesBetween(frame, check.from, check.to);
    if (actual === undefined) {
      failures.push(
        `could not find compactness markers: ${JSON.stringify(check.from)} → ${JSON.stringify(check.to)}`,
      );
    } else if (actual > check.max) {
      failures.push(
        `too many blank lines between ${JSON.stringify(check.from)} and ${JSON.stringify(check.to)}: ${actual} > ${check.max}`,
      );
    }
  }
  if (scenario.expectExit && !exitedCleanly) {
    const exitDetails = exited
      ? ` (exitCode ${exited.exitCode}, signal ${exited.signal || 'none'})`
      : '';
    failures.push(`Ctrl-C did not exit the TUI cleanly${exitDetails}`);
  }

  return {
    name: scenario.name,
    ok: failures.length === 0,
    failures,
    frame,
    fullFrame,
    rows,
  };
}

if (snapshotDir) resetSnapshotDir(snapshotDir);

let failed = 0;
for (const [index, scenario] of scenarios.entries()) {
  // eslint-disable-next-line no-await-in-loop
  const result = await runScenario(scenario);
  writeSnapshot(index, result.name, result.fullFrame, result.rows);
  if (result.ok) {
    console.log(`✓ ${result.name}`);
  } else {
    failed += 1;
    console.log(`✗ ${result.name}`);
    for (const f of result.failures) console.log(`    - ${f}`);
    console.log('    --- captured frame (tail) ---');
    console.log(
      frameTail(result.frame, result.rows)
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
if (snapshotDir) console.log(`validate-tui: wrote snapshots to ${snapshotDir}`);
process.exit(failed === 0 ? 0 : 1);
