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
//   or: node scripts/validate-tui.mjs --no-build slash-palette
//
// `--snapshot-dir` writes per-scenario `.txt` and `.svg` frames plus an
// `index.html` report for quick visual review in a browser or GitHub issue.
//
// Deps: node-pty (PTY; native) and @xterm/headless (pure JS). Missing deps fail
// by default so validation cannot look green without exercising any frames.
// Pass --skip-if-missing-deps only in environments that intentionally opt out.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3); // Ctrl-C
const DC2 = String.fromCharCode(18); // Ctrl-R
const DC4 = String.fromCharCode(20); // Ctrl-T
const NAK = String.fromCharCode(21); // Ctrl-U
const EM = String.fromCharCode(25); // Ctrl-Y
const LF = String.fromCharCode(10); // Ctrl-J
const KITTY_SHIFT_ENTER = ESC + '[13;2u';
const UP = ESC + '[A';
const DOWN = ESC + '[B';
const PAGE_DOWN = ESC + '[6~';
const ANSI_SGR_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*m`, 'g');
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
const ASYNC_FORM_SETTLE_MS = 12000;
const VISIBLE_TOOL_USE_AGENTS_WITHOUT_CHAT = [
  'research',
  'review',
  'creator',
  'latexDiff',
  'latexFixer',
  'lean',
  'numerics',
  'presenter',
  'setup',
].join('||');

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(dirname, '..');
const DEFAULT_HARNESS_RELATIVE_PATH = path.join(
  'dist',
  'bin',
  'tui-harness.js',
);
const HARNESS = process.env.TEXRA_TUI_HARNESS
  ? path.resolve(process.env.TEXRA_TUI_HARNESS)
  : path.resolve(CLI_ROOT, DEFAULT_HARNESS_RELATIVE_PATH);

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
    cols: 120,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_QUEUED_FOLLOWUPS:
        'First queued follow-up||Second queued follow-up',
    },
    bootExpect: 'queued 2',
    frame: 'tail',
    expect: [
      'Queued follow-ups (2)',
      '1. First queued follow-up',
      '2. Second queued follow-up',
      'queued 2',
      '[Ctrl-C]stop',
    ],
    unexpect: ['Tip: Ctrl-C exits idle chats', 'First queued follo…'],
  },
  {
    name: 'queued-subagent-followup-summary',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_QUEUED_FOLLOWUPS:
        '<orchestrator-followup><subagent-result id="child-q" agent="reviewer" category="toolUse" status="completed"><response>All good &lt;ok&gt;</response></subagent-result></orchestrator-followup>',
    },
    bootExpect: 'queued 1',
    keys: ['/status', '\r'],
    frame: 'tail',
    expect: [
      'queued follow-ups: 1',
      '1. ✓ reviewer completed All good <ok>',
      'Queued follow-ups (1)',
    ],
    unexpect: ['<orchestrator-followup>', '<subagent-result'],
  },
  {
    name: 'compact-queued-followups',
    rows: 8,
    cols: 60,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_QUEUED_FOLLOWUPS:
        'First queued follow-up||Second queued follow-up',
    },
    bootExpect: 'queued 2',
    frame: 'tail',
    expect: [
      'Queued follow-ups (2)',
      '1. First queued follow-up',
      '2. Second queued follow-up',
      '│ ›',
      'queued 2',
      '[Ctrl-C]stop',
    ],
    unexpect: ['Tip: Ctrl-C exits idle chats', 'agent: chat · model'],
  },
  {
    name: 'subagent-followup-summary',
    env: { HARNESS_ENTRIES: '0', HARNESS_SUBAGENT_FOLLOWUPS: '1' },
    expect: [
      '⟳ strategy · round 2/3',
      '✓ leanSolver completed · 2min, 3sec',
      'Proved </response> is escaped & visible.',
      '✗ reviewer failed (retryable)',
      'rate limit: <tokens> & retries exhausted',
    ],
    unexpect: ['<subagent-progress', '<subagent-result', '<subagent-error'],
  },
  {
    name: 'long-tool-output-elided',
    env: { HARNESS_ENTRIES: '0', HARNESS_LONG_TOOL_OUTPUT: '1' },
    expect: [
      '● bash (python3 enumerate_triples.py)',
      'tool-output-line-01',
      '… +9 lines (ctrl + t to view transcript)',
      'tool-output-line-18',
    ],
    unexpect: ['tool-output-line-10 hidden-middle'],
  },
  {
    name: 'bash-rejection-deduped',
    env: { HARNESS_ENTRIES: '0', HARNESS_REJECTED_BASH_TOOL: '1' },
    expect: [
      "● bash (printf 'approval-reject-live\\n')",
      "⎿ User rejected bash command: printf 'approval-reject-live\\n'",
    ],
    maxOccurrences: [
      {
        text: "User rejected bash command: printf 'approval-reject-live\\n'",
        max: 1,
      },
    ],
  },
  {
    name: 'transcript-viewer-long-tool-output',
    cols: 80,
    env: { HARNESS_ENTRIES: '0', HARNESS_LONG_TOOL_OUTPUT: '1' },
    keys: [DC4],
    frame: 'tail',
    expect: [
      'tool-output-line-10 hidden-middle',
      'wide-column-F',
      'tool-output-line-18',
      'PgUp/PgDn page',
      'Esc close',
    ],
  },
  {
    name: 'orchestrate-launcher',
    env: { HARNESS_ORCHESTRATION: '1' },
    bootExpect: 'Choose how to start this CLI session.',
    exitKeys: [ESC],
    expectExit: true,
    expect: [
      'TeXRA',
      'Choose how to start this CLI session.',
      'New chat',
      'Team Lean Project',
      '2/7 tool-use agents',
      'unavailable',
      'no runnable team root',
      'Team Physicist',
      'Team Computer Scientist…',
      'Help',
      '1-9/a-z/Enter open',
      'Esc exit',
    ],
    unexpect: ['[/model]models', 'Tip:', 'tool-use:', 'workflow:'],
  },
  {
    name: 'compact-orchestrate-launcher',
    rows: 10,
    cols: 80,
    env: { HARNESS_ORCHESTRATION: '1' },
    bootExpect: 'Choose how to start this CLI session.',
    exitKeys: [ESC],
    expectExit: true,
    frame: 'tail',
    expect: [
      'TeXRA',
      'Choose how to start this CLI session.',
      'New chat',
      'Team Lean Project',
      'unavailable',
      '2/7 tool-u',
      '... 2 more',
      '1-9/a-z/Enter open',
      'Esc exit',
    ],
    unexpect: ['[/model]models', 'Tip:', 'tool-use:', 'workflow:'],
  },
  {
    name: 'orchestrate-relay-model-pick',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'included',
    },
    bootExpect: 'Choose how to start this CLI session.',
    keys: ['\r'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model · included relay',
      'Model for the first message.',
      'Sonnet 4.6 (Thinking) — relay: included',
      'GPT-5.4 — relay: included',
      'Esc back',
    ],
    unexpect: ['DeepSeek V4 Flash', 'api: api key set', 'personal API keys'],
  },
  {
    name: 'orchestrate-personal-model-pick',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'personal',
    },
    bootExpect: 'Choose how to start this CLI session.',
    keys: ['\r'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model · personal API keys',
      'Model for the first message.',
      'DeepSeek V4 Flash — api: api key set',
      'Esc back',
    ],
    unexpect: [
      'Sonnet 4.6 (Thinking)',
      'GPT-5.4',
      'relay: included',
      'included relay',
    ],
  },
  {
    name: 'orchestrate-no-runnable-models',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'personal',
      HARNESS_NO_RUNNABLE_MODELS: '1',
    },
    bootExpect: 'Choose how to start this CLI session.',
    keys: ['1'],
    exitKeys: [ESC],
    expectExit: true,
    expect: [
      'Choose how to start this CLI session.',
      'New chat',
      'No personal API-key models are runnable',
      'Help',
      'Esc exit',
    ],
    unexpect: ['Model · personal API keys', 'DeepSeek V4 Flash'],
  },
  {
    name: 'slash-palette',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/mo'],
    expect: [
      '/model',
      'List available models',
      'navigate',
      'Esc close',
      'Tab complete',
    ],
  },
  {
    name: 'narrow-slash-palette-command-names',
    rows: 16,
    cols: 52,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/'],
    frame: 'tail',
    expect: [
      '/api',
      'Switch between included relay',
      '/login',
      'Sign in to TeXRA included access',
      '/logout',
      'Sign out of TeXRA',
    ],
    unexpect: [
      '/ap  Switch',
      '/log  Sign',
      'personal API keys',
      'automatically',
    ],
    maxLineColumns: 52,
  },
  {
    name: 'slash-palette-ctrl-u-clears-raw-control',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/', `${NAK}/model\r`],
    frame: 'tail',
    expect: ['/model · personal API keys', 'Available models'],
    unexpect: ['/\u0015/model', '/model - error'],
  },
  {
    name: 'plain-submit',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['prove the bounded case for n <= 20', '\r'],
    frame: 'tail',
    expect: ['Harness received: prove the bounded case for n <= 20'],
    unexpect: ['signal read during notification phase', 'ERROR'],
  },
  {
    name: 'kitty-shift-enter-newline',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['first line', KITTY_SHIFT_ENTER, 'second line', '\r'],
    frame: 'tail',
    expect: ['Harness received: first line\nsecond line'],
    unexpect: ['first linesecond line', '13;2u', '[13', 'ERROR'],
  },
  {
    name: 'ctrl-j-newline',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['first line', LF, 'second line', '\r'],
    frame: 'tail',
    expect: ['Harness received: first line\nsecond line'],
    unexpect: ['first linesecond line', 'ERROR'],
  },
  {
    name: 'agent-form',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: VISIBLE_TOOL_USE_AGENTS_WITHOUT_CHAT,
    },
    keys: ['/agent', '\r'],
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Tool-use and orchestrator agents',
      'Current: chat (hidden from picker)',
      'texra chat --agent=<name>',
      'Esc close',
    ],
    unexpect: [
      'Platform not initialized',
      '/agent - error',
      'texra --agent=<name>',
    ],
  },
  {
    name: 'agent-form-80-cols',
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: VISIBLE_TOOL_USE_AGENTS_WITHOUT_CHAT,
    },
    keys: ['/agent', '\r'],
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Tool-use and orchestrator agents',
      'Current: chat (hidden from picker)',
      'texra chat --agent=<name>',
      'Esc close',
    ],
    unexpect: [
      'Platform not initialized',
      '/agent - error',
      'texra --agent=<name>',
    ],
    maxLineColumns: 80,
  },
  {
    name: 'model-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: [
      '/model · personal API keys',
      'Available models. Finish the active response before switching models.',
      'Enter close',
    ],
    unexpect: [
      'Platform not initialized',
      '/model - error',
      'texra chat --model=<name>',
      'texra --model=<name>',
    ],
  },
  {
    name: 'no-color-model-form',
    colorEnabled: false,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: [
      '/model · personal API keys',
      'Available models. Finish the active response before switching models.',
      'Enter close',
    ],
    unexpect: ['Platform not initialized', '/model - error'],
    rawUnexpectSgr: true,
  },
  {
    name: 'model-form-selectable',
    env: {
      HARNESS_CAN_SELECT_MODEL: '1',
      HARNESS_ENTRIES: '4',
    },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: [
      '/model · personal API keys',
      'Choose the model for future turns.',
      '1-9/a-z',
      'select',
    ],
    unexpect: [
      'Finish the active response before switching models.',
      'Enter close',
      'Platform not initialized',
      '/model - error',
    ],
  },
  {
    name: 'model-switch-compatible-only',
    env: {
      ANTHROPIC_API_KEY: 'harness-anthropic-key',
      HARNESS_CAN_SELECT_MODEL: '1',
      HARNESS_DISABLED_MODEL_SWITCHES: 'sonnet46T||opus48T',
      HARNESS_ENTRIES: '4',
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/model · personal API keys',
      'Choose the model for future turns.',
      'Sonnet 4.6',
      'different conversation format',
      'GPT-5.5',
    ],
    unexpect: [
      'Harness model selected.',
      'Finish the active response before switching models.',
      'Platform not initialized',
      '/model - error',
    ],
  },
  {
    name: 'model-form-selectable-submit',
    env: {
      HARNESS_CAN_SELECT_MODEL: '1',
      HARNESS_ENTRIES: '4',
    },
    keys: ['/model', '\r', '\r'],
    frame: 'tail',
    expect: ['Harness model selected. Future turns:'],
    unexpect: [
      'Finish the active response before switching models.',
      'Platform not initialized',
      '/model - error',
    ],
  },
  {
    name: 'model-form-included-empty',
    env: {
      HARNESS_AUTHENTICATED: '1',
      HARNESS_API_MODE: 'included',
      HARNESS_ENTRIES: '4',
    },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: [
      '/model · included relay',
      'No included relay models are runnable.',
      'Switch with /api personal or try again later.',
      'Enter close',
    ],
    unexpect: ['No models are available in this API mode.'],
  },
  {
    name: 'api-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: ['/api', 'api:', 'auth:', 'Personal API keys', 'Included relay'],
    unexpect: ['loading API status...', 'ServerSideKeyService not initialized'],
  },
  {
    name: 'approval-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/approval', '\r'],
    frame: 'tail',
    expect: [
      '/approval',
      'Choose when privileged actions prompt or auto-approve.',
      'Ask',
      'Never',
      'Auto-approve',
      'Enter select highlighted',
      'Esc cancel',
      '[Esc]cancel',
    ],
  },
  {
    name: 'tools-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/tools', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/tools',
      'Toggle available external integrations',
      'always on ·',
      'enabled · detected · Ready',
    ],
    unexpect: ['[TeXRA]', 'toolUtils', 'enabled -', 'TeXRA CLI'],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/tools', max: 8 },
    ],
  },
  {
    name: 'skills-form',
    env: { HARNESS_ENTRIES: '4', HARNESS_PROJECT_SKILL: '1' },
    keys: ['/skills', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/skills',
      'Select a skill to activate it.',
      'proof-audit',
      'project · Review mathematical proof steps.',
      'Enter activate',
      'Esc close',
    ],
    unexpect: [
      'No skills found',
      '/skills - error',
      'Platform not initialized',
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/skills', max: 8 },
    ],
  },
  {
    name: 'skills-form-select-submit',
    env: { HARNESS_ENTRIES: '4', HARNESS_PROJECT_SKILL: '1' },
    keys: ['/skills', '\r', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: ['Harness skill selected: proof-audit.'],
    unexpect: [
      'No skills found',
      '/skills - error',
      'Platform not initialized',
    ],
  },
  {
    name: 'compact-agent-form',
    rows: 12,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: VISIBLE_TOOL_USE_AGENTS_WITHOUT_CHAT,
    },
    keys: ['/agent', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Current: chat (hidden from picker)',
      'Tool-use and orchestrator agents',
      '+8 more',
      '↑/↓ navigate',
      'Enter close',
      'Esc close',
    ],
    unexpect: ['Platform not initialized', '/agent - error'],
  },
  {
    name: 'compact-model-form',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/model', '\r'],
    frame: 'tail',
    expect: [
      '/model · personal API keys',
      'Available models',
      '+3 more',
      '↑/↓ navigate',
      'Enter close',
      'Esc close',
    ],
    unexpect: ['Platform not initialized', '/model - error'],
  },
  {
    name: 'compact-api-form',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r'],
    frame: 'tail',
    expect: [
      '/api',
      'Personal API keys',
      'Included relay',
      '↑/↓ navigate',
      '1-2/Enter select',
      'Esc close',
    ],
    unexpect: ['ServerSideKeyService not initialized'],
  },
  {
    name: 'api-form-buffered-hotkey',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r', '21'],
    frame: 'tail',
    expect: ['API mode set to included.'],
    unexpect: ['ServerSideKeyService not initialized'],
  },
  {
    name: 'compact-approval-form',
    rows: 10,
    cols: 60,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/approval', '\r'],
    frame: 'tail',
    expect: [
      '/approval',
      'Ask',
      'Never',
      'Auto-approve',
      '↑/↓ navigate',
      '1-3/Enter select',
      'Esc cancel',
      '[Esc]cancel',
    ],
    unexpect: [
      'Choose when privileged actions prompt or auto-approve.',
      '1-3 select now',
    ],
    maxLineColumns: 60,
  },
  {
    name: 'compact-tools-form',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/tools', '\r'],
    frame: 'tail',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/tools',
      'Toggle available external integrations',
      '+1 earlier, +5 more',
      '↑/↓ navigate',
      '1-9/a-z/Enter toggle',
      'Esc close',
    ],
    unexpect: ['[TeXRA]', 'toolUtils', 'enabled -', 'TeXRA CLI'],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/tools', max: 2 },
    ],
  },
  {
    name: 'slash-palette-overflow',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/', DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN],
    frame: 'tail',
    expect: [
      '… 5 earlier',
      '/approval',
      'Switch approval policy',
      '/status',
      'Show session details',
      '… 5 more',
      'Esc close',
    ],
  },
  {
    name: 'edit-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
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
    name: 'narrow-edit-approval',
    rows: 12,
    cols: 40,
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    frame: 'tail',
    expect: [
      'Apply edit to draft.tex?',
      'y approve',
      'n reject',
      'Esc cancel',
      'approval',
    ],
    unexpect: [' · …', '╚═y approve'],
  },
  {
    name: 'edit-approval-approve',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    keys: ['y'],
    frame: 'tail',
    expect: ['[/status]details', '[/model]models'],
    unexpect: ['Apply edit to draft.tex?', '1 approval'],
  },
  {
    name: 'bash-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Run bash command?',
      '$ npm run compile:safe',
      'y approve',
      'a approve session',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['[Alt-p]tasks', '[Option-p]tasks', '[/model]models'],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: 'Run bash command?', max: 3 },
    ],
  },
  {
    name: 'narrow-bash-approval',
    rows: 12,
    cols: 40,
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    frame: 'tail',
    expect: [
      'Run bash command?',
      '$ npm run compile:safe',
      'y approve',
      'n reject',
      'Esc cancel',
    ],
    unexpect: [' · …', 'a session'],
  },
  {
    name: 'long-bash-approval',
    rows: 24,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Run bash command?',
      "$ python3 << 'EOF'",
      'more rows',
      'scroll command',
      'y approve',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['╚═    print', '[Option-p]tasks'],
  },
  {
    name: 'compact-long-bash-approval',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '[Ctrl-C]',
    frame: 'tail',
    expect: [
      'Run bash command?',
      "$ python3 << 'EOF'",
      'more rows',
      'scroll command',
      'y approve',
      'Use foreground panel shortcuts',
    ],
    unexpect: ['╚═    print', '[Option-p]tasks'],
  },
  {
    name: 'compact-long-bash-approval-scroll',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '[Ctrl-C]',
    keys: [DOWN, DOWN, DOWN],
    frame: 'tail',
    expect: [
      'Run bash command?',
      'x2 = 1 + 2 * y * y',
      'previous',
      'more rows',
      'scroll command',
      'y approve',
    ],
    unexpect: ["$ python3 << 'EOF'", '[Option-p]tasks'],
  },
  {
    name: 'compact-long-bash-approval-page',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '[Ctrl-C]',
    keys: [PAGE_DOWN],
    frame: 'tail',
    expect: [
      'Run bash command?',
      'for y in range(1, 100):',
      'x2 = 1 + 2 * y * y',
      'previous',
      'more rows',
      'PgUp/PgDn page',
    ],
    unexpect: ["$ python3 << 'EOF'", 'solutions = []', '[Option-p]tasks'],
  },
  {
    name: 'tiny-compact-long-bash-approval',
    rows: 11,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '[Ctrl-C]',
    frame: 'tail',
    expect: ['Run bash command?', 'more rows', 'scroll command', 'y approve'],
    unexpect: ['[Option-p]tasks'],
  },
  {
    name: 'bash-approval-approve-session',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    keys: ['a'],
    frame: 'tail',
    expect: ['AUTO-BASH', '[/status]details', '[/model]models'],
    unexpect: ['AUTO-APPROVE', 'Run bash command?', '1 approval'],
  },
  {
    name: 'bash-approval-session-status',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    keys: ['a', '/status', '\r'],
    frame: 'tail',
    expect: [
      'approval: ask before privileged actions',
      'auto-approvals: bash commands',
      'AUTO-BASH',
    ],
    unexpect: ['Run bash command?', '1 approval'],
  },
  {
    name: 'team-status-empty-subagents-hidden',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_CAN_DELEGATE: '1',
      HARNESS_TEAM_NAME: 'Physicist',
    },
    bootExpect: '[Ctrl-C]',
    keys: ['a', '/status', '\r'],
    frame: 'tail',
    expect: ['team: Physicist', 'auto-approvals: bash commands', 'AUTO-BASH'],
    unexpect: ['Run bash command?', '1 approval', ']subagents'],
  },
  {
    name: 'agent-proposal-long',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Spawn review?',
      'Category: tool-use agent',
      'Review the mathematical proof',
      'more rows',
      'scroll prompt',
      'PgUp/PgDn page',
      'y approve',
      'n reject',
    ],
    unexpect: ['confirmation of correctness', '[Option-p]tasks'],
  },
  {
    name: 'compact-agent-proposal-scroll',
    rows: 17,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: '[Ctrl-C]',
    keys: [PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN],
    frame: 'tail',
    expect: [
      'Spawn review?',
      'Model: deepseekT',
      'Category: tool-use agent',
      'Include a short independent enumeration',
      'previous rows',
      'scroll prompt',
      'y approve',
      'n reject',
    ],
    unexpect: ['prompt rows hidden', '[Option-p]tasks'],
    maxLineColumns: 80,
  },
  {
    name: 'external-inquiry-long',
    rows: 24,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '[Ctrl-C]',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER],
    frame: 'tail',
    expect: [
      'Agent asks:',
      'more rows',
      'PgUp/PgDn scroll',
      'Ctrl-Y copy',
      'Enter submit',
      'Ctrl-R reject',
      'Esc skip',
      '1 question',
    ],
    unexpect: [
      '└─Degenerate triples',
      '[/model]models',
      '[Esc]panel',
      'Esc sk…',
      '1 approval',
    ],
  },
  {
    name: 'external-inquiry-long-80-cols',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '[Ctrl-C]',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER],
    frame: 'tail',
    expect: [
      'Agent asks:',
      'more rows',
      'PgUp/PgDn scroll',
      'Ctrl-Y copy',
      'Enter submit',
      'Ctrl-R reject',
      'Esc skip',
      '1 question',
    ],
    unexpect: [
      '└─Degenerate triples',
      '[/model]models',
      '[Esc]panel',
      'Esc sk…',
      '1 approval',
    ],
  },
  {
    name: 'external-inquiry-copy-question',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '[Ctrl-C]',
    keys: [EM],
    frame: 'tail',
    fakeClipboard: {
      expectIncludes: [
        'Problem: Find all integer triples',
        'whose perimeter is at most 120',
      ],
    },
    expect: ['Agent asks: copied to clipboard', 'Ctrl-Y copy', '1 question'],
    unexpect: ['copy failed', '[/model]models', '1 approval'],
  },
  {
    name: 'external-inquiry-submit-answer',
    rows: 24,
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '[Ctrl-C]',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER, '\r'],
    frame: 'tail',
    expect: [
      '[inquiry] ei_123456abcdef answered.',
      'A: Independent check agrees',
      "Full thread: inquiry { command: 'read'",
      'No other open inquiries on this stream.',
      'Proceed using the new answer.',
      '[/status]details',
      '[/model]models',
    ],
    unexpect: ['Agent asks:', '1 question', '1 approval'],
  },
  {
    name: 'compact-user-question',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_USER_QUESTION: '1' },
    bootExpect: '[Ctrl-C]',
    frame: 'tail',
    expect: [
      'Agent asks:',
      'previous rows',
      'Which proof direction',
      '+2 more',
      '↑/↓ navigate',
      '1-3 select now',
      'Enter select',
      'Esc skip',
      '1 question',
    ],
    unexpect: [
      '[/model]models',
      '[Esc]panel',
      'Context detail: the candidate proof',
      '1 approval',
    ],
    maxLineColumns: 80,
  },
  {
    name: 'plan-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_PLAN_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'y approve',
      'n reject',
    ],
    unexpect: ['r approve & run', '[/model]models'],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: 'Approve plan?', max: 3 },
    ],
  },
  {
    name: 'plan-approval-odyssey',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_ODYSSEY: '1',
    },
    bootExpect: '[Ctrl-C]',
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
    name: 'compact-plan-approval',
    rows: 10,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_PLAN_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'y approve',
      'n reject',
      'e feedback',
      'Esc cancel',
    ],
    unexpect: ['[/model]models'],
  },
  {
    name: 'compact-plan-approval-odyssey',
    rows: 10,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_ODYSSEY: '1',
    },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'Split the finite and symbolic cases',
      'r approve & run',
      'y approve',
      'n reject',
      'e feedback',
      'Esc cancel',
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
    bootExpect: '[Ctrl-C]',
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
    bootExpect: '[Ctrl-C]',
    keys: [DC2],
    frame: 'tail',
    expect: ['Approve plan?', 'r approve & run', '1 approval'],
    unexpect: ['PLAN-ODYSSEY', '[/model]models'],
  },
  {
    name: 'retry-approval',
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_RETRY_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    expect: [
      'Retry the failed call?',
      'HTTP 429 Too Many Requests',
      'Press k to switch to personal API keys before retrying.',
      'retry',
      'give up',
      'use API key and retry',
      '1 approval',
    ],
    unexpect: ['[/model]models'],
  },
  {
    name: 'retry-approval-switch-api',
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_RETRY_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
    keys: ['k'],
    frame: 'tail',
    expect: ['RETRY-API-MODE personal', '[/status]details', '[/model]models'],
    unexpect: ['Retry the failed call?', '1 approval'],
  },
  {
    name: 'edit-approval-reject',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '[Ctrl-C]',
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
      ']tasks',
    ],
    unexpect: ['[Option-p]tasks', '[Option-s]subagents'],
  },
  {
    name: 'failed-subagent-status',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_FAILED_CHILD: 'reviewer',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    expect: [
      'strategy running',
      'leanSolver waiting',
      'reviewer error',
      '2 sub',
      '[Tab]streams',
      ']tasks',
    ],
    unexpect: ['reviewer running', '3 sub'],
  },
  {
    name: 'subagents-with-todos-compact',
    rows: 14,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_TODOS: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    expect: [
      'Waiting for leanSolver',
      '3 sub',
      '1 proc',
      '[Tab]streams',
      ']subagents',
      ']tasks',
      '[Ctrl-C]stop',
    ],
  },
  {
    name: 'subagents-with-todos-narrow-status',
    rows: 14,
    cols: 44,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_TODOS: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: ']tasks',
    expect: ['Waiting for leanSolver', ']tasks', '[Ctrl-C]stop'],
    unexpect: [']subagents', '[Option-p]tasks'],
  },
  {
    name: 'subagent-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's'], // Esc/Alt-s
    expect: [
      'Subagents',
      'Stream: main',
      'strategy',
      'strategy sub-workflow',
      'leanSolver',
      'reviewer',
      'Enter view',
      'f focus',
      'Esc close',
    ],
    unexpect: ['Tasks and sub-workflows', 'latex build'],
    maxBlankLinesBetween: [
      {
        from: 'entry-4 chat history line',
        to: 'Subagents',
        max: 0,
      },
    ],
  },
  {
    name: 'subagent-focused-submit',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', 'f', 'child follow-up on focused stream', '\r'],
    frame: 'tail',
    expect: [
      'Please handle the harness-child-strategy sub-workflow.',
      'strategy is checking the harness-child-strategy details',
      'Harness received: child follow-up on focused stream',
    ],
    unexpect: [
      'entry-1 chat history line',
      'entry-4 chat history line',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-tab-focus-full-frame',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: ['\t'],
    expect: [
      'Please handle the harness-child-strategy sub-workflow.',
      'strategy is checking the harness-child-strategy details',
      '[1:strategy]*',
    ],
    unexpect: [
      'entry-1 chat history line',
      'entry-4 chat history line',
      '[main]*',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-focus-return-root-scrollback-deduped',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', 'f', '\t', '\t', '\t'],
    expect: [
      'entry-1 chat history line',
      'entry-4 chat history line',
      '[main]*',
    ],
    unexpect: [
      'Please handle the harness-child-strategy sub-workflow.',
      'strategy is checking the harness-child-strategy details',
    ],
    maxOccurrences: [
      { text: 'entry-1 chat history line', max: 1 },
      { text: 'entry-4 chat history line', max: 1 },
    ],
  },
  {
    name: 'subagent-picker-enter-views-subagent',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', '\r'],
    frame: 'tail',
    expect: [
      'strategy',
      'Please handle the harness-child-strategy sub-workflow.',
      'strategy is checking the harness-child-strategy details',
      'Esc close',
    ],
    unexpect: ['Harness received:'],
  },
  {
    name: 'nested-subagent-picker',
    cols: 100,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_NESTED_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', 'f', ESC + 's'],
    frame: 'tail',
    expect: [
      'Subagents',
      'Stream: strategy',
      'localChecker',
      'localChecker nested proof check',
      'Enter view',
      'f focus',
      'Esc close',
      '[1:strategy]*',
    ],
    unexpect: ['Stream: main', '│   2. leanSolver', '│   3. reviewer'],
  },
  {
    name: 'nested-task-picker',
    cols: 100,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_NESTED_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', 'f', ESC + 'p'],
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'Stream: strategy',
      'localChecker',
      'proof audit',
      'Enter view',
      'Esc close',
      '[1:strategy]*',
    ],
    unexpect: [
      'Stream: main',
      'latex build',
      '│   2. leanSolver',
      '│   3. reviewer',
    ],
  },
  {
    name: 'task-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p'], // Esc/Alt-p
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
        max: 0,
      },
    ],
  },
  {
    name: 'compact-subagent-picker',
    rows: 10,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's'], // Esc/Alt-s
    frame: 'tail',
    expect: [
      'Subagents',
      'Stream: main',
      'strategy',
      '+2 more',
      'Enter view',
      'f focus',
      'Esc close',
    ],
    unexpect: ['Tasks and sub-workflows'],
    maxBlankLinesBetween: [
      {
        from: 'entry-4 chat history line',
        to: 'Subagents',
        max: 0,
      },
    ],
  },
  {
    name: 'compact-task-picker',
    rows: 10,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p'], // Esc/Alt-p
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'strategy',
      '+3 more',
      'Enter view',
      'k kill',
      'Esc close',
    ],
    unexpect: ['Subagents'],
    maxBlankLinesBetween: [
      {
        from: 'entry-4 chat history line',
        to: 'Tasks and sub-workflows',
        max: 0,
      },
    ],
  },
  {
    name: 'compact-task-picker-process-overflow',
    rows: 10,
    cols: 60,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', DOWN, DOWN, DOWN], // Esc/Alt-p, select process row
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'latex build',
      '+3 earlier',
      'Enter view',
      'Esc close',
    ],
    unexpect: ['Subagents'],
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
    name: 'task-subworkflow-detail-long-output',
    rows: 12,
    cols: 48,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_LONG_CHILD_OUTPUT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 'p', '\r'],
    expect: [
      'stream · strategy',
      'strategy detail line 18 final contradiction',
      'found',
      'f focus',
      'Esc back',
    ],
    unexpect: [
      'Task details',
      'Output:',
      'strategy detail line 01',
      'final contr…',
    ],
  },
  {
    name: 'task-subworkflow-detail-wide-line-scroll',
    rows: 12,
    cols: 48,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_LONG_CHILD_OUTPUT: '1',
      HARNESS_WIDE_FIRST_CHILD_LINE: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 'p', '\r', ...Array.from({ length: 22 }, () => UP)],
    frame: 'tail',
    expect: [
      'stream · strategy',
      'Please handle the harness-child-strategy',
      'sub-workflow.',
      'strategy detail line 01',
      'wide output wraps',
      'f focus',
      'Esc back',
    ],
    unexpect: [
      'Task details',
      'Output:',
      'strategy detail line 18',
      'final contr…',
    ],
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
    keys: [ESC + 's'], // Esc/Alt-s
    frame: 'tail',
    expect: [
      'Subagents',
      'Stream: main',
      'strategy',
      'strategy sub-workflow',
      'Enter view',
      'f focus',
      'Esc close',
    ],
    unexpect: [
      'k kill',
      'strategy sub-wo…',
      'sub-workfl\now',
      '\n────╯',
      'Esc cl…',
    ],
  },
  {
    name: 'narrow-subagent-picker-second',
    cols: 60,
    rows: 18,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 's', DOWN], // Esc/Alt-s, select second subagent
    frame: 'tail',
    expect: [
      'Subagents',
      'Stream: main',
      'leanSolver',
      'leanSolver sub-workflow',
      'Enter view',
      'f focus',
      'Esc close',
    ],
    unexpect: [
      'k kill',
      'leanSolver sub-wor…',
      'sub-workfl\now',
      '\n────╯',
      'Esc cl…',
    ],
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
    keys: [ESC + 'p'], // Esc/Alt-p
    frame: 'tail',
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      'strategy',
      'Enter view',
      'Esc close',
    ],
    unexpect: ['sub-workfl\now', '\n────╯', 'Esc cl…'],
  },
  {
    name: 'tiny-subagent-picker',
    cols: 40,
    rows: 10,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 's'], // Esc/Alt-s
    frame: 'tail',
    expect: [
      'strategy',
      '+2 more',
      'Enter view',
      'Esc close',
      '[main]* 1:strategy*',
    ],
    unexpect: ['*    y*', 'dle)          r*'],
  },
  {
    name: 'tiny-status-separators',
    cols: 30,
    rows: 10,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 's'], // Esc/Alt-s
    frame: 'tail',
    expect: ['◆ running 75s keys 3 sub'],
    unexpect: ['◆running', 'keys3', '3 sub 1 proc'],
  },
  {
    name: 'tiny-task-subworkflow-detail',
    cols: 40,
    rows: 10,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 'p', '\r'],
    frame: 'tail',
    expect: [
      'stream · strategy',
      'harness-child-strategy details and',
      'preparing a concise result.',
      'f focus',
      'Esc back',
      '[main]* 1:strategy*',
      '[Esc]panel',
      '[Ctrl-C]stop',
    ],
    unexpect: ['│ ›', 'Task details', 'Output:', '*    y*', '[Ctrl…'],
  },
  {
    name: 'tiny-task-subworkflow-detail-wrapped-scroll',
    cols: 40,
    rows: 10,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 'p', '\r', DOWN],
    frame: 'tail',
    expect: [
      'stream · strategy',
      'harness-child-strategy',
      'preparing a concise result.',
      'f focus',
      'Esc back',
      '[main]* 1:strategy*',
      '[Esc]panel',
    ],
    unexpect: ['│ ›', 'Task details', 'Output:', '*    y*'],
  },
  {
    name: 'tiny-task-process-detail',
    cols: 40,
    rows: 10,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'TeXRA',
    keys: [ESC + 'p', DOWN, DOWN, DOWN, '\r'],
    frame: 'tail',
    expect: [
      'shell · latex build',
      'main.tex: Proof sketch needs one',
      'missing reference',
      'Esc back',
      '[Esc]panel',
    ],
    unexpect: ['│ ›', 'Task details', 'Output:', '*    y*'],
  },
  {
    name: 'tiny-task-subworkflow-detail-controls',
    cols: 50,
    rows: 8,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    keys: [ESC + 'p', '\r'],
    frame: 'tail',
    expect: [
      'stream · strategy',
      'concise result.',
      'f focus',
      'k kill',
      'Esc back',
      '[Esc]panel',
    ],
    unexpect: ['Esc ba…'],
  },
  {
    name: 'tiny-task-process-detail-controls',
    cols: 50,
    rows: 8,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    keys: [ESC + 'p', DOWN, DOWN, DOWN, '\r'],
    frame: 'tail',
    expect: [
      'shell · latex build',
      'reference',
      'k kill',
      'Esc back',
      '[Esc]panel',
    ],
    unexpect: ['Esc ba…'],
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
      'Enter view',
      'f focus',
      'Esc close',
    ],
    unexpect: [
      'k kill',
      'Harness kill requested for harness-child-strategy.\n\nHarness kill requested for harness-child-strategy.',
    ],
  },
  {
    name: 'stopped-task-picker',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', 'k', ESC + 'p', DOWN, DOWN],
    expect: [
      'Tasks and sub-workflows',
      'Stream: main',
      '› 3. strategy — stopped',
      'Enter view',
      'Esc close',
    ],
    unexpect: ['k kill'],
  },
  {
    name: 'stopped-task-subworkflow-detail',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', 'k', ESC + 'p', DOWN, DOWN, '\r'],
    expect: [
      'Task details',
      'stream · strategy · stopped',
      'Please handle the harness-child-strategy sub-workflow.',
      'f focus stream',
      'Esc back',
    ],
    unexpect: ['k kill'],
  },
  {
    name: 'focused-stopped-subagent',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [ESC + 'p', 'k', ESC + 's', DOWN, DOWN, 'f'],
    frame: 'tail',
    expect: [
      '[3:strategy](stopped)',
      '◆ stopped',
      'root active',
      '[Ctrl-C]stop root',
    ],
    unexpect: ['◆ running', '2 sub 1 proc'],
  },
  {
    name: 'focused-stopped-subagent-submit',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: '[Tab]streams',
    keys: [
      ESC + 'p',
      'k',
      ESC + 's',
      DOWN,
      DOWN,
      'f',
      'can you still receive this?',
      '\r',
    ],
    frame: 'tail',
    expect: [
      '[3:strategy](stopped)',
      '◆ stopped',
      'root active',
      'The selected subagent is no longer accepting follow-ups.',
    ],
    unexpect: [
      'Harness received: can you still receive this?',
      '◆ running',
      '2 sub 1 proc',
    ],
  },
  {
    name: 'empty-task-shortcut-hidden',
    env: {
      HARNESS_ENTRIES: '4',
    },
    keys: [ESC + 'p'],
    frame: 'tail',
    expect: ['entry-4 chat history line', '[/status]details', '[Ctrl-C]exit'],
    unexpect: [
      '[Option-p]tasks',
      '[Alt-p]tasks',
      '[Esc p]tasks',
      'Tasks and sub-workflows',
      'No active tasks or sub-workflows.',
      'Enter view',
      'k kill',
      'navigate',
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
    keys: [ESC + 's', 'f', ESC + 'p'],
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
    name: 'idle-todos-hidden',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_TODOS: '1',
      HARNESS_TODOS_IDLE: '1',
    },
    frame: 'tail',
    expect: ['idle', '[Ctrl-C]exit'],
    unexpect: [
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
      '◆ stopped keys',
    ],
  },
];

function formatUsage() {
  return [
    '[validate-tui] usage: node scripts/validate-tui.mjs [--snapshot-dir DIR] [--no-build] [--skip-if-missing-deps] [scenario ...]',
    '',
    'Options:',
    '  --snapshot-dir DIR  Write per-scenario .txt/.svg frames and an index.html report',
    `  --no-build          Use the existing ${DEFAULT_HARNESS_RELATIVE_PATH} instead of rebuilding it`,
    '  --skip-if-missing-deps  Exit 0 instead of failing when PTY screenshot deps are unavailable',
    '  --list, --list-scenarios',
    '                      Print available scenario names and exit',
    '  --list-selected     Print selected scenario names in run order and exit',
    '  -h, --help          Show this help',
    '',
    'Available scenarios:',
    `  ${SCENARIOS.map((s) => s.name).join('\n  ')}`,
  ].join('\n');
}

function printUsage(stream = console.log) {
  stream(formatUsage());
}

function printScenarioList() {
  console.log(SCENARIOS.map((scenario) => scenario.name).join('\n'));
}

function parseArgs(argv) {
  const scenarios = [];
  let snapshotDir;
  let listSelected = false;
  let noBuild = false;
  let skipIfMissingDeps = false;
  let endOfOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!endOfOptions && arg === '--') {
      // pnpm forwards a leading separator to scripts (`pnpm run x -- --flag`).
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
    if (!endOfOptions && (arg === '--list' || arg === '--list-scenarios')) {
      printScenarioList();
      process.exit(0);
    }
    if (!endOfOptions && arg === '--list-selected') {
      listSelected = true;
      continue;
    }
    if (!endOfOptions && arg === '--no-build') {
      noBuild = true;
      continue;
    }
    if (!endOfOptions && arg === '--skip-if-missing-deps') {
      skipIfMissingDeps = true;
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
      printUsage(console.error);
      process.exit(1);
    }
    scenarios.push(arg);
  }
  return { scenarios, snapshotDir, listSelected, noBuild, skipIfMissingDeps };
}

const args = parseArgs(process.argv.slice(2));
const only = args.scenarios;
const scenarioByName = new Map(
  SCENARIOS.map((scenario) => [scenario.name, scenario]),
);
const unknownScenarios = [
  ...new Set(only.filter((name) => !scenarioByName.has(name))),
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
  ? only.map((name) => scenarioByName.get(name))
  : SCENARIOS;
if (args.listSelected) {
  console.log(scenarios.map((scenario) => scenario.name).join('\n'));
  process.exit(0);
}
const snapshotDir = args.snapshotDir;
const useExistingHarness =
  Boolean(process.env.TEXRA_TUI_HARNESS) || args.noBuild;

if (useExistingHarness) {
  if (!existsSync(HARNESS)) {
    if (process.env.TEXRA_TUI_HARNESS) {
      console.error('[validate-tui] custom harness does not exist:', HARNESS);
    } else {
      console.error(
        '[validate-tui] --no-build requires an existing harness:',
        HARNESS,
      );
      console.error(
        `[validate-tui] run without --no-build once to build ${DEFAULT_HARNESS_RELATIVE_PATH}`,
      );
    }
    process.exit(1);
  }
}

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
    `[validate-tui] ${args.skipIfMissingDeps ? 'skipped' : 'failed'} — install the TUI dev deps to run this validator:\n` +
      '  pnpm --filter @texra-ai/cli add -D node-pty @xterm/headless\n' +
      `  (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(args.skipIfMissingDeps ? 0 : 1);
}

// --- harness bundle ------------------------------------------------------
if (!useExistingHarness) {
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

function scenarioFrame(scenario, fullFrame, rows) {
  return scenario.frame === 'tail' ? frameTail(fullFrame, rows) : fullFrame;
}

function expectedFrameTextVisible(scenario, frame) {
  return (scenario.expect ?? []).every((text) => frame.includes(text));
}

const FAKE_CLIPBOARD_COMMANDS_BY_PLATFORM = {
  darwin: ['pbcopy'],
  linux: ['wl-copy', 'xclip', 'xsel'],
};

function fakeClipboardCommandsForPlatform(platform = process.platform) {
  return FAKE_CLIPBOARD_COMMANDS_BY_PLATFORM[platform] ?? [];
}

function makeFakeClipboard(platform = process.platform) {
  const commands = fakeClipboardCommandsForPlatform(platform);
  if (commands.length === 0) return null;

  const dir = mkdtempSync(path.join(tmpdir(), 'texra-tui-clipboard-'));
  const binDir = path.join(dir, 'bin');
  const textFile = path.join(dir, 'clipboard.txt');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(textFile, '');

  const script = [
    '#!/usr/bin/env sh',
    'set -eu',
    'cat > "$TEXRA_FAKE_CLIPBOARD_FILE"',
    '',
  ].join('\n');
  for (const command of commands) {
    const commandPath = path.join(binDir, command);
    writeFileSync(commandPath, script);
    chmodSync(commandPath, 0o755);
  }

  return { binDir, dir, textFile };
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

function lineColumns(line) {
  return [...line].length;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = text.indexOf(needle, index);
    if (next < 0) return count;
    count += 1;
    index = next + needle.length;
  }
}

function snapshotFileName(index, name, extension = 'txt') {
  const prefix = String(index + 1).padStart(2, '0');
  return `${prefix}-${name.replace(/[^a-z0-9._-]+/gi, '-')}.${extension}`;
}

function resetSnapshotDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const generatedFrame = /^\d+-[a-z0-9._-]+\.(?:html|svg|txt)$/i.test(
      entry.name,
    );
    if (!generatedFrame && entry.name !== 'index.html') continue;
    unlinkSync(path.join(dir, entry.name));
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const SNAPSHOT_THEME = {
  colorScheme: 'light',
  pageBackground: '#f6f4ee',
  text: '#24211c',
  muted: '#6e675c',
  cardBackground: '#fffdf8',
  border: '#d8d0c3',
  headerBorder: '#e4ddd2',
  failedBorder: '#b55d54',
  link: '#1b5e8f',
  failureText: '#9b3d35',
};

function snapshotSvgDocument(name, frame) {
  const lines = frame.split('\n');
  const charWidth = 8.4;
  const fontSize = 14;
  const lineHeight = 18;
  const paddingX = 16;
  const paddingY = 16;
  const maxColumns = Math.max(1, ...lines.map(lineColumns));
  const width = Math.ceil(maxColumns * charWidth + paddingX * 2);
  const height = Math.ceil(lines.length * lineHeight + paddingY * 2);
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${paddingX}" y="${paddingY + fontSize + index * lineHeight}">${escapeHtml(line || ' ')}</tspan>`,
    )
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
  <title id="title">${escapeHtml(name)} TUI snapshot</title>
  <rect width="100%" height="100%" fill="${SNAPSHOT_THEME.cardBackground}"/>
  <text fill="${SNAPSHOT_THEME.text}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${fontSize}" xml:space="preserve">
    ${tspans}
  </text>
</svg>
`;
}

function writeSnapshot(index, name, frame, rows) {
  if (!snapshotDir) return;
  const content = frameTail(frame, rows);
  const textFile = path.join(snapshotDir, snapshotFileName(index, name));
  const svgFile = path.join(snapshotDir, snapshotFileName(index, name, 'svg'));
  writeFileSync(textFile, `${content}${content.endsWith('\n') ? '' : '\n'}`);
  writeFileSync(svgFile, snapshotSvgDocument(name, content));
}

function snapshotHtmlDocument(results) {
  const generatedAt = new Date().toISOString();
  const entries = results
    .map((result, index) => {
      const textFile = snapshotFileName(index, result.name);
      const svgFile = snapshotFileName(index, result.name, 'svg');
      const frame = frameTail(result.fullFrame, result.rows);
      const statusClass = result.ok ? 'ok' : 'failed';
      const failures = result.failures.length
        ? `<ul>${result.failures
            .map((failure) => `<li>${escapeHtml(failure)}</li>`)
            .join('')}</ul>`
        : '';
      return `<section class="scenario ${statusClass}">
  <header>
    <h2>${escapeHtml(result.name)}</h2>
    <nav>
      <a href="${escapeHtml(textFile)}">text frame</a>
      <a href="${escapeHtml(svgFile)}">svg frame</a>
    </nav>
  </header>
  ${failures}
  <pre>${escapeHtml(frame)}</pre>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TeXRA TUI snapshots</title>
  <style>
    :root { color-scheme: ${SNAPSHOT_THEME.colorScheme}; }
    body {
      margin: 0;
      background: ${SNAPSHOT_THEME.pageBackground};
      color: ${SNAPSHOT_THEME.text};
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    .meta { color: ${SNAPSHOT_THEME.muted}; margin: 0 0 24px; }
    .scenario {
      border: 1px solid ${SNAPSHOT_THEME.border};
      border-radius: 8px;
      margin: 0 0 24px;
      overflow: hidden;
      background: ${SNAPSHOT_THEME.cardBackground};
    }
    .scenario.failed { border-color: ${SNAPSHOT_THEME.failedBorder}; }
    header {
      align-items: center;
      border-bottom: 1px solid ${SNAPSHOT_THEME.headerBorder};
      display: flex;
      justify-content: space-between;
      padding: 10px 14px;
    }
    h2 { font-size: 14px; margin: 0; }
    nav { display: flex; gap: 14px; }
    a { color: ${SNAPSHOT_THEME.link}; text-decoration: none; }
    ul { color: ${SNAPSHOT_THEME.failureText}; margin: 12px 14px 0; }
    pre {
      line-height: 1.22;
      margin: 0;
      overflow: auto;
      padding: 14px;
      tab-size: 2;
      white-space: pre;
    }
  </style>
</head>
<body>
  <main>
    <h1>TeXRA TUI snapshots</h1>
    <p class="meta">Generated ${escapeHtml(generatedAt)} from ${results.length} scenario${results.length === 1 ? '' : 's'}.</p>
    ${entries}
  </main>
</body>
</html>
`;
}

function writeSnapshotReport(results) {
  if (!snapshotDir) return;
  writeFileSync(
    path.join(snapshotDir, 'index.html'),
    snapshotHtmlDocument(results),
  );
}

async function runScenario(scenario) {
  const fakeClipboard = scenario.fakeClipboard ? makeFakeClipboard() : null;
  if (scenario.fakeClipboard && !fakeClipboard) {
    const skipReason = `fake clipboard is not supported on ${process.platform}`;
    return {
      name: scenario.name,
      ok: true,
      skipped: true,
      skipReason,
      failures: [],
      frame: skipReason,
      fullFrame: skipReason,
      rows: scenarioRows(scenario),
    };
  }
  try {
    return await runScenarioWithResources(scenario, fakeClipboard);
  } finally {
    cleanupFakeClipboard(fakeClipboard);
  }
}

function cleanupFakeClipboard(fakeClipboard) {
  if (!fakeClipboard) return;
  rmSync(fakeClipboard.dir, { recursive: true, force: true });
}

async function runScenarioWithResources(scenario, fakeClipboard) {
  const term = makeTerm(scenario);
  const cols = scenarioCols(scenario);
  const rows = scenarioRows(scenario);
  let lastData = Date.now();
  let exited = null;
  let rawOutput = '';
  let writeQueue = Promise.resolve();
  const frameSnapshot = async () => {
    await writeQueue;
    return renderFrame(term);
  };
  const childEnv = {
    ...process.env,
    ...scenario.env,
    TERM: 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  if (scenario.colorEnabled === false) {
    delete childEnv.FORCE_COLOR;
    childEnv.NO_COLOR = '1';
    childEnv.HARNESS_COLOR_ENABLED = '0';
  } else {
    childEnv.FORCE_COLOR = '3';
    delete childEnv.NO_COLOR;
    childEnv.HARNESS_COLOR_ENABLED ??= '1';
  }
  if (fakeClipboard) {
    childEnv.PATH = `${fakeClipboard.binDir}${path.delimiter}${childEnv.PATH ?? ''}`;
    childEnv.TEXRA_FAKE_CLIPBOARD_FILE = fakeClipboard.textFile;
  }
  // The validator intentionally exercises an interactive TTY. Inherited CI
  // markers make Ink choose a non-interactive render mode and hide the live
  // input/status surface this script is meant to inspect.
  delete childEnv.CI;
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
    rawOutput += d;
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

  // Settle after keystrokes. A quiet PTY is not quite enough: under a full
  // suite, Ink/xterm can occasionally pause between chunks of the final frame,
  // which used to snapshot partial lines such as a task detail output row
  // ending at `Ple`. Prefer a frame where the scenario's expected visible text
  // is present, but still time out with the best frame if the UI regresses.
  const settleDeadline = Date.now() + Number(scenario.settleMs ?? 4000);
  let fullFrame = await frameSnapshot();
  let frame = scenarioFrame(scenario, fullFrame, rows);
  while (Date.now() < settleDeadline) {
    const quiet = Date.now() - lastData >= 500;
    fullFrame = await frameSnapshot();
    frame = scenarioFrame(scenario, fullFrame, rows);
    if (quiet && expectedFrameTextVisible(scenario, frame)) break;
    await sleep(120);
  }
  fullFrame = await frameSnapshot();
  frame = scenarioFrame(scenario, fullFrame, rows);

  // exit cleanly: Ctrl-C by default (a second one if the first only
  // interrupts a run). Some surfaces, such as the orchestration launcher,
  // specifically own Esc as their exit affordance.
  const exitKeys = scenario.exitKeys ?? [ETX, ETX];
  for (const exitKey of exitKeys) {
    if (exited) break;
    child.write(exitKey);
    const exitDeadline = Date.now() + 2500;
    while (!exited && Date.now() < exitDeadline) await sleep(100);
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
  for (const check of scenario.maxOccurrences ?? []) {
    const actual = countOccurrences(frame, check.text);
    if (actual > check.max) {
      failures.push(
        `text appears too many times: ${JSON.stringify(check.text)} (${actual} > ${check.max})`,
      );
    }
  }
  const slashPaletteVisible =
    frame.includes('Tab complete') && frame.includes('↑/↓ navigate');
  if (
    !slashPaletteVisible &&
    frame.includes('Use foreground panel shortcuts') &&
    frame.includes('Tip:')
  ) {
    failures.push('foreground panel rendered the normal chat tip row');
  }
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
  if (scenario.maxLineColumns != null) {
    const maxColumns = Number(scenario.maxLineColumns);
    const tooWide = frame
      .split('\n')
      .map((line, index) => ({
        index: index + 1,
        columns: lineColumns(line),
        line,
      }))
      .filter((line) => line.columns > maxColumns);
    if (tooWide.length > 0) {
      const first = tooWide[0];
      failures.push(
        `line ${first.index} exceeds ${maxColumns} columns: ${first.columns} (${JSON.stringify(first.line)})`,
      );
    }
  }
  if (scenario.expectExit && !exitedCleanly) {
    const exitDetails = exited
      ? ` (exitCode ${exited.exitCode}, signal ${exited.signal || 'none'})`
      : '';
    failures.push(`exit keys did not close the TUI cleanly${exitDetails}`);
  }
  if (scenario.rawUnexpectSgr) {
    const sgrSequences = [...new Set(rawOutput.match(ANSI_SGR_PATTERN) ?? [])];
    if (sgrSequences.length > 0) {
      failures.push(
        `raw output contains SGR escapes: ${sgrSequences
          .slice(0, 5)
          .map((sequence) => JSON.stringify(sequence))
          .join(', ')}`,
      );
    }
  }
  if (fakeClipboard) {
    const copiedText = readFileSync(fakeClipboard.textFile, 'utf8');
    for (const text of scenario.fakeClipboard.expectIncludes ?? []) {
      if (!copiedText.includes(text)) {
        failures.push(
          `fake clipboard missing expected text: ${JSON.stringify(text)}`,
        );
      }
    }
  }

  return {
    name: scenario.name,
    ok: failures.length === 0,
    skipped: false,
    failures,
    frame,
    fullFrame,
    rows,
  };
}

if (snapshotDir) resetSnapshotDir(snapshotDir);

let failed = 0;
let skipped = 0;
const results = [];
for (const [index, scenario] of scenarios.entries()) {
  // eslint-disable-next-line no-await-in-loop
  const result = await runScenario(scenario);
  results.push(result);
  writeSnapshot(index, result.name, result.fullFrame, result.rows);
  if (result.skipped) {
    skipped += 1;
    console.log(`- ${result.name} (skipped: ${result.skipReason})`);
  } else if (result.ok) {
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
writeSnapshotReport(results);

console.log('');
console.log(
  failed === 0
    ? `validate-tui: all ${scenarios.length - skipped} scenario(s) passed${skipped ? `, ${skipped} skipped` : ''}`
    : `validate-tui: ${failed}/${scenarios.length} scenario(s) FAILED`,
);
if (snapshotDir) {
  console.log(`validate-tui: wrote snapshots to ${snapshotDir}`);
  console.log(
    `validate-tui: wrote snapshot report to ${path.join(snapshotDir, 'index.html')}`,
  );
}
process.exit(failed === 0 ? 0 : 1);
