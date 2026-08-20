#!/usr/bin/env node
// Deterministic PTY frame-capture validator for the CLI TUI (issue #4709).
//
// Launches the bundled `dist/bin/tui-harness.js` under a pseudo-terminal,
// renders the byte stream through a headless terminal emulator, drives a few
// product-focused scenarios with raw keystrokes, and asserts against each
// scenario's declared viewport or scrollback frame. It fails with a readable
// frame snippet when expected UI text disappears — the regression we keep
// hitting as the live-region / scrollback layout evolves.
//
// This is intentionally small: a handful of scenarios that exercise the
// transcript, queued follow-ups, a slash command, an approval modal, the
// child list, and the Ctrl-C exit path. It is NOT a general
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
import { parseArgs as parseCittyArgs } from 'citty';
import PQueue from 'p-queue';

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
const RUNNING_STATUS_PATTERN = /◆ [-|\/\\] running/;
const STOPPED_SUBAGENT_INPUT_MESSAGE_START =
  // Keep in sync with FOCUSED_BACKGROUND_TASK in src/shared/copy/nestedRuns.ts.
  'This background task is no longer accepting follow-ups; press Tab to select a session';
const STOPPED_SELECTED_BACKGROUND_TASK_MESSAGE =
  // Keep in sync with FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting.
  'The selected background task is no longer accepting follow-ups.';
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
const LONG_EXTERNAL_INQUIRY_ANSWER_FOR_TRUNCATION = Array.from(
  { length: 24 },
  (_, index) =>
    `Long verification note ${String(index + 1).padStart(2, '0')}: independent enumeration confirms the count and keeps the full answer recoverable by thread id.`,
).join(' ');
const FULL_WIDTH_AGENT_PROPOSAL_BORDER_80 = `╔${'═'.repeat(78)}╗`;
const ASYNC_FORM_SETTLE_MS = 12000;
const WRAPPED_EDIT_APPROVAL_ENV = Object.freeze({
  HARNESS_ENTRIES: '4',
  HARNESS_EDIT_APPROVAL: '1',
  HARNESS_EDIT_APPROVAL_WRAPPED_CONTEXT: '1',
});
const PHYSICIST_LOCAL_TOOL_USE_AGENTS = [
  'research',
  'review',
  'latexFixer',
  'numerics',
  'presenter',
].join('||');
const PHYSICIST_WORKFLOW_AGENTS = ['correct', 'polish'].join('||');
const TWO_OPENAI_MODELS = ['gpt55', 'gpt55pro'].join('||');

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
// The `child-event-order-*` scenarios (issue #7972) must render
// byte-identical frames across separate process launches, so they share one
// fixed working directory instead of each getting its own random
// `mkdtempSync` cwd (tui-harness.tsx's default) — the harness reflects `cwd`
// in rendered session chrome, and a different path per scenario would fail
// the comparison for a reason unrelated to child-stream event ordering.
// Removed on every exit path (including `--help`/`--list`, which never touch
// it) rather than only after a run that selects these scenarios, so it never
// leaks a temp dir the way an un-cleaned-up `mkdtempSync` normally would.
const CHILD_EVENT_ORDER_CWD = mkdtempSync(
  path.join(tmpdir(), 'texra-tui-child-event-order-'),
);
process.on('exit', () => {
  rmSync(CHILD_EVENT_ORDER_CWD, { recursive: true, force: true });
});
// The static-transcript repaint scenarios compare a resize/resume repaint
// against a from-scratch render of the same retained tail, so they too need a
// byte-stable cwd across the canonical/reflow pair.
const STATIC_TRANSCRIPT_CWD = mkdtempSync(
  path.join(tmpdir(), 'texra-tui-static-transcript-'),
);
process.on('exit', () => {
  rmSync(STATIC_TRANSCRIPT_CWD, { recursive: true, force: true });
});
const CHILD_EVENT_ORDER_MARKER_OSC = 777;
const CHILD_EVENT_ORDER_MARKER_PREFIX = 'texra-harness-child-event-order:';

// --- scenarios (verified against the committed harness) ------------------
const SCENARIOS = [
  {
    name: 'transcript',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '8' },
    expect: [
      'TeXRA',
      'agent: chat · model: harness-model',
      'chat history line to grow the transcript pane',
      '◆',
      'Ctrl-C exit',
    ],
  },

  {
    name: 'static-transcript-repaint-canonical',
    frame: 'scrollback',
    rows: 24,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '12',
      HARNESS_CWD: STATIC_TRANSCRIPT_CWD,
    },
    expect: ['TeXRA', 'chat history line to grow the transcript pane'],
  },
  {
    name: 'static-transcript-repaint-reflow',
    equivalentFrameTo: 'static-transcript-repaint-canonical',
    frame: 'scrollback',
    rows: 24,
    cols: 40,
    env: {
      HARNESS_ENTRIES: '12',
      HARNESS_CWD: STATIC_TRANSCRIPT_CWD,
    },
    resizes: [{ cols: 80, rows: 24 }],
    expect: ['TeXRA', 'chat history line to grow the transcript pane'],
  },
  {
    name: 'static-transcript-terminal-resume',
    equivalentFrameTo: 'static-transcript-repaint-canonical',
    frame: 'scrollback',
    rows: 24,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '12',
      HARNESS_CWD: STATIC_TRANSCRIPT_CWD,
      HARNESS_TERMINAL_RESUME_REPAINT: '1',
    },
    expect: ['TeXRA', 'chat history line to grow the transcript pane'],
  },
  {
    name: 'workflow-timeline',
    frame: 'scrollback',
    rows: 24,
    cols: 100,
    env: {
      HARNESS_ENTRIES: '0',
      HARNESS_WORKFLOW_TIMELINE: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, '\r'],
    expect: [
      'Repository audit Completed',
      'Generated files',
      'paper.tex',
      'Compile check failed',
      'paper.log',
    ],
    expectPatterns: [/r1\/2.*Completed/, /r2\/2.*Completed/],
    ordered: [
      { before: 'r1/2 Completed', after: 'Generated files' },
      { before: 'Generated files', after: 'Compile check failed' },
      { before: 'Compile check failed', after: 'r2/2 Completed' },
    ],
  },
  {
    name: 'workflow-running',
    frame: 'viewport',
    rows: 30,
    cols: 100,
    env: {
      HARNESS_ENTRIES: '0',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_WORKFLOW_RUNNING: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: [
      "Workflow script 'live-workflow-validation'",
      'Proofread (1/1) · 0/2 done',
      'Running: Proofread paper A',
      'Running: Proofread paper B',
      'Proofread paper A · Running · bash',
      'Proofread paper B · Running',
      '1 approval',
      'Proofread (1/1)',
      '2 agents',
    ],
    unexpect: ['Proofread paper B · Running · bash'],
  },
  {
    name: 'workflow-running-composer-hidden',
    frame: 'viewport',
    rows: 30,
    cols: 100,
    env: {
      HARNESS_ENTRIES: '0',
      HARNESS_WORKFLOW_RUNNING: '1',
    },
    bootExpect: "Workflow script 'live-workflow-validation'",
    keys: ['must not reach workflow', '\r'],
    expect: [
      "Workflow script 'live-workflow-validation'",
      'Proofread (1/1) · 0/2 done',
      'Esc back',
    ],
    unexpect: [
      'must not reach workflow',
      'Harness received: must not reach workflow',
      STOPPED_SUBAGENT_INPUT_MESSAGE_START,
      '/status details',
      '/model models',
      '/api api',
      'Ctrl-J newline',
    ],
  },
  {
    name: 'process-child-composer-hidden',
    frame: 'viewport',
    rows: 24,
    cols: 100,
    env: {
      HARNESS_ENTRIES: '0',
      HARNESS_PROCESS_CHILD: '1',
    },
    bootExpect: 'Esc back',
    keys: ['must not reach bash', '\r'],
    expect: ['1 active', 'Esc back'],
    unexpect: [
      'must not reach bash',
      'Harness received: must not reach bash',
      STOPPED_SUBAGENT_INPUT_MESSAGE_START,
      '/status details',
      '/model models',
      '/api api',
      'Ctrl-J newline',
    ],
  },
  {
    name: 'live-tool-only-spacing',
    frame: 'scrollback',
    env: {
      HARNESS_LIVE_INVISIBLE_ASSISTANT: '1',
      HARNESS_LIVE_TOOL_ONLY: '1',
    },
    expect: [
      'what is this repo about',
      '● grep (Found 12 matches for "theorem" in .)',
    ],
    maxBlankLinesBetween: [
      // The user band always keeps one breathing row below the prompt.
      { from: 'what is this repo about', to: '● grep', max: 1 },
    ],
  },
  {
    name: 'live-tool-stack-spacing',
    frame: 'scrollback',
    rows: 34,
    env: {
      HARNESS_LIVE_INVISIBLE_ASSISTANT: '1',
      HARNESS_LIVE_TOOL_COUNT: '3',
      HARNESS_LIVE_TOOL_ONLY: '1',
    },
    expect: [
      'what is this repo about',
      '● grep (Found 12 matches for "theorem" in .)',
      '● glob (Found 7 files for "*.md" in .)',
      '● glob (Found 6 files for "**/*.tex" in .)',
    ],
    maxBlankLinesBetween: [
      {
        from: 'what is this repo about',
        to: '● grep (Found 12 matches for "theorem" in .)',
        // The user band always keeps one breathing row below the prompt.
        max: 1,
      },
      {
        from: '● grep (Found 12 matches for "theorem" in .)',
        to: '● glob (Found 7 files for "*.md" in .)',
        max: 0,
      },
      {
        from: '● glob (Found 7 files for "*.md" in .)',
        to: '● glob (Found 6 files for "**/*.tex" in .)',
        max: 0,
      },
    ],
  },
  {
    name: 'assistant-tool-preamble-spacing',
    frame: 'scrollback',
    env: {
      HARNESS_ASSISTANT_TOOL_PREAMBLE: '1',
    },
    expect: [
      '› what is this repo about',
      'I will read the README first.',
      '● read_file (Read README.md)',
    ],
    maxBlankLinesBetween: [
      {
        from: 'I will read the README first.',
        to: '● read_file (Read README.md)',
        max: 0,
      },
    ],
  },
  {
    name: 'queued-followups',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_QUEUED_FOLLOWUPS:
        'First queued follow-up||Second queued follow-up',
    },
    bootExpect: 'queued 2',
    frame: 'viewport',
    expect: [
      'Queued follow-ups (2)',
      '1. First queued follow-up',
      '2. Second queued follow-up',
      'queued 2',
      'Ctrl-C stop',
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
    frame: 'viewport',
    expect: [
      'queued follow-ups: 1',
      '1. ✓ reviewer completed All good <ok>',
      'Queued follow-ups (1)',
    ],
    unexpect: [
      '(empty follow-up)',
      '<orchestrator-followup>',
      '<subagent-result',
    ],
  },
  {
    name: 'queued-subagent-followup-status-preview',
    cols: 140,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_QUEUED_FOLLOWUPS:
        '<orchestrator-followup><subagent-progress id="child-q" agent="review" category="toolUse" type="todos" completed="6" active="0" pending="0"/></orchestrator-followup>',
    },
    bootExpect: 'queued 1',
    frame: 'viewport',
    expect: [
      'Queued follow-ups (1)',
      '1. ⟳ review · todos · 6 done, 0 active, 0 pending',
      'queued 1',
      '⟳ review · todos · 6 done, 0 active, 0 pending',
    ],
    unexpect: ['<orchestrator-followup>', '<subagent-progress'],
  },
  {
    name: 'compact-queued-followups',
    rows: 8,
    cols: 60,
    env: {
      HARNESS_ENTRIES: '2',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_QUEUED_FOLLOWUPS:
        'First queued follow-up||Second queued follow-up',
    },
    bootExpect: 'queued 2',
    frame: 'viewport',
    expect: [
      'Queued follow-ups (2)',
      '1. First queued follow-up',
      '2. Second queued follow-up',
      '│ ›',
      'queued 2',
      'Ctrl-C stop',
    ],
    unexpect: ['Tip: Ctrl-C exits idle chats', 'agent: chat · model'],
  },
  {
    name: 'subagent-followup-summary',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '0', HARNESS_SUBAGENT_FOLLOWUPS: '1' },
    expect: [
      '⟳ strategy · 3 tool calls',
      '✓ leanSolver completed · 2min, 3sec',
      'Proved </response> is escaped & visible.',
      '✗ reviewer failed (retryable)',
      'rate limit: <tokens> & retries exhausted',
    ],
    unexpect: ['<subagent-progress', '<subagent-result', '<subagent-error'],
  },
  {
    name: 'long-tool-output-elided',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '0', HARNESS_LONG_TOOL_OUTPUT: '1' },
    expect: [
      '● bash (python3 enumerate_triples.py)',
      'tool-output-line-01',
      '… +9 lines (Ctrl-T to view full output)',
      'tool-output-line-18',
    ],
    unexpect: ['tool-output-line-10 hidden-middle'],
  },
  {
    name: 'bash-rejection-deduped',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '0', HARNESS_REJECTED_BASH_TOOL: '1' },
    expect: [
      "● bash (printf 'approval-reject-live\\n')",
      "⎿ User rejected command: printf 'approval-reject-live\\n'",
    ],
    maxOccurrences: [
      {
        text: "User rejected command: printf 'approval-reject-live\\n'",
        max: 1,
      },
    ],
  },
  {
    name: 'root-transcript-reader-full-tool-output',
    cols: 80,
    env: { HARNESS_ENTRIES: '0', HARNESS_LONG_TOOL_OUTPUT: '1' },
    keys: [DC4],
    frame: 'scrollback',
    expect: [
      'Transcript: main',
      'tool-output-line-10 hidden-middle',
      'wide-column-F',
      'tool-output-line-18',
    ],
    expectPatterns: [/PgUp\/PgDn page.*Esc close/],
  },
  {
    name: 'orchestrate-launcher',
    frame: 'scrollback',
    env: { HARNESS_ORCHESTRATION: '1' },
    bootExpect: 'Team — Choose a team',
    keys: ['2'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Team',
      'Choose a team for this session.',
      'Team lean-project',
      'Team physicist',
      'Team mathematician',
      'Team cs-ml',
      'Team software-engineer',
      'unavailable; no team root',
      'unavailable',
      'no team root',
      '2/6 workflows',
      '5/9 tools',
      'ready; 5 tools',
      'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.',
      'Researcher Access sign-in may unlock more remote team agents.',
      '1-9/a-z/Enter select',
      'Esc back',
    ],
    unexpect: [
      'Resume aaaaaaaaaaaa',
      '/model models',
      'Tip:',
      'tool-use:',
      'workflow:',
    ],
  },
  {
    name: 'orchestrate-agent-submenu',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: 'assistant||review',
    },
    bootExpect: 'Agent — Choose one agent',
    keys: ['3'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Agent',
      'Choose one agent for this session.',
      'assistant',
      'review',
      '1-9/a-z/Enter select',
      'Esc back',
    ],
    unexpect: ['coder —', 'Resume aaaaaaaaaaaa'],
  },
  {
    name: 'orchestrate-independent-subscription-preferences',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_BOTH_SUBSCRIPTION_PREFERENCES: '1',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: '',
      HARNESS_VISIBLE_WORKFLOW_AGENTS: '',
    },
    bootExpect: 'Model access — ChatGPT On · Grok Off · Kimi On · GLM Off',
    keys: ['3'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model access',
      'Set subscription preferences and how the rest is paid for.',
      'Prefer ChatGPT subscrip',
      'On · harness@example.edu',
      'Prefer Grok subscriptio',
      'Off · sign in required to enable',
      'Prefer Kimi Code subscr',
      'On · key configured',
      'Prefer GLM Coding Plan',
      'Off · key configured',
      'Esc back',
    ],
    unexpect: [
      '✓ 1. Prefer ChatGPT',
      '✓ 2. Prefer Grok',
      '✓ 3. Prefer Kimi Code',
      '✓ 4. Prefer GLM Coding Plan',
    ],
  },
  {
    name: 'orchestrate-history',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_ORCHESTRATION_HISTORY: '1',
    },
    bootExpect: 'Resume — 1 session',
    keys: ['2'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Team',
      'Choose a team for this session.',
      'Team lean-project',
      'Team physicist',
      'Esc back',
    ],
  },
  {
    name: 'orchestrate-resume-submenu',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_ORCHESTRATION_HISTORY: '1',
    },
    bootExpect: 'Resume — 1 session',
    keys: ['3'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Resume',
      'Choose a previous session to continue.',
      'cccccccccccc',
      'orchestrator',
      '1-9/a-z/Enter resume',
      'Esc back',
    ],
  },
  {
    name: 'compact-orchestrate-launcher',
    rows: 8,
    cols: 80,
    env: { HARNESS_ORCHESTRATION: '1' },
    bootExpect: 'New chat',
    keys: ['2'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    frame: 'viewport',
    expect: [
      'Team',
      'Choose a team for this session.',
      'Team lean-project',
      'unavailable',
      'no team root',
      '… 4 more',
      '1-9/a-z/Enter select',
      'Esc back',
    ],
    unexpect: [
      'texra multi-agent show <team-id>',
      'Researcher Access sign-in may unlock more remote team agents.',
      '/model models',
      'Tip:',
      'tool-use:',
      'workflow:',
    ],
  },
  {
    name: 'orchestrate-personal-model-pick',
    frame: 'scrollback',
    // Orchestration scenarios use harness model fixtures for provider-key
    // availability; API-key env fixtures are only needed by the real /model list.
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: '1',
    },
    bootExpect: 'Start a session or configure model access.',
    keys: ['\r'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model',
      'Model for the first message.',
      'DeepSeek V4 Flash — api: api key set',
      'Esc back',
    ],
  },
  {
    name: 'orchestrate-kimi-code-model-pick',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'personal',
      HARNESS_KIMI_CODE_SUBSCRIPTION: '1',
    },
    bootExpect: 'Start a session or configure model access.',
    keys: ['\r'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model',
      'DeepSeek V4 Flash — api: api key set',
      'Kimi K3 — api: Kimi Code subscription',
      'Esc back',
    ],
    unexpect: [
      'Model · Your own API keys',
      'Model · Kimi Code subscription',
      'Kimi K3 — api: api key set',
    ],
  },
  {
    name: 'orchestrate-model-pick-esc-back-reselect',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'personal',
      HARNESS_ORCHESTRATION_STATUS_LINES: '0',
    },
    bootExpect: 'Start a session or configure model access.',
    keys: ['\r', ESC, '\r'],
    exitKeys: [ESC, ESC],
    expectExit: true,
    expect: [
      'Model',
      'Model for the first message.',
      'DeepSeek V4 Flash — api: api key set',
      'Esc back',
    ],
    unexpect: ['Start a session or configure model access.', 'Esc exit'],
  },
  {
    name: 'orchestrate-no-runnable-models',
    frame: 'scrollback',
    env: {
      HARNESS_ORCHESTRATION: '1',
      HARNESS_API_MODE: 'personal',
      HARNESS_NO_RUNNABLE_MODELS: '1',
    },
    bootExpect: 'Start a session or configure model access.',
    keys: ['1'],
    exitKeys: [ESC],
    expectExit: true,
    expect: [
      'Start a session or configure model access.',
      'api: your own API keys',
      'auth: signed out',
      'New chat',
      'No models are available with your own API keys',
      'Help',
      'Esc exit',
    ],
    unexpect: ['Model · Your own API keys', 'DeepSeek V4 Flash'],
  },
  {
    name: 'slash-palette',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/mo'],
    expect: [
      '/model',
      'Choose the model for this chat',
      'Esc close',
      'Tab complete',
    ],
  },
  {
    name: 'slash-help',
    rows: 45,
    cols: 100,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/help', '\r'],
    frame: 'viewport',
    expect: [
      'Session',
      '/clear',
      'Start a fresh chat session',
      'Keyboard',
      '`Ctrl-C` exits idle chats; stops active responses',
      'Typing while a response is running queues your message as a follow-up.',
    ],
  },
  {
    name: 'slash-goal-help',
    cols: 100,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/goal', '\r'],
    frame: 'viewport',
    expect: [
      'Goal mode starts from an approved plan',
      'choose `r run as goal`',
      'Goal mode auto-approves bash only',
    ],
    unexpect: ['Unknown command: /goal', 'running 1s'],
  },
  {
    name: 'backslash-goal-help',
    cols: 100,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['\\goal', '\r'],
    frame: 'viewport',
    expect: [
      'Goal mode starts from an approved plan',
      'choose `r run as goal`',
      'Goal mode auto-approves bash only',
    ],
    unexpect: ['Unknown command: /goal', 'running 1s'],
  },
  {
    name: 'slash-resume-empty',
    cols: 100,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/resume', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/resume',
      'Nothing to resume yet.',
      'Esc close',
      'Keys go to the panel above',
    ],
    unexpect: ['/resume is registered but has no harness action.'],
  },
  {
    name: 'slash-clear',
    cols: 100,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_QUEUED_FOLLOWUPS: 'queued before clear',
    },
    keys: ['/clear', '\r', '/status', '\r'],
    frame: 'viewport',
    expect: [
      'agent: chat',
      'model: harness-model',
      'model access: Your own API keys',
      'status: not started',
      'queued follow-ups: 0',
    ],
    unexpect: [
      '/clear is registered but has no harness action.',
      'model access: undefined',
      'entry-1 chat history line',
      'queued before clear',
    ],
  },
  {
    name: 'unknown-slash-suggestion',
    cols: 100,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/hlp\r'],
    frame: 'viewport',
    expect: [
      'Unknown command: /hlp. Did you mean /help? Type /help to list commands.',
    ],
  },
  {
    name: 'narrow-slash-palette-command-names',
    rows: 16,
    cols: 52,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/'],
    frame: 'viewport',
    expect: [
      '/api',
      'Choose ChatGPT, Grok, Kimi Code, GLM…',
      '/auth',
      'Show signed-in accounts and active',
      '/models',
      'Enable or disable models in pickers',
      '… 14 more',
    ],
    unexpect: [
      '/ap  Switch',
      '/log  Sign',
      'personal model access',
      'automatically',
    ],
    maxLineColumns: 52,
  },
  {
    name: 'login-form',
    rows: 16,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/login\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/login',
      'ChatGPT subscription',
      'Researcher Access',
      'ChatGPT device code',
      'Researcher device code',
      '↑/↓ navigate',
      '1-4/Enter select',
      'Esc cancel',
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/login', max: 2 },
    ],
  },
  {
    name: 'slash-palette-ctrl-u-clears-raw-control',
    env: {
      HARNESS_ENTRIES: '4',
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/', `${NAK}/model\r`],
    frame: 'viewport',
    expect: ['/model · Your own API keys', 'Available models'],
    unexpect: ['/\u0015/model', '/model - error'],
  },
  {
    name: 'slash-palette-esc-retypes-command',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: PHYSICIST_LOCAL_TOOL_USE_AGENTS,
      HARNESS_VISIBLE_WORKFLOW_AGENTS: PHYSICIST_WORKFLOW_AGENTS,
    },
    keys: ['/', `${ESC}/agent\r`],
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Tool-use agents',
      'Workflows',
      'correct',
      'polish',
      'texra chat --agent <name>',
    ],
    unexpect: [
      '//agent',
      'Harness received: //agent',
      '/agent - error',
      'more workflows',
    ],
  },
  {
    name: 'slash-palette-csi-escape-ignored',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/', `${ESC}[13:2u`],
    expect: ['│ › /'],
    unexpect: ['[13:2u', 'Harness received'],
  },
  {
    name: 'plain-submit',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['prove the bounded case for n <= 20', '\r'],
    frame: 'viewport',
    expect: ['Harness received: prove the bounded case for n <= 20'],
    unexpect: ['signal read during notification phase', 'ERROR'],
  },
  {
    name: 'kitty-shift-enter-newline',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['first line', KITTY_SHIFT_ENTER, 'second line', '\r'],
    frame: 'viewport',
    expect: ['Harness received: first line\nsecond line'],
    unexpect: ['first linesecond line', '13;2u', '[13', 'ERROR'],
  },
  {
    name: 'ctrl-j-newline',
    cols: 120,
    env: { HARNESS_ENTRIES: '2' },
    keys: ['first line', LF, 'second line', '\r'],
    frame: 'viewport',
    expect: ['Harness received: first line\nsecond line'],
    unexpect: ['first linesecond line', 'ERROR'],
  },
  {
    name: 'agent-form',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: PHYSICIST_LOCAL_TOOL_USE_AGENTS,
      HARNESS_VISIBLE_WORKFLOW_AGENTS: PHYSICIST_WORKFLOW_AGENTS,
    },
    keys: ['/agent', '\r'],
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Tool-use agents',
      'research',
      'review',
      'latexFixer',
      'Workflows',
      'correct',
      'polish',
      'Current: chat (hidden from picker)',
      'texra chat --agent <name>',
      'Esc close',
    ],
    unexpect: [
      'Platform not initialized',
      '/agent - error',
      'texra --agent=<name>',
      'creator',
      'latexDiff',
      'lean',
      'setup',
      'more workflows',
      'tool-use; built-in',
      'delegating; built-in',
      'orchestrator; built-in',
    ],
  },
  {
    name: 'agent-form-80-cols',
    frame: 'scrollback',
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_TOOL_USE_AGENTS: PHYSICIST_LOCAL_TOOL_USE_AGENTS,
      HARNESS_VISIBLE_WORKFLOW_AGENTS: PHYSICIST_WORKFLOW_AGENTS,
    },
    keys: ['/agent', '\r'],
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Tool-use agents',
      'research',
      'review',
      'latexFixer',
      'Workflows',
      'correct',
      'polish',
      'Current: chat (hidden from picker)',
      'texra chat --agent <name>',
      'Esc close',
    ],
    unexpect: [
      'Platform not initialized',
      '/agent - error',
      'texra --agent=<name>',
      'creator',
      'latexDiff',
      'lean',
      'setup',
      'more workflows',
      'tool-use; built-in',
      'delegating; built-in',
      'orchestrator; built-in',
    ],
    maxLineColumns: 80,
  },
  {
    name: 'model-form',
    env: {
      HARNESS_ENTRIES: '4',
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'viewport',
    expect: [
      '/model · Your own API keys',
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
    env: {
      HARNESS_ENTRIES: '4',
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'viewport',
    expect: [
      '/model · Your own API keys',
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
      HARNESS_VISIBLE_MODELS: TWO_OPENAI_MODELS,
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'viewport',
    expect: [
      '/model · Your own API keys',
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
      HARNESS_DISABLED_MODEL_SWITCHES: 'sonnet46T',
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_MODELS: 'sonnet46T||gpt56',
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/model · Your own API keys',
      'Choose the model for future turns.',
      'Sonnet 4.6',
      'different conversation format',
      'GPT-5.6 Sol',
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
      HARNESS_VISIBLE_MODELS: TWO_OPENAI_MODELS,
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r', '\r'],
    frame: 'viewport',
    expect: ['Harness model selected. Future turns:'],
    unexpect: [
      'Finish the active response before switching models.',
      'Platform not initialized',
      '/model - error',
    ],
  },
  {
    name: 'model-form-buffered-hotkey',
    env: {
      HARNESS_CAN_SELECT_MODEL: '1',
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_MODELS: TWO_OPENAI_MODELS,
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r', '21'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: ['Harness model selected. Future turns:'],
    unexpect: [
      'Finish the active response before switching models.',
      'Platform not initialized',
      '/model - error',
    ],
  },
  {
    name: 'api-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/api',
      'ChatGPT preference:',
      'Kimi Code preference:',
      'Otherwise:',
      'Researcher Access:',
      'Your own API keys',
    ],
    unexpect: ['loading API status...'],
  },
  {
    name: 'config-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/config', '\r', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/config · Agents',
      'Workspace roster',
      'Default team',
      'Default chat agent',
      'Custom selection',
      '↑/↓ navigate',
      'Enter select',
      'Esc back',
    ],
    unexpect: [
      'No configurable settings are available here yet.',
      'Platform not initialized',
      '/config - error',
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/config', max: 8 },
    ],
  },
  {
    name: 'config-category-back-responsive',
    env: { HARNESS_ENTRIES: '4' },
    // Reuses the shared Select instance across category -> list -> category.
    keys: ['/config', '\r', '\r', ESC, DOWN, DOWN, '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/config · Git and worktrees',
      'Mark agent commits',
      'Agent commit author',
      'Agent commit email',
      'Subagent worktrees',
      '↑/↓ navigate',
      'Enter toggle / edit / open',
      'Esc back',
    ],
    unexpect: [
      '/config · Agents',
      'No configurable settings are available here yet.',
      'Platform not initialized',
      '/config - error',
    ],
  },
  {
    name: 'approval-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/approval', '\r'],
    frame: 'viewport',
    expect: [
      '/approval',
      'Choose when privileged actions prompt or auto-approve.',
      'Ask',
      'Never',
      'Auto-approve',
      '1-3/Enter select',
      'Esc cancel',
    ],
  },
  {
    name: 'approval-policy-status-bar',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/approval never', '\r', '/status', '\r'],
    expect: [
      'Approval mode: Deny Bash commands and tool edits.',
      'API keys',
      'never',
      '/status details',
    ],
    unexpect: ['keys deny', 'approval: deny privileged actions'],
  },
  {
    name: 'uninterruptible-running-status-bar',
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    frame: 'viewport',
    expect: ['Ctrl-C exit'],
    expectPatterns: [RUNNING_STATUS_PATTERN],
    unexpect: ['Ctrl-C stop'],
  },
  {
    // The status bar is the single owner of active-run liveness. The harness
    // starts 42s in the past; frame settlement may advance the displayed
    // second.
    name: 'single-run-liveness',
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    frame: 'viewport',
    expectPatterns: [
      /◆ [-|\/\\] running (?:4[2-9]s|5\ds|[1-9]\d*(?:m|h|d)(?: [1-9]\d*(?:s|m|h))?)/,
    ],
    unexpect: ['✻ Working', '✻ Thinking'],
  },
  {
    name: 'tools-form',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/tools', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/tools',
      'Toggle available external integrations',
      'always on ·',
      'Multi-Agent Workflow — disabled · detected · Ready',
      'disabled · detected · Ready',
    ],
    unexpect: ['[TeXRA]', 'toolUtils', 'enabled -', 'TeXRA CLI'],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/tools', max: 8 },
    ],
  },
  {
    name: 'workflow-script-toggle',
    env: {
      HARNESS_ENTRIES: '0',
      HARNESS_WORKFLOW_SCRIPT_DISABLED: '1',
    },
    keys: ['/tools', { input: '\r', delayMs: ASYNC_FORM_SETTLE_MS }, '4'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/tools',
      'Multi-Agent Workflow — enabled · detected · Ready',
      '1-7/Enter toggle',
    ],
  },
  {
    name: 'skills-form',
    env: { HARNESS_ENTRIES: '4', HARNESS_PROJECT_SKILL: '1' },
    keys: ['/skills', '\r'],
    frame: 'viewport',
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
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: ['Harness skill selected: proof-audit.'],
    unexpect: [
      'No skills found',
      '/skills - error',
      'Platform not initialized',
    ],
  },
  {
    name: 'skills-form-buffered-hotkey',
    env: { HARNESS_ENTRIES: '4', HARNESS_PROJECT_SKILL: '1' },
    keys: ['/skills', '\r', '21'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: ['Harness skill selected:'],
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
      HARNESS_VISIBLE_TOOL_USE_AGENTS: PHYSICIST_LOCAL_TOOL_USE_AGENTS,
      HARNESS_VISIBLE_WORKFLOW_AGENTS: PHYSICIST_WORKFLOW_AGENTS,
    },
    keys: ['/agent', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/agent',
      'Current: chat (hidden from picker)',
      'Tool-use agents',
      '+4 more',
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
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_VISIBLE_MODELS: TWO_OPENAI_MODELS,
      OPENAI_API_KEY: 'harness-openai-key',
    },
    keys: ['/model', '\r'],
    frame: 'viewport',
    expect: [
      '/model · Your own API keys',
      'Available models',
      '+1 more',
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
    frame: 'viewport',
    expect: [
      '/api',
      'Model access',
      'Prefer ChatGPT subscrip',
      'Prefer Grok subscription',
      '↑/↓ navigate',
      '1-4/Enter select',
      'Esc close',
    ],
  },
  {
    name: 'api-form-chatgpt-hotkey',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/api', '\r', '1'],
    frame: 'viewport',
    expect: ['chatgpt preference set to on.'],
  },
  {
    name: 'api-form-kimi-hotkey',
    rows: 12,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      KIMI_CODE_API_KEY: 'harness-kimi-code-key',
    },
    keys: ['/api', '\r', '3'],
    frame: 'viewport',
    expect: ['Prefer Kimi Code subscription enabled'],
    expectCollapsed: ['other models still use your own API keys'],
    unexpect: ['No Kimi Code API key configured'],
  },
  {
    name: 'compact-approval-form',
    rows: 10,
    cols: 60,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/approval', '\r'],
    frame: 'viewport',
    expect: [
      '/approval',
      'Ask',
      'Never',
      'Auto-approve',
      '↑/↓ navigate',
      '1-3/Enter select',
      'Esc cancel',
      'Esc cancel',
    ],
    unexpect: [
      'Choose when privileged actions prompt or auto-approve.',
      '1-3 select now',
    ],
    maxLineColumns: 60,
  },
  {
    name: 'memory-form',
    cols: 100,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_MEMORY_FILES: 'project.md||ideas.md||notes/plan.md',
    },
    keys: ['/memory', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/memory',
      'Choose a memory to preview. Press Esc to close.',
      '/memories/project.md',
      '/memories/ideas.md',
      '/memories/notes/plan.md',
      '↑/↓ navigate',
      '1-3/Enter preview',
      'Esc close',
    ],
    unexpect: ['No memory files found.', '/memory - error'],
  },
  {
    // Short terminals collapse /memory to the shared compact single-row
    // variant instead of overflowing the viewport.
    name: 'compact-memory-form',
    rows: 12,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_MEMORY_FILES: 'a.md||b.md||c.md||d.md||e.md||f.md',
    },
    keys: ['/memory', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/memory',
      '/memories/a.md',
      '+5 more',
      '↑/↓ navigate',
      '1-6/Enter preview',
      'Esc close',
    ],
    unexpect: [
      'Choose a memory to preview. Press Esc to close.',
      'No memory files found.',
      '/memory - error',
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: '/memory', max: 2 },
    ],
  },
  {
    name: 'compact-tools-form',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4' },
    keys: ['/tools', '\r'],
    frame: 'viewport',
    settleMs: ASYNC_FORM_SETTLE_MS,
    expect: [
      '/tools',
      'Toggle available external integrations',
      '+1 earlier, +5 more',
      '↑/↓ navigate',
      '1-7/Enter toggle',
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
    frame: 'viewport',
    expect: [
      '… 5 earlier',
      '/key',
      'Add a provider API key with masked input',
      '/auth',
      'Show signed-in accounts and active model access',
      '/login',
      'Sign in to ChatGPT or Researcher Access',
      '/logout',
      'Sign out of one account or all accounts',
      '/approval',
      'Switch approval policy',
      '… 10 more',
      'Esc close',
    ],
  },
  {
    name: 'edit-approval',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: [
      'Apply edit to draft.tex?',
      'y approve',
      'n reject',
      'approval',
      'Keys go to the panel above',
    ],
    unexpect: ['Alt-p tasks', 'Option-p tasks', '/model models'],
  },
  {
    name: 'edit-approval-opens-at-change',
    rows: 16,
    cols: 80,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: [
      'Apply edit to acknowledgments.tex?',
      '-Old acknowledgment.',
      '+Revised acknowledgment.',
      'previous rows',
      'y approve',
      'n reject',
    ],
    unexpect: ['First context paragraph', '/model models'],
  },
  {
    name: 'edit-approval-reanchors-after-resize',
    rows: 16,
    cols: 120,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    resizes: [{ cols: 40, rows: 16 }],
    frame: 'viewport',
    expect: [
      '-Old acknowledgment.',
      '+Revised acknowledgment.',
      'previous',
      'y approve',
      'n reject',
    ],
    unexpect: ['First context paragraph', '/model models'],
  },
  {
    name: 'edit-approval-feedback',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['n', 'needs direct proof'],
    frame: 'viewport',
    expect: [
      'Apply edit to draft.tex?',
      '› needs direct proof',
      'Enter send note',
      'Esc back',
      '1 approval',
    ],
    unexpect: ['/model models'],
  },
  {
    name: 'edit-approval-feedback-preserves-scroll',
    rows: 24,
    cols: 40,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    keys: [
      { input: UP.repeat(20), delayMs: 200 },
      'n',
      'This rejection note is deliberately long enough to wrap across several terminal rows.',
    ],
    frame: 'viewport',
    expect: [
      'alpha alpha alpha alpha alpha',
      '› This rejection note is deliberately',
      'Enter send note',
      'Esc back',
    ],
    unexpect: ['-Old acknowledgment.', '+Revised acknowledgment.'],
  },
  {
    name: 'edit-approval-feedback-exit-reanchors',
    rows: 16,
    cols: 40,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    keys: [
      'n',
      'This rejection note is deliberately long enough to make the diff compact.',
      ESC,
    ],
    frame: 'viewport',
    expect: [
      '-Old acknowledgment.',
      '+Revised acknowledgment.',
      'previous',
      'y approve',
      'n reject',
    ],
    unexpect: ['First context paragraph', 'Enter send note'],
  },
  {
    name: 'edit-approval-feedback-exit-preserves-scroll',
    rows: 24,
    cols: 40,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    keys: [{ input: UP.repeat(20), delayMs: 200 }, 'n', 'short note', ESC],
    frame: 'viewport',
    expect: ['alpha alpha alpha alpha alpha', 'y approve', 'n reject'],
    unexpect: ['-Old acknowledgment.', '+Revised acknowledgment.'],
  },
  {
    name: 'edit-approval-feedback-exit-reanchors-after-shortening',
    rows: 16,
    cols: 40,
    env: { ...WRAPPED_EDIT_APPROVAL_ENV },
    bootExpect: '· Ctrl-C ',
    keys: [
      'n',
      'This rejection note is deliberately long enough to make the diff compact.',
      NAK,
      'short note',
      ESC,
    ],
    frame: 'viewport',
    expect: [
      '-Old acknowledgment.',
      '+Revised acknowledgment.',
      'previous',
      'y approve',
      'n reject',
    ],
    unexpect: ['First context paragraph', 'Enter send note'],
  },
  {
    name: 'narrow-edit-approval',
    rows: 12,
    cols: 40,
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: [
      'Apply edit to draft.tex?',
      'y approve',
      'n reject',
      'Esc reject',
      'approval',
    ],
    unexpect: [' · …', '╚═y approve'],
  },
  {
    name: 'edit-approval-approve',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['y'],
    frame: 'viewport',
    expect: ['/status details', '/model models'],
    unexpect: ['Apply edit to draft.tex?', '1 approval'],
  },
  {
    name: 'bash-approval',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    resizes: [{ cols: 120 }],
    expect: [
      'agent: chat · model: harness-model',
      'Run command?',
      '$ npm run compile:safe',
      'Directory:',
      'y approve',
      'a approve commands for session',
      'Keys go to the panel above',
    ],
    unexpect: ['Alt-p tasks', 'Option-p tasks', '/model models'],
    maxOccurrences: [{ text: '{ T } TeXRA', max: 1 }],
    ordered: [
      {
        before: 'agent: chat · model: harness-model',
        after: '› entry-1 chat history line',
      },
      {
        before: 'agent: chat · model: harness-model',
        after: 'Run command?',
      },
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: 'Run command?', max: 3 },
    ],
  },
  {
    name: 'narrow-bash-approval',
    rows: 12,
    cols: 40,
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: [
      'Run command?',
      '$ npm run compile:safe',
      'Directory:',
      'y approve',
      'n reject',
      'Esc reject',
    ],
    unexpect: [' · …', 'a cmd session'],
  },
  {
    name: 'bash-approval-feedback',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['n', 'use portable python3 instead'],
    frame: 'viewport',
    expect: [
      'Run command?',
      '› use portable python3 instead',
      'Enter send note',
      'Esc back',
      '1 approval',
    ],
    unexpect: ['/model models'],
  },
  {
    name: 'long-bash-approval',
    frame: 'scrollback',
    rows: 24,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Run command?',
      'Directory:',
      "$ python3 << 'EOF'",
      'more rows',
      'scroll command',
      'y approve',
      'Keys go to the panel above',
    ],
    unexpect: ['╚═    print', 'Option-p tasks'],
  },
  {
    name: 'compact-long-bash-approval',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: [
      'Run command?',
      'Directory:',
      "$ python3 << 'EOF'",
      'more rows',
      'scroll command',
      'y approve',
      'Keys go to the panel above',
    ],
    unexpect: ['╚═    print', 'Option-p tasks'],
  },
  {
    name: 'compact-long-bash-approval-scroll',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '· Ctrl-C ',
    keys: [DOWN, DOWN, DOWN],
    frame: 'viewport',
    expect: [
      'Run command?',
      'Directory:',
      'x2 = 1 + 2 * y * y',
      'previous',
      'more rows',
      'scroll command',
      'y approve',
    ],
    unexpect: ["$ python3 << 'EOF'", 'Option-p tasks'],
  },
  {
    name: 'compact-long-bash-approval-page',
    rows: 14,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '· Ctrl-C ',
    keys: [PAGE_DOWN],
    frame: 'viewport',
    expect: [
      'Run command?',
      'Directory:',
      'for y in range(1, 100):',
      'previous',
      'more rows',
      'PgUp/PgDn page',
    ],
    unexpect: ["$ python3 << 'EOF'", 'Option-p tasks'],
  },
  {
    name: 'tiny-compact-long-bash-approval',
    rows: 11,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_COMMAND: LONG_BASH_APPROVAL_COMMAND,
    },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
    expect: ['Run command?', 'Directory:', 'rows hidden', 'y approve'],
    unexpect: ['Option-p tasks'],
  },
  {
    name: 'bash-approval-approve-session',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['a'],
    frame: 'viewport',
    expect: ['AUTO-BASH', '/status details', '/model models'],
    unexpect: ['AUTO-APPROVE', 'Run command?', '1 approval'],
  },
  {
    name: 'bash-approval-approve-twice',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_REPEATED_BASH_APPROVAL: '1',
    },
    bootExpect: '· Ctrl-C ',
    keys: ['y', { input: 'y', delayMs: 1000 }],
    settleMs: 6000,
    frame: 'viewport',
    expect: ['SECOND-BASH-APPROVED', '/status details', '/model models'],
    unexpect: ['Run command?', '1 approval'],
  },
  {
    name: 'bash-approval-session-status',
    env: { HARNESS_ENTRIES: '4', HARNESS_BASH_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['a', '/status', '\r'],
    frame: 'viewport',
    expect: [
      'approval: Control Bash and edit prompts independently.',
      'auto-approvals: commands',
      'AUTO-BASH',
    ],
    unexpect: ['Run command?', '1 approval'],
  },
  {
    name: 'team-status-empty-subagents-hidden',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_CAN_DELEGATE: '1',
      HARNESS_TEAM_NAME: 'Physicist',
    },
    bootExpect: '· Ctrl-C ',
    keys: ['a', '/status', '\r'],
    frame: 'viewport',
    expect: ['team: Physicist', 'auto-approvals: commands', 'AUTO-BASH'],
    unexpect: ['Run command?', '1 approval', 's subagents'],
  },
  {
    name: 'agent-proposal-long',
    frame: 'scrollback',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Spawn review?',
      FULL_WIDTH_AGENT_PROPOSAL_BORDER_80,
      'Category: tool-use agent',
      'Review the mathematical proof',
      'more rows',
      'scroll prompt',
      'PgUp/PgDn page',
      'y approve',
      'n reject',
      'a all agent work',
      'Press y to approve only this task',
      'Press a to approve delegated tasks, file',
      'edits, and commands for this chat',
      'Other prompts still ask',
    ],
    unexpect: ['confirmation of correctness', 'Option-p tasks'],
  },
  {
    name: 'narrow-agent-proposal-actions',
    frame: 'viewport',
    rows: 24,
    cols: 60,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Spawn review?',
      'y approve',
      'n reject',
      'a all agent work',
      'Esc reject',
      'Press y to approve only this task',
      'Press a to approve',
      'delegated tasks, file edits, and commands for this chat',
      'Other prompts still ask',
    ],
    maxLineColumns: 60,
  },
  {
    name: 'wide-agent-proposal-scope-copy',
    frame: 'viewport',
    rows: 30,
    cols: 100,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: 'y approve',
    expect: [
      'Spawn review?',
      'y approve',
      'n reject & note',
      'a approve agent work for this chat',
      'Esc reject',
      'Press y to approve only this task',
      'Press a to approve delegated tasks, file edits, and commands',
      'for this chat. Other prompts still ask',
    ],
    maxLineColumns: 100,
  },
  {
    name: 'compact-agent-proposal-scroll',
    rows: 17,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
    ],
    frame: 'viewport',
    expect: [
      'Spawn review?',
      'Model: deepseekT',
      'Category: tool-use agent',
      'Include a short independent enumeration',
      'previous, 1 more rows',
      'scroll prompt',
      'y approve',
      'n reject',
      'a all agent work',
      'Press y to approve only this task',
      'Press a to approve delegated tasks, file',
      'edits, and commands for this chat',
      'Other prompts still ask',
    ],
    unexpect: ['prompt rows hidden', 'Option-p tasks'],
    maxLineColumns: 80,
  },
  {
    name: 'agent-proposal-approve-all',
    rows: 24,
    cols: 100,
    env: { HARNESS_ENTRIES: '2', HARNESS_AGENT_PROPOSAL: '1' },
    bootExpect: 'a approve agent work for this chat',
    keys: ['a', '/status', '\r'],
    frame: 'viewport',
    expect: ['auto-approvals: delegated tasks, commands, file edits'],
    unexpect: ['Spawn review?'],
  },
  {
    name: 'external-inquiry-long',
    rows: 24,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER],
    frame: 'viewport',
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
      '/model models',
      'Esc panel',
      'Esc sk…',
      '1 approval',
    ],
  },
  {
    name: 'external-inquiry-long-80-cols',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER],
    frame: 'viewport',
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
      '/model models',
      'Esc panel',
      'Esc sk…',
      '1 approval',
    ],
  },
  {
    name: 'external-inquiry-copy-question',
    rows: 24,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [EM],
    frame: 'viewport',
    fakeClipboard: {
      expectIncludes: [
        'Problem: Find all integer triples',
        'whose perimeter is at most 120',
      ],
    },
    expect: ['Agent asks: copied to clipboard', 'Ctrl-Y copy', '1 question'],
    unexpect: ['copy failed', '/model models', '1 approval'],
  },
  {
    name: 'external-inquiry-submit-answer',
    rows: 24,
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER, '\r'],
    frame: 'viewport',
    expect: [
      '[inquiry] ei_123456abcdef answered.',
      'A: Independent check agrees',
      'Full thread: ei_123456abcdef',
      'No other open inquiries on this stream.',
      'Proceed using the new answer.',
      '/status details',
      '/model models',
    ],
    unexpect: [
      'Agent asks:',
      '1 question',
      '1 approval',
      "inquiry { command: 'read'",
    ],
  },
  {
    name: 'external-inquiry-submit-long-answer',
    rows: 36,
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_EXTERNAL_INQUIRY: '1' },
    bootExpect: '· Ctrl-C ',
    keys: [LONG_EXTERNAL_INQUIRY_ANSWER_FOR_TRUNCATION, '\r'],
    frame: 'viewport',
    expect: [
      '[inquiry] ei_123456abcdef answered.',
      'A: Long verification note 01',
      'full text',
      'available in thread ei_123456abcdef',
      'Full thread: ei_123456abcdef',
      'No other open inquiries on this stream.',
      'Proceed using the new answer.',
    ],
    unexpect: [
      'Agent asks:',
      '1 question',
      '1 approval',
      "inquiry { command: 'read'",
    ],
  },
  {
    name: 'compact-user-question',
    rows: 12,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_USER_QUESTION: '1' },
    bootExpect: '· Ctrl-C ',
    frame: 'viewport',
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
      '/model models',
      'Esc panel',
      'Context detail: the candidate proof',
      '1 approval',
    ],
    maxLineColumns: 80,
  },
  {
    name: 'plan-approval',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4', HARNESS_PLAN_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'y approve',
      'n reject',
    ],
    unexpect: [
      'r run as goal',
      'Runs until done; only Bash is automatic',
      '/model models',
    ],
    maxBlankLinesBetween: [
      { from: 'entry-4 chat history line', to: 'Approve plan?', max: 3 },
    ],
  },
  {
    name: 'plan-approval-goal',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
    },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'Split the finite and symbolic cases',
      'Runs until done; only Bash is automatic',
      'r run as goal',
      'y approve',
      'n reject',
    ],
    unexpect: ['/model models'],
  },
  {
    name: 'plan-approval-wrap-boundary',
    frame: 'scrollback',
    rows: 24,
    cols: 81,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
      HARNESS_PLAN_APPROVAL_OBJECTIVE: [
        '  CLI Dogfood Friction Report',
        '**Objective:** During the course of this CLI dogfood session, observe and document any friction, rough edges, or UX issues in the CLI/TUI interaction',
        '- Awkward or redundant tool flows',
        '- Confusing prompt/response formatting',
        '- Latency or feedback issues',
        '- Inconsistent terminology or mental-model mismatches',
        '- Any point where the interaction felt surprising or obstructive',
        '',
        '**Approach:** Keep a running mental log of friction points as tasks progress. At natural stopping points, call `todo_write` to record specific observations. Do not edit any files — only observe and report.',
        '**Stopping condition:** A summary report of all observed friction has been written to a memory note under `/memories/dogfood-friction.md` (no file edits — use the `memory` tool).',
      ].join('\n'),
    },
    bootExpect: '· Ctrl-C ',
    // The plan body is bounded and scrollable; page down to bring the
    // wrap-boundary continuation into view before asserting on it.
    keys: [PAGE_DOWN],
    expect: [
      'Approve plan?',
      'Runs until done; only Bash is automatic',
      'observations. Do not edit any files',
      'scroll plan',
      'r run as goal',
      'y approve',
      'n reject',
      'Esc reject',
    ],
    unexpect: [
      ' bservations. Do not edit any files',
      '║  At natural stopping points',
    ],
  },
  {
    name: 'plan-approval-stale-tail',
    frame: 'scrollback',
    rows: 40,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
      HARNESS_PLAN_APPROVAL_OBJECTIVE: [
        '## Objective',
        'Prove that $\\sqrt{2} + \\sqrt{3}$ is irrational.',
        '',
        '## Approach',
        '1. Assume, for contradiction, that $\\sqrt{2} + \\sqrt{3}$ is rational, i.e. $x = \\sqrt{2} + \\sqrt{3} \\in \\mathbb{Q}$.',
        '2. Square both sides and isolate terms to derive a contradiction about $\\sqrt{6}$.',
        '3. Conclude that the original number is irrational.',
        "4. Delegate a brief independent verification to the `review` subagent to check the derivation's correctness.",
        '',
        '## Stopping condition',
        '- A correct, self-contained proof is written here in the chat.',
        '- The `review` subagent has confirmed the reasoning is sound (or flagged issues).',
      ].join('\n'),
    },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Approve plan?',
      'Runs until done; only Bash is automatic',
      '4. Delegate a brief independent verification to the `review` subagent to',
      "check the derivation's correctness.",
      'r run as goal',
      'y approve',
      'n reject',
    ],
    unexpect: ['correctness.ification to the `review`'],
  },
  {
    name: 'compact-plan-approval',
    frame: 'scrollback',
    rows: 10,
    cols: 80,
    env: { HARNESS_ENTRIES: '4', HARNESS_PLAN_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'y approve',
      'n reject',
      'Esc reject',
    ],
    unexpect: ['Runs until done; only Bash is automatic', '/model models'],
  },
  {
    name: 'compact-plan-approval-goal',
    frame: 'scrollback',
    rows: 10,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
    },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Approve plan?',
      'Coordinate a short math proof through CLI chat.',
      'Split the finite and symbolic cases',
      'Runs until done; only Bash is automatic',
      'r run as goal',
      'y approve',
      'n reject',
      'Esc reject',
    ],
    unexpect: ['/model models'],
  },
  {
    name: 'plan-approval-approve-goal',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
    },
    bootExpect: '· Ctrl-C ',
    keys: ['r', '/status', '\r'],
    frame: 'viewport',
    expect: [
      'PLAN-GOAL',
      'auto-approvals: commands',
      'status: running',
      'goal: active',
      'goal objective: Coordinate a short math proof through CLI chat.',
      '/status details',
      '/model models',
    ],
    unexpect: ['Approve plan?', '1 approval'],
  },
  {
    name: 'plan-approval-ctrl-r-ignored',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_PLAN_APPROVAL: '1',
      HARNESS_PLAN_APPROVAL_GOAL: '1',
    },
    bootExpect: '· Ctrl-C ',
    keys: [DC2],
    frame: 'viewport',
    expect: ['Approve plan?', 'r run as goal', '1 approval'],
    unexpect: ['PLAN-GOAL', '/model models'],
  },
  {
    name: 'retry-approval',
    frame: 'scrollback',
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_RETRY_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Retry the failed call?',
      'HTTP 429 Too Many Requests',
      'Press k to use your own API key for this retry.',
      'retry',
      'dismiss',
      'use your own API key',
      '1 approval',
    ],
    unexpect: ['Feedback to send with rejection', 'send note', '/model models'],
  },
  {
    name: 'retry-approval-chatgpt',
    frame: 'scrollback',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_RETRY_APPROVAL: '1',
      HARNESS_RETRY_APPROVAL_CHATGPT: '1',
    },
    bootExpect: '· Ctrl-C ',
    expect: [
      'Retry the failed call?',
      'ChatGPT subscription usage limit reached. Resets in 2h.',
      'Press k to use your own API key for this retry.',
      'retry',
      'dismiss',
      'use your own API key',
      '1 approval',
    ],
    unexpect: ['Feedback to send with rejection', 'send note', '/model models'],
  },
  {
    name: 'retry-approval-reject',
    frame: 'viewport',
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_RETRY_APPROVAL: '1' },
    bootExpect: 'dismiss',
    keys: ['n'],
    expect: ['RETRY-REJECTED', '/status details', '/model models'],
    unexpect: [
      'Retry the failed call?',
      'Feedback to send with rejection',
      'send note',
      '1 approval',
    ],
  },
  {
    name: 'retry-approval-switch-api',
    cols: 120,
    env: { HARNESS_ENTRIES: '4', HARNESS_RETRY_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['k'],
    frame: 'viewport',
    expect: ['RETRY-PERSONAL-CREDENTIALS', '/status details', '/model models'],
    unexpect: ['Retry the failed call?', '1 approval'],
  },
  {
    name: 'edit-approval-reject',
    env: { HARNESS_ENTRIES: '4', HARNESS_EDIT_APPROVAL: '1' },
    bootExpect: '· Ctrl-C ',
    keys: ['n', '\r'],
    frame: 'viewport',
    expect: ['/status details', '/model models'],
    unexpect: ['Apply edit to draft.tex?', '1 approval'],
  },
  {
    name: 'subagents',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: [
      'strategy',
      'leanSolver',
      'reviewer',
      // Child rows show the stream description supplied by the harness.
      'reviewer sub-workflow',
      'leanSolver sub-workflow',
      // Right-aligned metadata column: generated tokens for a child with usage.
      '↓40k',
      '3 agents',
      'Tab input',
    ],
    unexpect: ['Option-p tasks', 'Option-s subagents'],
  },
  // PTY ordering tests (issue #7972): the harness drives one child stream's
  // attachment/roster/edge/status/removal facts through the real
  // `attachSessionSignalsAdapter` rail (`sessionSignalsAdapter.ts`) — the same
  // wiring `chatSessionController.ts` installs for a real run — which lands
  // them on the shared `SessionState`; the CLI's `childRosters`/`parentStream`
  // computed signals (`childExecutions.ts`) re-derive from there, and the
  // harness keeps no side channel into either. After each fact, the harness
  // awaits the Ink render flush and emits an out-of-band marker. The validator
  // snapshots xterm at that exact byte-stream boundary, so a transiently-wrong
  // frame fails the scenario even when the next fact has already arrived.
  //
  // `canonical`/`roster-first`/`edge-first`/`status-first` apply the same four
  // facts (attachment, running status, roster, edge) in every order the
  // vitest "child-stream ordered transition matrix" proves order-equivalent
  // (src/test-kernel/cli/TuiStateAndFocus.vitest.mts, scenarios 1-4) and must
  // converge on a byte-identical settled frame. `equivalentFrameTo` names the
  // canonical frame oracle. The remaining four correct old ambiguous transients
  // (promotion, reattachment, parent removal, completion+removal — matrix
  // scenarios 6, 7, 11, and 5-then-8) get their own checkpoint expectations
  // instead of byte-equivalence, per the design doc.
  {
    name: 'child-event-order-canonical',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'canonical',
      HARNESS_CWD: CHILD_EVENT_ORDER_CWD,
    },
    // Steps: A, S(running), R_P+, E_P+.
    checkpoints: [
      {
        unexpect: ['Tab sessions', '1 agent', 'orderChecker'],
      },
      {
        unexpect: ['Tab sessions', '1 agent', 'orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
    ],
    expect: ['1 agent', 'Tab sessions'],
    unexpect: ['orderChecker'],
  },
  {
    name: 'child-event-order-roster-first',
    equivalentFrameTo: 'child-event-order-canonical',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'roster-first',
      HARNESS_CWD: CHILD_EVENT_ORDER_CWD,
    },
    // Steps: R_P+, A, S(running), E_P+.
    checkpoints: [
      {
        // Active via the roster's retained-parent fallback, before the
        // child's own StreamSlice exists — not yet focusable.
        expect: ['1 agent'],
        unexpect: ['Tab sessions', 'orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
    ],
    expect: ['1 agent', 'Tab sessions'],
    unexpect: ['orderChecker'],
  },
  {
    name: 'child-event-order-edge-first',
    equivalentFrameTo: 'child-event-order-canonical',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'edge-first',
      HARNESS_CWD: CHILD_EVENT_ORDER_CWD,
    },
    // Steps: E_P+, A, S(running), R_P+.
    checkpoints: [
      {
        // An edge alone cannot be focused until the child's StreamSlice exists.
        expect: ['◆'],
        unexpect: [
          'Tab sessions',
          '1 agent',
          'orderChecker',
          'harness-child-eve',
        ],
      },
      {
        // Attachment creates the slice and makes the existing edge focusable;
        // the running marker still waits for the next status fact.
        expect: ['Tab sessions'],
        unexpect: ['1 agent', 'orderChecker', 'harness-child-eve'],
      },
      {
        expect: ['Tab sessions'],
        unexpect: ['1 agent', 'orderChecker', 'harness-child-eve'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
    ],
    expect: ['1 agent', 'Tab sessions'],
    unexpect: ['orderChecker'],
  },
  {
    name: 'child-event-order-status-first',
    equivalentFrameTo: 'child-event-order-canonical',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'status-first',
      HARNESS_CWD: CHILD_EVENT_ORDER_CWD,
    },
    // Steps: S(running), A, E_P+, R_P+.
    checkpoints: [
      {
        unexpect: [
          'Tab sessions',
          '1 agent',
          'orderChecker',
          'harness-child-eve',
        ],
      },
      {
        // Attachment does not supply a parent edge, so the running slice is
        // registered but still absent from the root's session list.
        unexpect: [
          'Tab sessions',
          '1 agent',
          'orderChecker',
          'harness-child-eve',
        ],
      },
      {
        expect: ['Tab sessions'],
        unexpect: ['1 agent', 'orderChecker', 'harness-child-eve'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
    ],
    expect: ['1 agent', 'Tab sessions'],
    unexpect: ['orderChecker'],
  },
  // The remaining four orderings correct old ambiguous transients (promotion,
  // reattachment, parent removal, completion+removal) instead of being
  // order-equivalent with the four above, so they get their own checkpoint
  // expectations and no frame oracle, per the design doc.
  {
    name: 'child-event-order-promotion-late-roster',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'promotion-late-roster',
    },
    // Steps: A, S(running), R_P+, E_P+, E0 (promote to top-level), R_P+ (late,
    // stale roster from the former parent).
    checkpoints: [
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { expect: ['Tab sessions', '1 agent'], unexpect: ['orderChecker'] },
      { expect: ['Tab sessions', '1 agent'], unexpect: ['orderChecker'] },
      {
        // Promoted to top-level: no longer active under root. The historical
        // relationship still contributes to the retained subagent count, but
        // the unified root session list omits the unrelated row.
        expect: ['1 agent', 'Tab sessions'],
        unexpect: ['orderChecker'],
      },
      {
        // A stale roster resend from the former parent must not resurrect
        // the edge or active membership; only retained history remains.
        expect: ['1 agent', 'Tab sessions'],
        unexpect: ['orderChecker'],
      },
    ],
    // Prove the root session list remains interactive after the late fact.
    keys: ['\t', DOWN, '\r'],
    expectExit: true,
  },
  {
    name: 'child-event-order-reattach-late-old-roster',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'reattach-late-old-roster',
    },
    // Steps: A, S(running), R_other+, E_other+, E0, R_other+ (stale), E_P+
    // (root), R_P+ (root), R_other+ (late, stale — from the child's former,
    // never-displayed parent).
    checkpoints: [
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      // Facts scoped to the never-displayed former parent must not leak into
      // root's own view at any point.
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      {
        expect: ['Tab sessions'],
        unexpect: ['1 agent', 'orderChecker', 'harness-child-eve'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        // A late, stale roster from the child's former parent must not erase
        // active membership under the new (root) parent.
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
    ],
    // Prove the TUI is still interactive by focusing the reattached child.
    keys: ['\t', DOWN, '\r'],
    expectExit: true,
  },
  {
    name: 'child-event-order-parent-removal',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'parent-removal',
    },
    // Steps: S(running) [child], R_other+, E_other+, X(other) [parent
    // removal], R_other+ (late), E_other+ (late) — `other` is never root, so
    // none of this should ever surface on root's own view; the assertion is
    // that late facts naming a removed parent don't resurrect it anywhere or
    // wedge the TUI.
    checkpoints: [
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['1 agent', 'orderChecker'] },
      { unexpect: ['1 agent', 'orderChecker'] },
      { unexpect: ['1 agent', 'orderChecker'] },
      { unexpect: ['1 agent', 'orderChecker'] },
      { unexpect: ['1 agent', 'orderChecker'] },
    ],
    // Prove the TUI is still interactive after the removal + late facts:
    // nothing under the removed parent is reachable from root. Opening and
    // confirming the root row must leave the frame and exit path intact.
    keys: ['\t', DOWN, '\r'],
    expect: ['◆ — API keys'],
    unexpect: ['1 agent', 'orderChecker'],
    expectExit: true,
  },
  {
    name: 'child-event-order-completion-remove',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILD_EVENT_ORDER: 'completion-remove',
    },
    // Steps: A, S(running), R_P+, E_P+, R_P- (roster omission), S(terminal),
    // X(child), R_P+ (late), E_P+ (late), A (late), late resume attempt.
    checkpoints: [
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { unexpect: ['Tab sessions', '1 agent', 'orderChecker'] },
      { expect: ['Tab sessions', '1 agent'], unexpect: ['orderChecker'] },
      { expect: ['Tab sessions', '1 agent'], unexpect: ['orderChecker'] },
      {
        // Untrack (roster omission) arrives before the terminal status: the
        // retained/historical relationship survives in the compact count.
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        expect: ['Tab sessions', '1 agent'],
        unexpect: ['orderChecker'],
      },
      {
        // Removal scrubs every trace, including the retained/historical row.
        unexpect: ['orderChecker', '1 agent', 'Tab sessions'],
      },
      {
        unexpect: ['orderChecker', '1 agent', 'Tab sessions'],
      },
      {
        unexpect: ['orderChecker', '1 agent', 'Tab sessions'],
      },
      {
        // A late re-attachment attempt for the removed id must stay ignored.
        unexpect: ['orderChecker', '1 agent', 'Tab sessions'],
      },
      {
        // A late resume-transition attempt is the one status fact that would
        // otherwise reach `setStreamStatusInCliState` (a repeated terminal
        // transition is a same-value no-op the status machine drops before
        // it gets there) — it must still stay suppressed by the removal
        // tombstone.
        unexpect: ['orderChecker', '1 agent', 'Tab sessions'],
      },
    ],
    // Prove the TUI is still interactive after the removal + late facts:
    // the removed child is unreachable, so confirming the root row must leave
    // the frame and exit path intact.
    keys: ['\t', DOWN, '\r'],
    expect: ['◆ — API keys'],
    unexpect: ['orderChecker', '1 agent'],
    expectExit: true,
  },
  {
    name: 'failed-subagent-status',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_FAILED_CHILD: 'reviewer',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: [
      'strategy running',
      'leanSolver idle',
      'reviewer error',
      '3 agents',
      'Tab input',
    ],
    unexpect: ['reviewer running'],
  },
  {
    name: 'subagents-with-todos-compact',
    frame: 'scrollback',
    rows: 14,
    cols: 80,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_TODOS: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: ['3 agents', '2 active', 'Tab sessions', 'Ctrl-C stop'],
  },
  {
    name: 'subagents-with-todos-narrow-status',
    frame: 'scrollback',
    rows: 14,
    cols: 44,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_TODOS: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: ['3 agents', '2 active', 'Tab sessions', 'Ctrl-C stop'],
    unexpect: ['Option-p tasks'],
  },
  {
    name: 'subagents-narrow-navigation',
    frame: 'viewport',
    rows: 20,
    cols: 27,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    // The collapsed frame must retain a discoverable Tab affordance even when
    // the child count no longer fits; Tab then expands and focuses the list.
    bootExpect: 'Tab sessions',
    keys: ['\t'],
    expect: ['Choosing a session', 'strategy runni'],
    expectCollapsed: ['Choosing a session'],
    unexpect: ['signal read during notification phase', 'ERROR'],
  },
  {
    name: 'subagent-focused-submit',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [
      '\t',
      DOWN,
      DOWN,
      DOWN,
      '\r',
      'child follow-up on focused stream',
      '\r',
    ],
    frame: 'viewport',
    expect: [
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
    name: 'subagent-list-focus-full-frame',
    frame: 'scrollback',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r'],
    expect: ['strategy is checking the harness-child-strategy details'],
    unexpect: [
      '✓ ● strategy running',
      'agent: chat · model: harness-model',
      'entry-1 chat history line',
      'entry-4 chat history line',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-list-remembers-selection',
    frame: 'viewport',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, ESC, '\t'],
    expect: ['›   ● strategy running', 'Tab input', 'Esc input'],
    unexpect: ['signal read during notification phase', 'ERROR'],
  },
  {
    name: 'subagent-list-tiny-resize-releases-focus',
    frame: 'viewport',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['draft survives resize', '\t', DOWN],
    resizes: [{ cols: 44, rows: 5 }],
    keysAfterResize: [' and accepts input'],
    // The draft is windowed to the input's soft-break rows at narrow widths,
    // so the sentence may wrap — assert it collapsed rather than on one line.
    expect: ['Tab sessions'],
    expectCollapsed: ['draft survives resize and accepts input'],
    unexpect: ['Enter focus', 'signal read during notification phase', 'ERROR'],
  },
  {
    name: 'hidden-root-approval-tab-return',
    frame: 'scrollback',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_BASH_APPROVAL: '1',
      HARNESS_BASH_APPROVAL_AFTER_CHILD_FOCUS: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', '\t', UP, UP, UP, '\r'],
    expect: [
      'agent: chat · model: harness-model',
      'Run command?',
      '$ npm run compile:safe',
      'y approve',
      'Keys go to the panel above',
    ],
    unexpect: [
      'subagent: strategy · parent: main · model: harness-model',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-focused-bounded-live-tail',
    frame: 'scrollback',
    cols: 120,
    rows: 24,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_LONG_CHILD_OUTPUT: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r'],
    resizes: [{ cols: 120, rows: 14 }],
    expect: ['strategy detail line 15', 'strategy detail line 18'],
    unexpect: [
      'strategy detail line 01',
      'entry-1 chat history line',
      'entry-4 chat history line',
      'PgUp',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'focused-subagent-shows-owned-children',
    frame: 'viewport',
    cols: 120,
    rows: 18,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_NESTED_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', '\t'],
    expect: ['1 agent', 'localChecker running'],
    unexpect: [
      'leanSolver',
      'reviewer',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-transcript-reader-full-history',
    frame: 'viewport',
    cols: 120,
    rows: 30,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_LONG_CHILD_OUTPUT: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', DC4],
    expect: [
      'Transcript: strategy',
      'strategy detail line 01',
      'PgUp/PgDn page',
      'Esc close',
    ],
    unexpect: [
      'entry-1 chat history line',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-focused-status-stays-scoped',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', '/status', '\r'],
    frame: 'viewport',
    expect: ['strategy is checking the harness-child-strategy details'],
    expectPatterns: [RUNNING_STATUS_PATTERN],
    unexpect: [
      'agent: harness-agent',
      'entry-1 chat history line',
      'entry-4 chat history line',
      '✓ ● main running',
      'signal read during notification phase',
      'ERROR',
    ],
  },
  {
    name: 'subagent-transcript-reader-return-root',
    frame: 'viewport',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', DC4, ESC, '\t', UP, UP, UP, '\r'],
    expect: [
      'entry-1 chat history line',
      'entry-4 chat history line',
      '3 agents',
      'Tab sessions',
    ],
    maxOccurrences: [
      { text: 'entry-1 chat history line', max: 1 },
      { text: 'entry-4 chat history line', max: 1 },
    ],
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
    frame: 'viewport',
    expect: ['API keys'],
    expectPatterns: [/◆ [-|\/\\] running 1m/],
    unexpect: ['◆running', 'API keys3'],
  },
  {
    name: 'stopped-subagent-list',
    frame: 'scrollback',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, 'k'],
    expect: [
      'Harness kill requested for harness-child-strategy.',
      '›   ● strategy stopped',
      'Enter focus',
      'Tab input',
      'Esc input',
    ],
    unexpect: [
      'v full output',
      'k kill',
      'Harness kill requested for harness-child-strategy.\n\nHarness kill requested for harness-child-strategy.',
    ],
  },
  {
    name: 'focused-stopped-subagent',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, 'k', '\r'],
    frame: 'viewport',
    expect: ['◆ stopped', 'root active', 'Ctrl-C stop root', 'Esc back'],
    unexpect: [STOPPED_SUBAGENT_INPUT_MESSAGE_START],
    unexpectPatterns: [RUNNING_STATUS_PATTERN],
  },
  {
    name: 'focused-stopped-subagent-tab-focus',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, 'k', '\r', '\t', UP, '\r'],
    frame: 'viewport',
    expect: ['◆ idle', 'root active'],
    unexpect: [
      'Harness interrupt requested.',
      STOPPED_SUBAGENT_INPUT_MESSAGE_START,
      '› ✓ ● strategy stopped',
    ],
  },
  {
    name: 'focused-stopped-subagent-submit',
    cols: 120,
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [
      '\t',
      DOWN,
      DOWN,
      DOWN,
      'k',
      '\r',
      'can you still receive this?',
      '\r',
    ],
    frame: 'viewport',
    expect: ['◆ stopped', 'root active', 'Esc back'],
    unexpect: [
      STOPPED_SUBAGENT_INPUT_MESSAGE_START,
      STOPPED_SELECTED_BACKGROUND_TASK_MESSAGE,
      'Harness received: can you still receive this?',
      'can you still receive this?',
    ],
    unexpectPatterns: [RUNNING_STATUS_PATTERN],
  },
  {
    name: 'empty-task-shortcut-hidden',
    env: {
      HARNESS_ENTRIES: '4',
    },
    keys: [ESC + 'p'],
    frame: 'viewport',
    expect: ['entry-4 chat history line', '/status details', 'Ctrl-C exit'],
    unexpect: [
      'Option-p tasks',
      'Alt-p tasks',
      'Esc p tasks',
      'Tasks and sub-workflows',
      'No active tasks or sub-workflows.',
      'Enter view',
      'k kill',
      'navigate',
    ],
  },
  {
    name: 'todos',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    expect: [
      'Split theorem into algebraic and analytic checks',
      'Coordinate a small math proof through nested CLI work.',
    ],
    expectPatterns: [/\n\n ☑ Split theorem into algebraic and analytic checks/],
  },
  {
    name: 'completed-plan-visible-while-running',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_TODOS: '1',
      HARNESS_TODOS_COMPLETED: '1',
    },
    frame: 'viewport',
    expect: [
      'Split theorem into algebraic and analytic checks',
      'Coordinate a small math proof through nested CLI work.',
    ],
    expectPatterns: [RUNNING_STATUS_PATTERN],
  },
  {
    name: 'idle-todos-visible',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_TODOS: '1',
      HARNESS_TODOS_IDLE: '1',
    },
    frame: 'viewport',
    expect: [
      'idle',
      'Ctrl-C exit',
      'Waiting for leanSolver',
      'Coordinate a small math proof through nested CLI work.',
    ],
  },
  {
    name: 'work-plan-reader',
    rows: 18,
    cols: 72,
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    keys: ['/plan', '\r', PAGE_DOWN],
    frame: 'viewport',
    expect: [
      'Work plan:',
      'Todos',
      '[completed] Split theorem into algebraic and analytic checks',
      '[in progress] Ask leanSolver to verify the finite case',
      '[pending] Merge subagent conclusions into final answer',
      'PgUp/PgDn page',
      'Esc close',
    ],
    unexpect: ['Unknown command: /plan'],
    maxLineColumns: 72,
  },
  {
    name: 'work-plan-reader-narrow',
    rows: 14,
    cols: 24,
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    keys: [
      '/plan',
      '\r',
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
      PAGE_DOWN,
    ],
    frame: 'viewport',
    expect: ['Work plan', '[completed]', 'PgUp/PgDn page', 'Esc', 'close'],
    unexpect: ['Unknown command: /plan'],
    maxLineColumns: 24,
  },
  {
    name: 'work-plan-reader-escape',
    env: { HARNESS_ENTRIES: '4', HARNESS_TODOS: '1' },
    keys: ['/plan', '\r', ESC],
    frame: 'viewport',
    expect: [
      'Coordinate a small math proof through nested CLI work.',
      '/status details',
      'Ctrl-C exit',
    ],
    unexpect: ['Work plan:', 'Objective', '[in progress]'],
  },
  {
    name: 'escape-root-restores-prompt-history',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_TODOS: '1',
      HARNESS_INPUT_HISTORY: 'older stopped prompt||latest stopped prompt',
    },
    keys: [{ input: ESC, delayMs: 50 }, UP, UP, DOWN],
    frame: 'viewport',
    expect: [
      'Harness focused interrupt requested for harness-stream-1.',
      '◆ stopped API keys',
      'latest stopped prompt',
    ],
    unexpect: ['older stopped prompt', 'Choosing a session'],
  },
  {
    name: 'escape-stops-focused-main-only',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [{ input: ESC, delayMs: 700 }, '\t', DOWN],
    frame: 'viewport',
    expect: [
      'Harness focused interrupt requested for harness-stream-1.',
      '✓ ● main stopped',
      'strategy running',
      'leanSolver idle',
      'reviewer running',
      '3 agents',
      'Choosing a session',
    ],
    unexpect: ['Harness interrupt requested.'],
  },
  {
    name: 'escape-returns-focused-child-to-parent-list',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: ['\t', DOWN, DOWN, DOWN, '\r', { input: ESC, delayMs: 700 }, '\t'],
    frame: 'viewport',
    expect: [
      '› ✓ ● main running',
      'strategy running',
      'leanSolver idle',
      'reviewer running',
      '3 agents',
      'Choosing a session',
      'Ctrl-C stop',
    ],
    unexpect: [
      'Harness interrupt requested.',
      'Harness focused interrupt requested',
      'main stopped',
      'strategy stopped',
    ],
  },
  {
    name: 'escape-returns-focused-child-to-parent-input',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [
      '\t',
      DOWN,
      DOWN,
      DOWN,
      '\r',
      { input: ESC, delayMs: 700 },
      'root draft after child back',
    ],
    frame: 'viewport',
    expect: ['root draft after child back', '3 agents', 'Ctrl-C stop'],
    unexpect: [
      'Choosing a session',
      'Harness interrupt requested.',
      'Harness focused interrupt requested',
      'main stopped',
      'strategy stopped',
    ],
  },
  {
    name: 'escape-modal-owned',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
      HARNESS_BASH_APPROVAL: '1',
    },
    bootExpect: 'Run command?',
    keys: [{ input: ESC, delayMs: 700 }],
    frame: 'viewport',
    expect: ['3 agents', 'Tab sessions', 'Ctrl-C stop'],
    unexpect: [
      'Run command?',
      'Harness focused interrupt requested',
      'Harness interrupt requested.',
    ],
  },
  {
    name: 'escape-number-focus-chord',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [{ input: ESC, delayMs: 80 }, '2'],
    frame: 'viewport',
    expect: ['idle', 'root active', 'Tab sessions'],
    unexpect: [
      'Harness focused interrupt requested',
      'Harness interrupt requested.',
      '› ✓ ● main stopped',
    ],
  },
  {
    name: 'ctrl-c-exit',
    frame: 'scrollback',
    env: { HARNESS_ENTRIES: '4' },
    keys: [ETX],
    expectExit: true,
  },
  {
    name: 'ctrl-c-clears-draft',
    frame: 'viewport',
    env: { HARNESS_ENTRIES: '4' },
    keys: ['unfinished draft', ETX],
    expect: ['Ctrl-C exit'],
    unexpect: ['unfinished draft'],
  },
  {
    name: 'ctrl-c-interrupt-active',
    env: {
      HARNESS_ENTRIES: '4',
      HARNESS_CHILDREN: '1',
      HARNESS_CAN_INTERRUPT: '1',
    },
    bootExpect: 'Tab sessions',
    keys: [ETX],
    frame: 'viewport',
    expect: [
      'Harness interrupt requested.',
      '◆ stopped API keys',
      '3 agents',
      'Tab sessions',
      'Ctrl-C exit',
    ],
    unexpect: ['Ctrl-C stop'],
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

const PARSE_ARGS_DEF = {
  help: { type: 'boolean', alias: 'h' },
  list: { type: 'boolean' },
  listScenarios: { type: 'boolean' },
  listSelected: { type: 'boolean' },
  // citty's parser intercepts any `--no-X` token as negation of `X` before
  // the schema is even consulted, so a literal `noBuild: {type:'boolean'}`
  // can never observe `--no-build` (it lands on the nonexistent `build`
  // property instead). Modeling the positive form and negating it is the
  // only way citty's `--no-*` negation syntax can drive this flag.
  build: { type: 'boolean', default: true },
  skipIfMissingDeps: { type: 'boolean' },
  snapshotDir: { type: 'string' },
};
const KNOWN_FLAG_TOKENS = new Set([
  '--help',
  '-h',
  '--list',
  '--list-scenarios',
  '--list-selected',
  '--no-build',
  '--skip-if-missing-deps',
  '--snapshot-dir',
]);

function parseArgs(argv) {
  // pnpm forwards a leading separator to scripts (`pnpm run x -- --flag`).
  // Treat that package-manager separator as transparent when it precedes a
  // script option; a later `--` still marks end-of-options below.
  const rest =
    argv[0] === '--' && argv[1]?.startsWith('-') ? argv.slice(1) : argv;

  // citty's parser is intentionally lenient about unrecognized flags, so
  // reject them ourselves before handing off — a typo'd flag should fail
  // loudly, not silently fall through as a stray positional.
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') break; // end-of-options marker; rest are positionals
    if (token === '--snapshot-dir') {
      index += 1; // its value is free-form and may itself start with '-'
      continue;
    }
    const isKnownFlag =
      KNOWN_FLAG_TOKENS.has(token) || token.startsWith('--snapshot-dir=');
    if (token.startsWith('-') && !isKnownFlag) {
      console.error(`[validate-tui] unknown option: ${token}`);
      printUsage(console.error);
      process.exit(1);
    }
  }

  let args;
  try {
    args = parseCittyArgs(rest, PARSE_ARGS_DEF);
  } catch (error) {
    console.error(
      `[validate-tui] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.list || args.listScenarios) {
    printScenarioList();
    process.exit(0);
  }

  let snapshotDir;
  if (args.snapshotDir !== undefined) {
    if (!args.snapshotDir) {
      console.error('[validate-tui] --snapshot-dir requires a directory');
      process.exit(1);
    }
    snapshotDir = path.resolve(process.cwd(), args.snapshotDir);
  }

  const scenarios = args._.filter((token) => token !== '--');

  return {
    scenarios,
    snapshotDir,
    listSelected: Boolean(args.listSelected),
    noBuild: args.build === false,
    skipIfMissingDeps: Boolean(args.skipIfMissingDeps),
  };
}

function frameOracleGraphFailure(allScenarios, byName) {
  const complete = new Set();
  const active = new Set();
  const path = [];

  const visit = (scenario) => {
    if (complete.has(scenario.name)) return undefined;
    if (active.has(scenario.name)) {
      const cycleStart = path.indexOf(scenario.name);
      const cycle = [...path.slice(cycleStart), scenario.name];
      return `cyclic frame oracle: ${cycle.join(' -> ')}`;
    }

    active.add(scenario.name);
    path.push(scenario.name);
    const oracleName = scenario.equivalentFrameTo;
    if (oracleName) {
      const oracle = byName.get(oracleName);
      if (!oracle) {
        return `${scenario.name} names an unknown frame oracle: ${oracleName}`;
      }
      const failure = visit(oracle);
      if (failure) return failure;
    }
    path.pop();
    active.delete(scenario.name);
    complete.add(scenario.name);
    return undefined;
  };

  for (const scenario of allScenarios) {
    const failure = visit(scenario);
    if (failure) return failure;
  }
  return undefined;
}

function selectedScenariosWithFrameOracles(names, byName) {
  const selected = [];
  const available = new Set();

  const addOracle = (name) => {
    if (available.has(name)) return;
    const scenario = byName.get(name);
    if (scenario.equivalentFrameTo) addOracle(scenario.equivalentFrameTo);
    selected.push(scenario);
    available.add(name);
  };

  for (const name of names) {
    const scenario = byName.get(name);
    if (scenario.equivalentFrameTo) addOracle(scenario.equivalentFrameTo);
    // Explicit arguments retain their order and multiplicity. An oracle added
    // as a prerequisite is inserted at most once.
    selected.push(scenario);
    available.add(name);
  }
  return selected;
}

const scenarioByName = new Map(
  SCENARIOS.map((scenario) => [scenario.name, scenario]),
);
const oracleGraphFailure = frameOracleGraphFailure(SCENARIOS, scenarioByName);
if (oracleGraphFailure) {
  console.error(`[validate-tui] ${oracleGraphFailure}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const only = args.scenarios;
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
  ? selectedScenariosWithFrameOracles(only, scenarioByName)
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
const FRAME_MODE_VIEWPORT = 'viewport';
const FRAME_MODE_SCROLLBACK = 'scrollback';
const DEFAULT_FRAME_MODE = FRAME_MODE_VIEWPORT;
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

// Render the whole buffer once; scenarioFrame() then selects the visible
// viewport or the historical scrollback for the scenario's assertion target.
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
  const frameMode = scenario.frame ?? DEFAULT_FRAME_MODE;
  if (frameMode === FRAME_MODE_VIEWPORT) return frameTail(fullFrame, rows);
  if (frameMode === FRAME_MODE_SCROLLBACK) return fullFrame;
  throw new Error(
    `unknown validate-tui frame mode for ${scenario.name}: ${frameMode}`,
  );
}

function exactFrameDifference(actualFrame, expectedFrame, oracleName) {
  const actual = Buffer.from(actualFrame, 'utf8');
  const expected = Buffer.from(expectedFrame, 'utf8');
  if (actual.equals(expected)) return undefined;

  const sharedLength = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < sharedLength && actual[offset] === expected[offset]) {
    offset += 1;
  }
  const byteAt = (bytes) =>
    offset < bytes.length
      ? `0x${bytes[offset].toString(16).padStart(2, '0')}`
      : 'end-of-frame';
  return `rendered frame is not byte-identical to ${oracleName}: first UTF-8 byte difference at ${offset} (${byteAt(actual)} != ${byteAt(expected)}; ${actual.length} != ${expected.length} bytes)`;
}

function expectedFrameTextVisible(scenario, frame) {
  const collapsedFrame = collapseFrameText(frame);
  const expectTexts = scenario.expect ?? [];
  const expectPatterns = scenario.expectPatterns ?? [];
  const expectCollapsed = scenario.expectCollapsed ?? [];
  return (
    expectTexts.every((text) => frame.includes(text)) &&
    expectPatterns.every((pattern) => pattern.test(frame)) &&
    expectCollapsed.every((text) => collapsedFrame.includes(text))
  );
}

function collapseFrameText(frame) {
  return frame.replaceAll(/[│╭╮╰╯─]/g, ' ').replaceAll(/\s+/g, ' ');
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

function orderedTextFailure(frame, check) {
  const afterIndex = frame.indexOf(check.after);
  if (afterIndex < 0)
    return `order marker missing: ${JSON.stringify(check.after)}`;
  const beforeIndex = frame.lastIndexOf(check.before, afterIndex);
  if (beforeIndex < 0)
    return `${JSON.stringify(check.before)} should appear before ${JSON.stringify(check.after)}`;
  if (beforeIndex < afterIndex) return undefined;
  return `${JSON.stringify(check.before)} should appear before ${JSON.stringify(check.after)}`;
}

const SNAPSHOT_WORKSPACES_DIR = 'workspaces';

function snapshotScenarioSlug(index, name) {
  const prefix = String(index + 1).padStart(2, '0');
  return `${prefix}-${name.replace(/[^a-z0-9._-]+/gi, '-')}`;
}

function snapshotFileName(index, name, extension = 'txt') {
  return `${snapshotScenarioSlug(index, name)}.${extension}`;
}

function snapshotWorkspaceDir(index, name) {
  if (!snapshotDir) return undefined;
  return path.join(
    snapshotDir,
    SNAPSHOT_WORKSPACES_DIR,
    snapshotScenarioSlug(index, name),
  );
}

function resetSnapshotDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === SNAPSHOT_WORKSPACES_DIR) {
      rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      continue;
    }
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
  passedText: '#356f4f',
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

function writeSnapshot(index, name, frame) {
  if (!snapshotDir) return;
  const textFile = path.join(snapshotDir, snapshotFileName(index, name));
  const svgFile = path.join(snapshotDir, snapshotFileName(index, name, 'svg'));
  writeFileSync(textFile, `${frame}${frame.endsWith('\n') ? '' : '\n'}`);
  writeFileSync(svgFile, snapshotSvgDocument(name, frame));
}

function snapshotStatus(result) {
  if (result.skipped) return 'skipped';
  return result.ok ? 'passed' : 'failed';
}

function snapshotHtmlDocument(results) {
  const generatedAt = new Date().toISOString();
  const summary = results.reduce(
    (counts, result) => {
      counts[snapshotStatus(result)] += 1;
      return counts;
    },
    { passed: 0, failed: 0, skipped: 0 },
  );
  const summaryText = [
    `${summary.passed} passed`,
    `${summary.failed} failed`,
    `${summary.skipped} skipped`,
  ].join(' · ');
  const entries = results
    .map((result, index) => {
      const textFile = snapshotFileName(index, result.name);
      const svgFile = snapshotFileName(index, result.name, 'svg');
      const frame = result.frame;
      const status = snapshotStatus(result);
      const failures = result.failures.length
        ? `<ul>${result.failures
            .map((failure) => `<li>${escapeHtml(failure)}</li>`)
            .join('')}</ul>`
        : '';
      return `<section class="scenario ${status}">
  <header>
    <h2>${escapeHtml(result.name)}</h2>
    <span class="status ${status}">${escapeHtml(status)}</span>
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
    .summary {
      display: flex;
      gap: 12px;
      margin: 0 0 24px;
    }
    .scenario {
      border: 1px solid ${SNAPSHOT_THEME.border};
      border-radius: 8px;
      margin: 0 0 24px;
      overflow: hidden;
      background: ${SNAPSHOT_THEME.cardBackground};
    }
    .scenario.failed { border-color: ${SNAPSHOT_THEME.failedBorder}; }
    .scenario.skipped { border-color: ${SNAPSHOT_THEME.muted}; }
    header {
      align-items: center;
      border-bottom: 1px solid ${SNAPSHOT_THEME.headerBorder};
      display: flex;
      gap: 12px;
      padding: 10px 14px;
    }
    h2 { font-size: 14px; margin: 0; }
    .status {
      border: 1px solid ${SNAPSHOT_THEME.border};
      border-radius: 999px;
      color: ${SNAPSHOT_THEME.muted};
      font-size: 12px;
      padding: 2px 8px;
      text-transform: uppercase;
    }
    .status.failed {
      border-color: ${SNAPSHOT_THEME.failedBorder};
      color: ${SNAPSHOT_THEME.failureText};
    }
    .status.passed { color: ${SNAPSHOT_THEME.passedText}; }
    .status.skipped { color: ${SNAPSHOT_THEME.muted}; }
    nav { display: flex; gap: 14px; margin-left: auto; }
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
    <p class="summary" aria-label="Snapshot summary">${escapeHtml(summaryText)}</p>
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

function createSkipResult(scenario, reason) {
  return {
    name: scenario.name,
    ok: true,
    skipped: true,
    skipReason: reason,
    failures: [],
    frame: reason,
    rows: scenarioRows(scenario),
  };
}

async function runScenario(scenario, index) {
  if (scenario.platforms && !scenario.platforms.includes(process.platform)) {
    return createSkipResult(
      scenario,
      `scenario is only supported on ${scenario.platforms.join(', ')}`,
    );
  }

  const fakeClipboard = scenario.fakeClipboard ? makeFakeClipboard() : null;
  if (scenario.fakeClipboard && !fakeClipboard) {
    return createSkipResult(
      scenario,
      `fake clipboard is not supported on ${process.platform}`,
    );
  }
  try {
    return await runScenarioWithResources(scenario, fakeClipboard, index);
  } finally {
    cleanupFakeClipboard(fakeClipboard);
  }
}

function cleanupFakeClipboard(fakeClipboard) {
  if (!fakeClipboard) return;
  rmSync(fakeClipboard.dir, { recursive: true, force: true });
}

function scenarioChildEnv(scenario, cols, rows) {
  const inheritedEnv = { ...process.env };
  // TUI scenarios should declare provider keys explicitly instead of inheriting
  // a developer or CI runner shell.
  for (const key of Object.keys(inheritedEnv)) {
    if (key.endsWith('_API_KEY')) delete inheritedEnv[key];
  }
  return {
    ...inheritedEnv,
    ...scenario.env,
    TERM: 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
  };
}

function gatherAssertionFailures({
  scenario,
  frame,
  rawOutput,
  fakeClipboard,
  checkpointFailures,
  booted,
  exited,
  exitedCleanly,
}) {
  const collapsedFrame = collapseFrameText(frame);
  const missing = (scenario.expect ?? []).filter((t) => !frame.includes(t));
  const missingCollapsed = (scenario.expectCollapsed ?? []).filter(
    (t) => !collapsedFrame.includes(t),
  );
  const missingPatterns = (scenario.expectPatterns ?? []).filter(
    (pattern) => !pattern.test(frame),
  );
  const present = (scenario.unexpect ?? []).filter((t) => frame.includes(t));
  const presentPatterns = (scenario.unexpectPatterns ?? []).filter((pattern) =>
    pattern.test(frame),
  );
  const failures = [...checkpointFailures];

  if (!booted) failures.push('input prompt never rendered (boot timeout)');
  for (const t of missing)
    failures.push(`expected text missing: ${JSON.stringify(t)}`);
  for (const t of missingCollapsed)
    failures.push(`expected collapsed text missing: ${JSON.stringify(t)}`);
  for (const pattern of missingPatterns)
    failures.push(`expected pattern missing: ${pattern.toString()}`);
  for (const t of present)
    failures.push(`unexpected text present: ${JSON.stringify(t)}`);
  for (const pattern of presentPatterns)
    failures.push(`unexpected pattern present: ${pattern.toString()}`);
  for (const check of scenario.maxOccurrences ?? []) {
    const actual = countOccurrences(frame, check.text);
    if (actual > check.max) {
      failures.push(
        `text appears too many times: ${JSON.stringify(check.text)} (${actual} > ${check.max})`,
      );
    }
  }
  for (const check of scenario.ordered ?? []) {
    const failure = orderedTextFailure(frame, check);
    if (failure) failures.push(failure);
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

  return failures;
}

async function runScenarioWithResources(scenario, fakeClipboard, index) {
  const term = makeTerm(scenario);
  const cols = scenarioCols(scenario);
  const rows = scenarioRows(scenario);
  let lastData = Date.now();
  let exited = null;
  let rawOutput = '';
  const childEventFrames = new Map();
  const writeQueue = new PQueue({ concurrency: 1 });
  if (scenario.env?.HARNESS_CHILD_EVENT_ORDER) {
    term.parser.registerOscHandler(CHILD_EVENT_ORDER_MARKER_OSC, (data) => {
      if (!data.startsWith(CHILD_EVENT_ORDER_MARKER_PREFIX)) return false;
      const label = data.slice(CHILD_EVENT_ORDER_MARKER_PREFIX.length);
      childEventFrames.set(label, renderFrame(term));
      return true;
    });
  }
  const frameSnapshot = async () => {
    await writeQueue.onIdle();
    return renderFrame(term);
  };
  const childEnv = scenarioChildEnv(scenario, cols, rows);
  const workspaceDir = snapshotWorkspaceDir(index, scenario.name);
  if (workspaceDir && childEnv.HARNESS_CWD == null) {
    mkdirSync(workspaceDir, { recursive: true });
    childEnv.HARNESS_CWD = workspaceDir;
  }
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
    writeQueue.add(() => new Promise((resolve) => term.write(d, resolve)));
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

  // The harness writes one marker only after each event's Ink render has
  // flushed. The xterm OSC handler snapshots its buffer at the marker's exact
  // position in the PTY byte stream, so checkpoint identity comes from fixture
  // progression, not from a second wall-clock schedule in this process.
  const checkpointFailures = [];
  const waitForChildEventFrame = async (label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let checkpointFrame = childEventFrames.get(label);
    while (checkpointFrame === undefined && Date.now() < deadline) {
      if (exited) break;
      await sleep(40);
      await frameSnapshot();
      checkpointFrame = childEventFrames.get(label);
    }
    return checkpointFrame;
  };
  if ((scenario.checkpoints?.length ?? 0) > 0) {
    const mountedFrame = await waitForChildEventFrame(
      'mounted',
      Number(scenario.checkpointMs ?? 4000),
    );
    if (mountedFrame === undefined) {
      checkpointFailures.push('fixture mount render marker missing');
    }
  }
  for (const [checkpointIndex, checkpoint] of (
    scenario.checkpoints ?? []
  ).entries()) {
    const fullCheckpointFrame = await waitForChildEventFrame(
      `step-${checkpointIndex + 1}`,
      Number(checkpoint.timeoutMs ?? scenario.checkpointMs ?? 4000),
    );
    if (fullCheckpointFrame === undefined) {
      checkpointFailures.push(
        `checkpoint ${checkpointIndex + 1}: fixture render marker missing`,
      );
      continue;
    }
    const checkpointFrame = scenarioFrame(scenario, fullCheckpointFrame, rows);
    for (const t of checkpoint.expect ?? []) {
      if (!checkpointFrame.includes(t)) {
        checkpointFailures.push(
          `checkpoint ${checkpointIndex + 1}: expected text missing: ${JSON.stringify(t)}`,
        );
      }
    }
    for (const t of checkpoint.unexpect ?? []) {
      if (checkpointFrame.includes(t)) {
        checkpointFailures.push(
          `checkpoint ${checkpointIndex + 1}: unexpected text present: ${JSON.stringify(t)}`,
        );
      }
    }
  }

  for (const key of scenario.keys ?? []) {
    const input = typeof key === 'string' ? key : key.input;
    child.write(input);
    await sleep(Number(key.delayMs ?? scenario.keyDelayMs ?? 500));
  }
  for (const resize of scenario.resizes ?? []) {
    child.resize(Number(resize.cols ?? cols), Number(resize.rows ?? rows));
    term.resize(Number(resize.cols ?? cols), Number(resize.rows ?? rows));
    await sleep(Number(resize.delayMs ?? 500));
  }
  for (const key of scenario.keysAfterResize ?? []) {
    const input = typeof key === 'string' ? key : key.input;
    child.write(input);
    await sleep(Number(key.delayMs ?? scenario.keyDelayMs ?? 500));
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

  const failures = gatherAssertionFailures({
    scenario,
    frame,
    rawOutput,
    fakeClipboard,
    checkpointFailures,
    booted,
    exited,
    exitedCleanly,
  });

  return {
    name: scenario.name,
    ok: failures.length === 0,
    skipped: false,
    failures,
    frame,
    rows,
  };
}

if (snapshotDir) resetSnapshotDir(snapshotDir);

let failed = 0;
let skipped = 0;
const results = [];
for (const [index, scenario] of scenarios.entries()) {
  // eslint-disable-next-line no-await-in-loop
  const result = await runScenario(scenario, index);
  if (!result.skipped && scenario.equivalentFrameTo) {
    const oracle = results.find(
      (candidate) => candidate.name === scenario.equivalentFrameTo,
    );
    if (!oracle || oracle.skipped) {
      result.failures.push(
        `byte-equivalence oracle unavailable: ${scenario.equivalentFrameTo}`,
      );
    } else {
      const difference = exactFrameDifference(
        result.frame,
        oracle.frame,
        oracle.name,
      );
      if (difference) result.failures.push(difference);
    }
    result.ok = result.failures.length === 0;
  }
  results.push(result);
  writeSnapshot(index, result.name, result.frame);
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
