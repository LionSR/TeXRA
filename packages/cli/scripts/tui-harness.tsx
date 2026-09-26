// Test harness: seed the session fold with synthetic runs and rows, render
// <App /> to the real terminal. Every fixture is published through the
// runtime session (`SessionHandle.publish`, the transcript store, the
// interaction port), so the TUI under test renders the same `SessionView` a
// live chat does. Used to verify the TUI without API access. Exits on Ctrl-C.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { render } from 'ink';
import { Effect, Fiber, SubscriptionRef } from 'effect';
import { nanoid } from 'nanoid';
import React from 'react';

import { loadAgents } from '@agent/index';
import { tryDefaultSession } from '@agent/runtime';
import { TraceEmitter } from '@agent/trace';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { apiKeySecretName } from '@model/apiProviders';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  AgentConfigFieldsSchema,
  emptyRunEndOutput,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  RUN_PHASE,
  TODO_STATUS,
  TOOL_CALL_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  RunIdSchema,
  type LogLevel,
  type MessageType,
  type NormalizedToolUse,
  type PermissionPayload,
  type PlanApprovalPermission,
  type RequestDecision,
  type RetryPermission,
  type RunOutcome,
  type RunPhase,
  type RunId,
  type SessionEventDraft,
  type UserQuestionPermission,
} from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/runs/runStatus';
import { acceptsFollowUp, descendantRuns } from '@shared/session/sessionView';
import {
  buildScenario,
  foldAll,
  local,
  OWNER,
  OTHER_OWNER,
  PROCESS,
  tail,
} from '@test/shared/session/fanOutScenario';
import { clearGoal, setGoalSessionAutoApproval, startGoal } from '@tools/goal';
import { prepareToolEditApprovalPrompt } from '@tools/approval/toolEditApproval';
import { FOCUSED_BACKGROUND_TASK } from '@ui/copy/nestedRuns';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { App } from '../src/chat/tui/App';
import { registerBuiltinSlashCommands } from '../src/chat/tui/commands/registerBuiltins';
import { showCliWorkPlan } from '../src/chat/tui/commands/handlers/sessionCommands';
import { formatSlashCommandHelp } from '../src/chat/tui/commands/helpText';
import {
  findSlashCommand,
  listSlashCommands,
  parseSlashInput,
  suggestSlashCommand,
} from '../src/chat/tui/commands/slashRegistry';
import {
  openCliSlashCommandForm,
  openRegisteredCliSlashForm,
} from '../src/chat/tui/commands/slashForms';
import {
  focusRun,
  rootRunId,
  resetCliState,
  selectedRunId,
  sessionMeta,
  setCliSessionModelOverride,
} from '../src/chat/tui/state/cliState';
import {
  bindSessionView,
  currentView,
  CLI_FOLLOW_UP_HOST,
  runningChildCount,
  sessionView,
  runViewOf,
} from '../src/chat/tui/state/sessionView';
import {
  chatTuiCanStartRootRun,
  TuiSession,
} from '../src/chat/tui/state/sessionRunState';
import { formatCliSessionStatus } from '../src/chat/tui/sessionStatus';
import { createTuiViewportController } from '../src/chat/tui/render/tuiViewportController';
import { notifyStaticTranscriptErased } from '../src/chat/tui/state/staticTranscriptRepaint';
import {
  announceForegroundApprovals,
  createTuiHostInteractions,
} from '../src/chat/tui/state/subscribeApprovals';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
} from '../src/chat/tui/state/transcript';
import { clearTerminalScrollback } from '../src/tui/terminalCleanup';
import { defaultShortcutModifierLabel } from '../src/runtime/shortcutLabels';
import { updateCliModelAccess } from '../src/runtime/modelAccessSelection';
import { installCliProcessRuntime } from '../src/runtime/cliProcessRuntime';
import { initCliPlatform } from '../src/runtime/initPlatform';
import { resolveCliResourcesPath } from '../src/runtime/resourcesPath';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '../src/runtime/cliPresentationHost';
import { setCliToolEnabled } from '../src/runtime/tools';
import type { CliContext } from '../src/runtime/cliContext';
import type { InputHistory } from '../src/chat/tui/history/inputHistory';

const HARNESS_RUN_ID = RunIdSchema.parse('aaaa0001f10e');
const HARNESS_MODEL = 'harness-model';
const RUNNING_WORKFLOW_FIRST_AGENT_RUN_ID = RunIdSchema.parse('aaaa000af10e');
const SHOW_WORKFLOW_RUNNING = process.env.HARNESS_WORKFLOW_RUNNING === '1';
const SHOW_PROCESS_CHILD = process.env.HARNESS_PROCESS_CHILD === '1';
const RESET_WORKFLOW_SCRIPT_DISABLED =
  process.env.HARNESS_WORKFLOW_SCRIPT_DISABLED === '1';
const HARNESS_APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
const ENTRY_COUNT = Number(process.env.HARNESS_ENTRIES ?? '15');
const SHOW_EDIT_APPROVAL = process.env.HARNESS_EDIT_APPROVAL === '1';
const EDIT_APPROVAL_WRAPPED_CONTEXT =
  process.env.HARNESS_EDIT_APPROVAL_WRAPPED_CONTEXT === '1';
const SHOW_BASH_APPROVAL = process.env.HARNESS_BASH_APPROVAL === '1';
const SHOW_REPEATED_BASH_APPROVAL =
  process.env.HARNESS_REPEATED_BASH_APPROVAL === '1';
const SHOW_RETRY_APPROVAL = process.env.HARNESS_RETRY_APPROVAL === '1';
const RETRY_APPROVAL_CHATGPT =
  process.env.HARNESS_RETRY_APPROVAL_CHATGPT === '1';
const SHOW_USER_QUESTION = process.env.HARNESS_USER_QUESTION === '1';
const SHOW_PLAN_APPROVAL = process.env.HARNESS_PLAN_APPROVAL === '1';
const SHOW_AGENT_PROPOSAL = process.env.HARNESS_AGENT_PROPOSAL === '1';
const PLAN_APPROVAL_GOAL = process.env.HARNESS_PLAN_APPROVAL_GOAL === '1';
const PLAN_APPROVAL_OBJECTIVE =
  process.env.HARNESS_PLAN_APPROVAL_OBJECTIVE ??
  [
    'Coordinate a short math proof through CLI chat.',
    'Split the finite and symbolic cases.',
    'Ask a checker to verify the enumeration before writing the final answer.',
  ].join('\n');
const SHOW_SUBAGENT_FOLLOWUPS = process.env.HARNESS_SUBAGENT_FOLLOWUPS === '1';
const SHOW_LONG_TOOL_OUTPUT = process.env.HARNESS_LONG_TOOL_OUTPUT === '1';
const SHOW_TERMINAL_RESUME_REPAINT =
  process.env.HARNESS_TERMINAL_RESUME_REPAINT === '1';
const SHOW_ASSISTANT_TOOL_PREAMBLE =
  process.env.HARNESS_ASSISTANT_TOOL_PREAMBLE === '1';
const SHOW_LIVE_TOOL_ONLY = process.env.HARNESS_LIVE_TOOL_ONLY === '1';
const SHOW_STREAMING_TOOL_OUTPUT =
  process.env.HARNESS_STREAMING_TOOL_OUTPUT === '1';
const LIVE_TOOL_COUNT = Math.max(
  1,
  Number.parseInt(process.env.HARNESS_LIVE_TOOL_COUNT ?? '1', 10) || 1,
);
const SHOW_LIVE_INVISIBLE_ASSISTANT =
  process.env.HARNESS_LIVE_INVISIBLE_ASSISTANT === '1';
const SHOW_PROJECT_SKILL = process.env.HARNESS_PROJECT_SKILL === '1';
const WIDE_TRANSCRIPT_SUFFIX =
  ' hidden-middle wide-column-A wide-column-B wide-column-C wide-column-D wide-column-E wide-column-F';
const SHOW_REJECTED_BASH_TOOL = process.env.HARNESS_REJECTED_BASH_TOOL === '1';
const SHOW_LONG_CHILD_OUTPUT = process.env.HARNESS_LONG_CHILD_OUTPUT === '1';
const BASH_APPROVAL_COMMAND =
  process.env.HARNESS_BASH_APPROVAL_COMMAND ?? 'npm run compile:safe';
const SHOW_BASH_APPROVAL_AFTER_CHILD_FOCUS =
  process.env.HARNESS_BASH_APPROVAL_AFTER_CHILD_FOCUS === '1';
const USER_QUESTION_CONTEXT = [
  'The agent is asking for direction before continuing a math workflow.',
  'We need a choice that keeps the proof useful while avoiding a long detour.',
  'Context detail: the candidate proof has a finite enumeration, a symbolic recurrence, and one unresolved edge case around degenerate triples.',
  'Please answer the questions below so the agent can continue without guessing.',
].join('\n');
const AGENT_PROPOSAL_INSTRUCTION = [
  'Review the mathematical proof in triangular_square_mod5.tex for correctness, completeness, and rigor.',
  '',
  '1. Check the reduction to the Pell equation and every hidden parity assumption.',
  '2. Verify that the recurrence generates every positive solution below the bound.',
  '3. Recompute every square triangular number and the mod 5 filter.',
  '4. Inspect edge cases such as n=0, negative x, and duplicate Pell representatives.',
  '5. Write a structured report with any gaps or a confirmation of correctness.',
  '6. Include a short independent enumeration so the orchestrator can compare results.',
].join('\n');
const CAN_SELECT_MODEL = process.env.HARNESS_CAN_SELECT_MODEL === '1';
const DISABLED_MODEL_SWITCHES = new Set(
  parseList(process.env.HARNESS_DISABLED_MODEL_SWITCHES),
);
const DISABLED_MODEL_SWITCH_REASON =
  'different conversation format; start new chat';
const SHOW_CHILDREN = process.env.HARNESS_CHILDREN === '1';
const SHOW_NESTED_CHILDREN = process.env.HARNESS_NESTED_CHILDREN === '1';
const SHOW_TODOS = process.env.HARNESS_TODOS === '1';
const SHOW_IDLE_TODOS = process.env.HARNESS_TODOS_IDLE === '1';
const SHOW_COMPLETED_TODOS_ONLY = process.env.HARNESS_TODOS_COMPLETED === '1';
const FAILED_CHILD_AGENT = process.env.HARNESS_FAILED_CHILD?.trim();
const TEAM_NAME = process.env.HARNESS_TEAM_NAME?.trim() || undefined;
let canInterrupt = process.env.HARNESS_CAN_INTERRUPT === '1';
const QUEUED_FOLLOW_UPS = parseList(process.env.HARNESS_QUEUED_FOLLOWUPS);
const HARNESS_CWD_INPUT = process.env.HARNESS_CWD?.trim();
// Keep platform state writes out of the repository unless a scenario opts in.
const HARNESS_CWD =
  HARNESS_CWD_INPUT || mkdtempSync(path.join(tmpdir(), 'texra-tui-harness-'));
const HARNESS_STORAGE_ROOT = path.join(HARNESS_CWD, '.texra-storage');
const HARNESS_COLOR_ENABLED = process.env.HARNESS_COLOR_ENABLED !== '0';
const HARNESS_RESOURCES_PATH = await Effect.runPromise(
  resolveCliResourcesPath().pipe(Effect.provide(nodeFileServices)),
);
const HARNESS_CLI_CONTEXT: CliContext = {
  storageRoot: HARNESS_STORAGE_ROOT,
  approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
  config: new MemoryConfigProvider(),
  commandName: 'texra',
  configWarnings: [],
  configDegradations: [],
  cwd: HARNESS_CWD,
  mode: 'interactive',
  outputFormat: 'text',
  quietLogs: true,
  minimumLogLevel: 'None',
  resourcesPath: HARNESS_RESOURCES_PATH,
  skillSourceOptions: {},
  stderrColorEnabled: HARNESS_COLOR_ENABLED,
  stderrIsTty: true,
  stdoutColorEnabled: HARNESS_COLOR_ENABLED,
  stdoutIsTty: true,
  termIsDumb: false,
  version: '0.0.0-harness',
};
const HARNESS_STDOUT = tuiOutputStreamForColor(
  process.stdout,
  HARNESS_COLOR_ENABLED,
);
if (!HARNESS_CWD_INPUT) {
  process.once('exit', () => {
    rmSync(HARNESS_CWD, { recursive: true, force: true });
  });
}
function seedHarnessProjectSkill(): void {
  const skillDir = path.join(HARNESS_CWD, '.texra', 'skills', 'proof-audit');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: proof-audit',
      'description: Review mathematical proof steps.',
      '---',
      '',
      'Use this skill when checking proof structure, assumptions, and gaps.',
      '',
    ].join('\n'),
  );
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('||')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const HARNESS_VISIBLE_TOOL_USE_AGENTS = parseList(
  process.env.HARNESS_VISIBLE_TOOL_USE_AGENTS,
);
const HARNESS_VISIBLE_WORKFLOW_AGENTS = parseList(
  process.env.HARNESS_VISIBLE_WORKFLOW_AGENTS,
);
const HARNESS_VISIBLE_MODELS = parseList(process.env.HARNESS_VISIBLE_MODELS);
const HARNESS_MEMORY_FILES = parseList(process.env.HARNESS_MEMORY_FILES);
const HARNESS_INPUT_HISTORY_ENTRIES = parseList(
  process.env.HARNESS_INPUT_HISTORY,
);
const HARNESS_INPUT_HISTORY: InputHistory | undefined =
  HARNESS_INPUT_HISTORY_ENTRIES.length === 0
    ? undefined
    : {
        push(line) {
          return Effect.sync(() => {
            HARNESS_INPUT_HISTORY_ENTRIES.push(line);
          });
        },
        reverseFind: () => undefined,
        at: (index) => HARNESS_INPUT_HISTORY_ENTRIES[index],
        length: () => HARNESS_INPUT_HISTORY_ENTRIES.length,
      };

if (SHOW_PROJECT_SKILL) {
  seedHarnessProjectSkill();
}

const HARNESS_PLATFORM_SERVICES = await (
  await installCliProcessRuntime(HARNESS_STORAGE_ROOT, {
    minimumLogLevel: HARNESS_CLI_CONTEXT.minimumLogLevel,
  })
).runPromise(
  initCliPlatform({
    // The same provider the harness context resolves its rows through,
    // exactly as startup hands `buildCliContext`'s provider to the real init.
    config: HARNESS_CLI_CONTEXT.config,
    cwd: HARNESS_CWD,
    installSignalHandlers: false,
    quietLogs: true,
    minimumLogLevel: HARNESS_CLI_CONTEXT.minimumLogLevel,
    resourcesPath: HARNESS_RESOURCES_PATH,
    storageRoot: HARNESS_STORAGE_ROOT,
    skillSourceOptions: {},
    version: '0.0.0-harness',
  }),
);
if (RESET_WORKFLOW_SCRIPT_DISABLED) {
  await HARNESS_PLATFORM_SERVICES.runtime.runPromise(
    setCliToolEnabled(
      HARNESS_PLATFORM_SERVICES.globalState,
      'workflow-script',
      false,
    ),
  );
}
// The one process runtime this harness runs on, as its composition root
// handed it back: the harness holds it in a local like every other entry.
const harnessRuntime = HARNESS_PLATFORM_SERVICES.runtime;
// The roots that same init installed, held as data like every other entry.
const harnessRoots = HARNESS_PLATFORM_SERVICES.roots;
if (!harnessRoots) {
  throw new Error(
    'The TUI harness platform init installed no workspace roots.',
  );
}
// Seed workspace-storage memory files so `/memory` has rows to list. Files
// get descending mtimes in list order, so the first name is the newest row
// and the listing order is deterministic.
if (HARNESS_MEMORY_FILES.length > 0) {
  const memoryRoot = path.join(
    harnessRoots.storage,
    WORKSPACE_STORAGE_LAYOUT.memory,
  );
  const newestEpochSeconds = Date.now() / 1000;
  HARNESS_MEMORY_FILES.forEach((name, index) => {
    const filePath = path.join(memoryRoot, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `Harness memory ${name}.\n`);
    const mtime = newestEpochSeconds - index * 60;
    utimesSync(filePath, mtime, mtime);
  });
}
// The persistent session `initCliPlatform` opened over the harness roots.
const harnessRuntimeSession = await harnessRuntime.runPromise(
  HARNESS_PLATFORM_SERVICES.session,
);
harnessRuntimeSession.setApprovalPolicy(TEXRA_APPROVAL_POLICY_DEFAULT);
if (
  process.env.HARNESS_VISIBLE_TOOL_USE_AGENTS !== undefined ||
  process.env.HARNESS_VISIBLE_WORKFLOW_AGENTS !== undefined
) {
  await harnessRuntime.runPromise(
    harnessRoots.workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      {
        kind: 'custom',
        agentKeys: {
          workflow:
            process.env.HARNESS_VISIBLE_WORKFLOW_AGENTS !== undefined
              ? HARNESS_VISIBLE_WORKFLOW_AGENTS
              : 'all',
          toolUse:
            process.env.HARNESS_VISIBLE_TOOL_USE_AGENTS !== undefined
              ? HARNESS_VISIBLE_TOOL_USE_AGENTS
              : 'all',
        },
      },
    ),
  );
}
if (process.env.HARNESS_VISIBLE_MODELS !== undefined) {
  await harnessRuntime.runPromise(
    harnessRoots.globalState.update(GlobalStateKey.MODEL_SELECTION, {
      enabledExtras: HARNESS_VISIBLE_MODELS,
      disabledDefaults: DEFAULT_MODELS.filter(
        (model) => !HARNESS_VISIBLE_MODELS.includes(model),
      ),
    }),
  );
}
await harnessRuntime.runPromise(loadAgents({ includeRemote: false }));

// =========================================================================
// Fold seeding: every fixture is a session fact
// =========================================================================

const HARNESS_DISPOSERS: Array<() => void> = [];

/** The session every fixture publishes into and the TUI renders. */
function session() {
  const installed = tryDefaultSession();
  if (!installed) {
    throw new Error('tui-harness: the default session is not initialized.');
  }
  return installed;
}

function publish(...drafts: SessionEventDraft[]): void {
  session().publish(drafts);
}

// The TUI reads the session fold (PRD 10.1): bind it and subscribe every
// run's transcript tier the way `runChat` does.
HARNESS_DISPOSERS.push(bindSessionView(harnessRuntime, session().view));
{
  let subscribed = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = [...currentView().runs.keys()];
    const key = ids.join('\0');
    if (key === subscribed) return;
    subscribed = key;
    harnessRuntime.runFork(
      session().setTranscriptSubscriptions(
        'tui-harness',
        ids.map((id) => ({ id, fromSeq: 0 })),
      ),
    );
  };
  HARNESS_DISPOSERS.push(
    subscribeToSignalChanges([sessionView()], syncTranscriptSubscriptions),
  );
  syncTranscriptSubscriptions();
}
// Approvals go through the session's interaction port with the TUI host
// attached, exactly as `chatSessionController` wires a live chat.
const harnessRuntimeHost: CliRuntimeHost = createCliRuntimeHost(
  harnessRuntime,
  HARNESS_CLI_CONTEXT,
);
HARNESS_DISPOSERS.push(
  Effect.runSync(
    session().interactions.use(
      createTuiHostInteractions(harnessRuntimeHost, HARNESS_CLI_CONTEXT, {
        session: session(),
        secrets: HARNESS_PLATFORM_SERVICES.secrets,
        settings: HARNESS_PLATFORM_SERVICES,
        runtime: harnessRuntime,
      }),
    ),
  ),
);
HARNESS_DISPOSERS.push(announceForegroundApprovals());

/**
 * The runs this harness has minted, and the category each was minted with.
 * `publish` enqueues a job on the session's one publisher, so the fold — and
 * the view every render reads — lands after the seeding that queued it. A
 * seeder therefore reads what it published from here, never from the view.
 */
const harnessRuns = new Map<RunId, AgentCategory>();

/** Mint a run: its `run.start` existence fact (PRD 6, item 2), then the
 *  `run.config` launch fact a real run publishes next, which names the model
 *  an agent runs on (a child's scrollback header waits for it). */
function seedRun(
  runId: RunId,
  options: {
    readonly category?: AgentCategory;
    readonly identity?: NonNullable<
      Extract<SessionEventDraft, { type: 'run.start' }>['identity']
    >;
    readonly parentRunId?: RunId;
    /** The agent name for a default (agent) identity; a run id names nothing. */
    readonly agent?: string;
    readonly userFollowUpSupport?: Extract<
      SessionEventDraft,
      { type: 'run.start' }
    >['userFollowUpSupport'];
  } = {},
): void {
  if (harnessRuns.has(runId)) return;
  harnessRuns.set(runId, options.category ?? AgentCategory.ToolUse);
  const identity = options.identity ?? {
    kind: 'agent' as const,
    agent: options.agent ?? 'harness-agent',
  };
  publish({
    type: 'run.start',
    aggregateId: qualifyAggregateId('run', runId),
    identity,
    category: options.category ?? AgentCategory.ToolUse,
    isRemote: false,
    userFollowUpSupport:
      options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    parent:
      options.parentRunId === undefined ? null : { id: options.parentRunId },
  });
  if (identity.kind === 'agent') {
    publish({
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
      config: AgentConfigFieldsSchema.parse({
        agent: identity.agent,
        agentCategory: options.category ?? AgentCategory.ToolUse,
        model: HARNESS_MODEL,
      }),
    });
  }
}

/**
 * Place a run in a phase the way production does: `run.activate` opens the
 * running window and a `flow.step` parks it (one run model, 3.3). A terminal
 * phase is `run.end`, so a fixture that names one lands there instead.
 *
 * The run window opens at the activation row's publish clock, which the
 * publisher stamps, so a fixture cannot backdate the elapsed time the status
 * bar shows.
 */
function seedPhase(runId: RunId, phase: RunPhase): void {
  seedRun(runId);
  if (isTerminalOutcomePhase(phase)) {
    seedRunEnd(runId, phase);
    return;
  }
  const run = runViewOf(currentView(), runId);
  const category = run?.category ?? AgentCategory.ToolUse;
  if (run?.status !== RUN_PHASE.RUNNING) {
    publish({
      type: 'run.activate',
      aggregateId: qualifyAggregateId('run', runId),
      category,
      isRemote: false,
    });
  }
  if (phase === RUN_PHASE.WAITING) {
    publish({
      type: 'flow.step',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', step: 'waiting' },
    });
  } else if (category === AgentCategory.ToolUse) {
    publish({
      type: 'flow.step',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', step: 'turn.begin', turn: 1 },
    });
  }
}

/** End a run the way a real session does: the terminal `run.end` fact the
 *  fold turns into the terminal phase and the durable outcome. The run's
 *  category comes from the mint record, not the view: a fixture that seeds a
 *  terminal phase during boot does it before the publisher has folded the
 *  `run.start` it just queued. */
function seedRunEnd(runId: RunId, outcome: RunOutcome): void {
  const category = harnessRuns.get(runId);
  if (category === undefined) {
    throw new Error(`tui-harness: cannot end unknown run ${runId}`);
  }
  publish({
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome,
    output: emptyRunEndOutput(category),
  });
}

function seedDescription(runId: RunId, description: string): void {
  publish({
    type: 'run.description',
    aggregateId: qualifyAggregateId('run', runId),
    description,
  });
}

function removeRun(runId: RunId): void {
  publish({
    type: 'run.removed',
    aggregateId: qualifyAggregateId('run', runId),
  });
  harnessRuns.delete(runId);
}

/** One fixture row: published as one `log` trace row, whose id and clock
 *  the transcript fold mints from the published fact. */
interface HarnessLogRow {
  readonly id: string;
  readonly level: LogLevel;
  readonly timestamp: number;
  readonly messageType: MessageType;
  readonly text?: string;
  readonly data?: unknown;
  readonly groupId?: string;
  readonly verbose?: boolean;
}

/** Publish complete fixture rows on the event plane. */
function seedRows(runId: RunId, entries: readonly HarnessLogRow[]): void {
  seedRun(runId);
  publish(
    ...entries.map((entry) => ({
      type: 'log' as const,
      aggregateId: qualifyAggregateId('run', runId),
      level: entry.level,
      message: entry.text ?? '',
      messageType: entry.messageType,
      data: entry.data,
      stageId: entry.groupId,
      verbose: entry.verbose,
    })),
  );
}

/** A text entry the transcript store settles and the fold projects. */
function harnessTextRow(
  id: string,
  kind: 'assistant' | 'error' | 'user',
  text: string,
  seqNo: number,
): HarnessLogRow {
  const messageType = {
    user: MESSAGE_TYPES.USER_MESSAGE,
    error: MESSAGE_TYPES.ERROR,
    assistant: MESSAGE_TYPES.MODEL_RESPONSE,
  }[kind];
  return {
    id,
    level: kind === 'error' ? LOG_LEVELS.ERROR : LOG_LEVELS.INFO,
    timestamp: seqNo,
    messageType,
    text,
  };
}

function makeEntries(count: number): HarnessLogRow[] {
  const entries: HarnessLogRow[] = [];
  for (let i = 1; i <= count; i += 1) {
    const kind = i % 3 === 0 ? 'assistant' : 'user';
    const text =
      kind === 'user'
        ? `entry-${i} chat history line to grow the transcript pane`
        : `assistant reply ${i} - confirming receipt of entry ${i}`;
    entries.push(harnessTextRow(`entry-${i}`, kind, text, i));
  }
  return entries;
}

function makeLongToolOutput(): NormalizedToolUse {
  return {
    toolName: 'bash',
    errorText: '',
    outputText: Array.from(
      { length: 18 },
      (_, index) =>
        `tool-output-line-${String(index + 1).padStart(2, '0')}${index === 9 ? WIDE_TRANSCRIPT_SUFFIX : ''}`,
    ).join('\n'),
    userInstructionText: '',
    input: { command: 'python3 enumerate_triples.py' },
    isUserFeedback: false,
    headerSummary: 'python3 enumerate_triples.py',
    status: TOOL_CALL_STATUS.COMPLETED,
  };
}

/** A tool entry the fold projects into a tool row. */
function harnessToolEntry(
  id: string,
  toolUse: NormalizedToolUse,
  seqNo = 2,
): HarnessLogRow {
  return {
    id,
    level: LOG_LEVELS.INFO,
    timestamp: seqNo,
    messageType: MESSAGE_TYPES.TOOL_USE,
    data: {
      toolName: toolUse.toolName,
      input: toolUse.input,
      output: toolUse.outputText,
      summary: toolUse.headerSummary,
      status: toolUse.status,
    },
  };
}

function makeLongToolOutputEntries(): HarnessLogRow[] {
  return [
    harnessTextRow(
      'long-tool-user',
      'user',
      'Enumerate Pythagorean triples and show the complete output.',
      1,
    ),
    harnessToolEntry('long-tool-output', makeLongToolOutput()),
  ];
}

function makeAssistantToolPreambleEntries(): HarnessLogRow[] {
  return [
    harnessTextRow('preamble-user', 'user', 'what is this repo about', 1),
    harnessTextRow(
      'preamble-assistant',
      'assistant',
      'I will read the README first.',
      2,
    ),
    harnessToolEntry(
      'preamble-tool',
      {
        toolName: 'read_file',
        errorText: '',
        outputText: '',
        userInstructionText: '',
        input: { path: 'README.md' },
        isUserFeedback: false,
        headerSummary: 'Read README.md',
        status: TOOL_CALL_STATUS.COMPLETED,
      },
      3,
    ),
  ];
}

function seedLiveToolOnlyTranscript(): void {
  const entries: HarnessLogRow[] = [];
  const timestamp = Date.now();
  entries.push({
    id: 'live-tool-user',
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    text: 'what is this repo about',
  });
  entries.push({
    id: 'live-tool-empty-assistant',
    level: LOG_LEVELS.INFO,
    timestamp: timestamp + 1,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    text: SHOW_LIVE_INVISIBLE_ASSISTANT
      ? `${String.fromCharCode(27)}[2m${String.fromCharCode(27)}[22m\u200B\n\n`
      : '',
  });
  const tools = [
    ['grep', { pattern: 'theorem' }, 'Found 12 matches for "theorem" in .'],
    ['glob', { pattern: '*.md' }, 'Found 7 files for "*.md" in .'],
    ['glob', { pattern: '**/*.tex' }, 'Found 6 files for "**/*.tex" in .'],
  ] as const;
  for (const [index, [toolName, input, summary]] of tools
    .slice(0, LIVE_TOOL_COUNT)
    .entries()) {
    entries.push({
      id: `live-tool-${toolName}-${index}`,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + 2 + index,
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName,
        input,
        output: '',
        summary,
        status: TOOL_CALL_STATUS.COMPLETED,
      },
    });
  }
  seedRows(HARNESS_RUN_ID, entries);
}

function makeRejectedBashToolEntries(): HarnessLogRow[] {
  const command = "printf 'approval-reject-live\\n'";
  const message = `User rejected command: ${command}`;
  return [
    harnessTextRow(
      'rejected-bash-user',
      'user',
      'Run a harmless command, but reject it at the approval prompt.',
      1,
    ),
    harnessToolEntry('rejected-bash-tool', {
      toolName: 'bash',
      errorText: message,
      outputText: message,
      userInstructionText: '',
      input: { command },
      isUserFeedback: false,
      headerSummary: command,
      status: TOOL_CALL_STATUS.FAILED,
    }),
  ];
}

function seedSubagentFollowupTranscript(): void {
  const entries: HarnessLogRow[] = [];
  const timestamp = Date.now();
  const followups = [
    '<subagent-progress id="child-a" agent="strategy" type="overview" tool-calls="3" files-changed="none" />',
    [
      '<subagent-result id="child-b" agent="leanSolver" category="toolUse" status="completed">',
      '<wall-time>2min, 3sec</wall-time>',
      '<response>Proved &lt;/response> is escaped &amp; visible.</response>',
      '</subagent-result>',
    ].join('\n'),
    [
      '<subagent-error id="child-c" agent="reviewer" retryable="true">',
      '<message>rate limit: &lt;tokens&gt; &amp; retries exhausted</message>',
      '</subagent-error>',
    ].join('\n'),
  ];
  for (const [index, text] of followups.entries()) {
    entries.push({
      id: `harness-subagent-followup-${index}`,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + index,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text,
    });
  }
  seedRows(HARNESS_RUN_ID, entries);
}

function makeChildEntries(agent: string, action: string): HarnessLogRow[] {
  const assistantText =
    SHOW_LONG_CHILD_OUTPUT && agent === 'strategy'
      ? Array.from(
          { length: 18 },
          (_, index) =>
            `strategy detail line ${String(index + 1).padStart(2, '0')}${index === 17 ? ' final contradiction found' : ''}`,
        ).join('\n')
      : `${agent} is checking the ${action} details and preparing a concise result.`;
  return [
    harnessTextRow(
      `${agent}-user`,
      'user',
      `Please handle the ${action} sub-workflow.`,
      1,
    ),
    harnessTextRow(`${agent}-assistant`, 'assistant', assistantText, 2),
  ];
}

function makeEditApprovalRequest() {
  if (EDIT_APPROVAL_WRAPPED_CONTEXT) {
    const context = [
      `First context paragraph ${'alpha '.repeat(18)}`,
      `Second context paragraph ${'beta '.repeat(18)}`,
      `Third context paragraph ${'gamma '.repeat(18)}`,
    ];
    return {
      path: 'acknowledgments.tex',
      originalContent: [...context, 'Old acknowledgment.'].join('\n'),
      proposedContent: [...context, 'Revised acknowledgment.'].join('\n'),
      sourceTool: 'edit_file',
      runId: HARNESS_RUN_ID,
    };
  }

  const originalBody = Array.from(
    { length: 24 },
    (_, index) => `Line ${index + 1}: placeholder.`,
  );
  const proposedBody = Array.from(
    { length: 24 },
    (_, index) => `Line ${index + 1}: finite-domain proof step ${index + 1}.`,
  );
  return {
    path: 'draft.tex',
    originalContent: [
      '\\documentclass{article}',
      '\\begin{document}',
      ...originalBody,
      '\\end{document}',
    ].join('\n'),
    proposedContent: [
      '\\documentclass{article}',
      '\\begin{document}',
      ...proposedBody,
      '\\end{document}',
    ].join('\n'),
    sourceTool: 'harness',
    runId: HARNESS_RUN_ID,
  };
}

function makeBashApprovalPayload(index = 1) {
  return {
    requestId:
      index === 1 ? 'harness-bash-approval' : `harness-bash-approval-${index}`,
    command: BASH_APPROVAL_COMMAND,
    cwd: HARNESS_CWD,
    allowBypass: true,
    runId: SHOW_WORKFLOW_RUNNING
      ? RUNNING_WORKFLOW_FIRST_AGENT_RUN_ID
      : HARNESS_RUN_ID,
  };
}

function makeRetryApprovalPayload(): RetryPermission {
  return {
    requestId: `harness-retry-${nanoid()}`,
    runId: HARNESS_RUN_ID,
    operation: 'Model request',
    model: HARNESS_MODEL,
    errorMessage: RETRY_APPROVAL_CHATGPT
      ? 'ChatGPT subscription usage limit reached. Resets in 2h.'
      : 'HTTP 429 Too Many Requests',
    errorDetails: {
      classification: {
        // The default stays upstream-credit: that classification requires an
        // explicit user decision before changing credentials, so this fixture
        // remains interactive.
        kind: RETRY_APPROVAL_CHATGPT
          ? 'chatgpt-subscription'
          : 'upstream-credit',
      },
      provider: 'openai',
      statusCode: 429,
    },
    // The invoker decides the offer (#13236); a subscription quota declines
    // its route for the model's own key.
    credentialSwitch: RETRY_APPROVAL_CHATGPT
      ? {
          kind: 'decline-route',
          route: 'chatgpt-subscription',
          provider: 'openai',
          automatic: false,
        }
      : null,
  };
}

function makePlanApprovalPayload(): PlanApprovalPermission {
  return {
    requestId: 'harness-plan-approval',
    runId: HARNESS_RUN_ID,
    goalEnabled: PLAN_APPROVAL_GOAL,
    plan: {
      objective: PLAN_APPROVAL_OBJECTIVE,
    },
  };
}

function makeAgentProposalPayload() {
  return {
    requestId: 'harness-agent-proposal',
    runId: HARNESS_RUN_ID,
    agentCategory: AgentCategory.ToolUse,
    agent: 'review',
    model: 'deepseekT',
    instruction: AGENT_PROPOSAL_INSTRUCTION,
    memories: [],
    workingDirectory: HARNESS_CWD,
  };
}

function makeUserQuestionPayload(): UserQuestionPermission {
  return {
    requestId: 'harness-user-question',
    runId: HARNESS_RUN_ID,
    allowBypass: false,
    context: USER_QUESTION_CONTEXT,
    questions: [
      {
        header: 'Direction',
        question:
          'Which proof direction should the agent prioritize for the next pass?',
        options: [
          {
            label: 'Finite check',
            description: 'Enumerate the bounded cases before simplifying.',
          },
          {
            label: 'Symbolic',
            description: 'Focus on the recurrence and algebraic invariant.',
          },
          {
            label: 'Edge cases',
            description: 'Inspect zero, duplicates, and parity assumptions.',
          },
        ],
      },
      {
        header: 'Include',
        question: 'Which supporting details should be included?',
        multiSelect: true,
        options: [
          {
            label: 'Enumeration table',
            description: 'Show all bounded triples explicitly.',
          },
          {
            label: 'Invariant derivation',
            description: 'Explain why the recurrence preserves the equation.',
          },
          {
            label: 'Failure modes',
            description: 'List assumptions that would break the proof.',
          },
        ],
      },
      {
        header: 'Note',
        question: 'Add a short instruction for the final write-up.',
        allowFreeText: true,
        options: [
          {
            label: 'Concise',
            description: 'Keep the final response short.',
          },
          {
            label: 'Detailed',
            description: 'Include enough detail for independent checking.',
          },
        ],
      },
    ],
  };
}

/** One request the way a run asks: `request.opened` on the run, the modal
 *  reads it off the fold, and the surface's `request.decided` answers it. */
function requestHarnessApproval(
  runId: RunId,
  payload: PermissionPayload,
  onSettled: (decision: RequestDecision) => void | Promise<void>,
): void {
  void harnessRuntime
    .runPromise(session().openRequest(runId, payload))
    .then(onSettled)
    .catch((error: unknown) => {
      appendLocalErrorTranscript(
        `Harness approval failed: ${toErrorMessage(error)}`,
      );
    });
}

/** Close every request the fold still lists, for one run or the session: the
 *  cancellation a stopped run's pending prompts settle with. */
function cancelHarnessRequests(cause: string, runId?: RunId): void {
  for (const request of currentView().requests) {
    if (runId !== undefined && request.runId !== runId) continue;
    publish({
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', request.runId),
      requestId: request.requestId,
      decision: { action: 'cancel', cause },
    });
  }
}

function appendHarnessRetryResult(decision: RequestDecision): void {
  if (decision.action !== 'retry') {
    appendHarnessAssistantTranscript('RETRY-REJECTED');
    return;
  }
  appendHarnessAssistantTranscript(
    decision.credentials === 'personal'
      ? 'RETRY-PERSONAL-CREDENTIALS'
      : 'RETRY-APPROVED',
  );
}

async function appendHarnessPlanDecision(
  result: RequestDecision,
): Promise<void> {
  if (result.action === 'approve_and_goal') {
    await harnessRuntime.runPromise(
      startGoal(session(), HARNESS_RUN_ID, PLAN_APPROVAL_OBJECTIVE),
    );
    // The same grant `PlanTool.startGoalForPlan` applies next: approving a
    // plan as a goal auto-approves commands, and nothing broader unless the
    // user explicitly widened the scope.
    setGoalSessionAutoApproval(
      session(),
      HARNESS_RUN_ID,
      result.autoApproveAll ? 'allAgentWork' : 'commands',
    );
    seedPhase(HARNESS_RUN_ID, RUN_PHASE.RUNNING);
    appendHarnessAssistantTranscript('PLAN-GOAL');
    return;
  }
  appendHarnessAssistantTranscript(
    result.action === 'approve' ? 'PLAN-APPROVED' : 'PLAN-REJECTED',
  );
}

// Queued follow-ups or active (non-idle) todos simulate an in-flight run;
// idle todos instead park the run in a waiting state.
const HARNESS_RUN_ACTIVE =
  QUEUED_FOLLOW_UPS.length > 0 || (SHOW_TODOS && !SHOW_IDLE_TODOS);
const HARNESS_RUN_IDLE = SHOW_TODOS && SHOW_IDLE_TODOS;

function harnessInitialRunStatus(): RunPhase | undefined {
  if (HARNESS_RUN_ACTIVE) return RUN_PHASE.RUNNING;
  if (HARNESS_RUN_IDLE) return RUN_PHASE.WAITING;
  return undefined;
}

function harnessInitialEntries(): HarnessLogRow[] {
  if (SHOW_REJECTED_BASH_TOOL) return makeRejectedBashToolEntries();
  if (SHOW_LONG_TOOL_OUTPUT) return makeLongToolOutputEntries();
  if (SHOW_ASSISTANT_TOOL_PREAMBLE) return makeAssistantToolPreambleEntries();
  if (SHOW_LIVE_TOOL_ONLY || SHOW_STREAMING_TOOL_OUTPUT) return [];
  return makeEntries(ENTRY_COUNT);
}

sessionMeta.set({
  agent: 'chat',
  model: HARNESS_MODEL,
  modelSource: 'builtin-default',
  cwd: HARNESS_CWD,
  approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
  teamName: TEAM_NAME,
  version: '0.0.0-harness',
});
// The harness root: minted before any fixture, like a real run's start.
seedRun(HARNESS_RUN_ID);
focusRun(HARNESS_RUN_ID);
rootRunId.set(HARNESS_RUN_ID);
seedRows(HARNESS_RUN_ID, harnessInitialEntries());
publish(
  ...QUEUED_FOLLOW_UPS.map((text, index) => ({
    type: 'followup.queued' as const,
    aggregateId: qualifyAggregateId('run', HARNESS_RUN_ID),
    followUpId: `harness-follow-up-${index + 1}`,
    content: { text, from: { kind: 'user' as const } },
  })),
);
const HARNESS_INITIAL_RUN_PHASE = harnessInitialRunStatus();
if (HARNESS_INITIAL_RUN_PHASE) {
  seedPhase(HARNESS_RUN_ID, HARNESS_INITIAL_RUN_PHASE);
}

if (SHOW_LIVE_TOOL_ONLY) {
  seedLiveToolOnlyTranscript();
}

if (SHOW_SUBAGENT_FOLLOWUPS) {
  seedSubagentFollowupTranscript();
}

async function seedRunningWorkflow(): Promise<void> {
  const childRunId = RunIdSchema.parse('aaaa0002f10e');
  const firstAgentRunId = RUNNING_WORKFLOW_FIRST_AGENT_RUN_ID;
  const secondAgentRunId = RunIdSchema.parse('aaaa000bf10e');
  seedRun(childRunId, {
    category: AgentCategory.Workflow,
    identity: {
      kind: 'multiAgentWorkflow',
      workflowName: 'live-workflow-validation',
    },
    parentRunId: HARNESS_RUN_ID,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
  });
  seedPhase(childRunId, RUN_PHASE.RUNNING);
  const trace = new TraceEmitter();
  const detachRunTrace = session().attachRunTrace(trace, childRunId);
  const runStage = trace.openStage(
    "Workflow script 'live-workflow-validation'",
    {
      id: 'harness-workflow-running-run',
      kind: 'run',
    },
  );
  const phaseStage = trace.openStage('Proofread', {
    id: 'harness-workflow-running-phase',
    index: 0,
    kind: 'phase',
    parent: runStage,
    total: 1,
  });
  trace.emit({
    type: 'workflow.call',
    logId: 'harness-workflow-running-task-a',
    call: {
      id: 'proofread-a',
      label: 'Proofread paper A',
      phase: 'Proofread',
      status: 'running',
      childRunId: firstAgentRunId,
    },
    stageId: phaseStage.id,
  });
  trace.emit({
    type: 'workflow.call',
    logId: 'harness-workflow-running-task-b',
    call: {
      id: 'proofread-b',
      label: 'Proofread paper B',
      phase: 'Proofread',
      status: 'running',
      childRunId: secondAgentRunId,
    },
    stageId: phaseStage.id,
  });
  for (const agentRunId of [firstAgentRunId, secondAgentRunId]) {
    seedRun(agentRunId, {
      category: AgentCategory.Workflow,
      identity: { kind: 'agent', agent: 'correct' },
      parentRunId: childRunId,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    });
    seedPhase(agentRunId, RUN_PHASE.RUNNING);
  }
  HARNESS_DISPOSERS.push(() => {
    phaseStage.end('cancelled');
    runStage.end('cancelled');
    detachRunTrace();
  });
}

function seedRunningProcessChild(): void {
  const childRunId = RunIdSchema.parse('aaaa0003f10e');
  seedRun(childRunId, {
    identity: { kind: 'process', tool: 'bash' },
    parentRunId: HARNESS_RUN_ID,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
  });
  seedDescription(childRunId, 'sleep 30');
  seedPhase(childRunId, RUN_PHASE.RUNNING);
  focusRun(childRunId);
}

if (SHOW_CHILDREN) {
  const nestedStrategyChild = {
    runId: RunIdSchema.parse('aaaa0004f10e'),
    identity: { kind: 'agent' as const, agent: 'localChecker' },
    agentName: 'localChecker',
    status: RUN_PHASE.RUNNING,
  };
  const childRuns = [
    {
      runId: RunIdSchema.parse('aaaa0005f10e'),
      identity: { kind: 'agent' as const, agent: 'strategy' },
      agentName: 'strategy',
      status: RUN_PHASE.RUNNING,
    },
    {
      runId: RunIdSchema.parse('aaaa0006f10e'),
      identity: { kind: 'agent' as const, agent: 'leanSolver' },
      agentName: 'leanSolver',
      status: RUN_PHASE.WAITING,
    },
    {
      runId: RunIdSchema.parse('aaaa0007f10e'),
      identity: { kind: 'agent' as const, agent: 'reviewer' },
      agentName: 'reviewer',
      status: RUN_PHASE.RUNNING,
    },
  ].map((child) =>
    child.agentName === FAILED_CHILD_AGENT
      ? { ...child, status: RUN_PHASE.FAILED }
      : child,
  );
  // One run window across every later active phase: an activation on a run
  // already running would re-open it, so `seedPhase` keeps the first one.
  seedPhase(HARNESS_RUN_ID, RUN_PHASE.RUNNING);
  for (const child of childRuns) {
    const runId = child.runId;
    seedRun(runId, {
      identity: child.identity,
      parentRunId: HARNESS_RUN_ID,
    });
    seedDescription(runId, `${child.agentName} sub-workflow`);
    seedRows(runId, makeChildEntries(child.agentName, child.runId));
    // One child carries usage so scenarios pin the row metadata column's
    // generated-token figure (`↓40k`).
    if (child.agentName === 'reviewer') {
      publish({
        type: 'usage',
        aggregateId: qualifyAggregateId('run', runId),
        runId,
        usage: { inputTokens: 52_000, outputTokens: 39_900, cost: 0.12 },
      });
    }
    seedPhase(runId, child.status);
  }
  if (SHOW_NESTED_CHILDREN) {
    const nestedRunId = nestedStrategyChild.runId;
    seedRun(nestedRunId, {
      identity: nestedStrategyChild.identity,
      parentRunId: RunIdSchema.parse('aaaa0005f10e'),
    });
    seedDescription(nestedRunId, 'localChecker nested proof check');
    seedRows(
      nestedRunId,
      makeChildEntries('localChecker', 'nested proof check'),
    );
    seedPhase(nestedRunId, RUN_PHASE.RUNNING);
  }
}

if (SHOW_TODOS) {
  const workPlan = {
    todos: [
      {
        content: 'Split theorem into algebraic and analytic checks',
        activeForm: 'Splitting theorem into checks',
        status: TODO_STATUS.COMPLETED,
      },
      {
        content: 'Ask leanSolver to verify the finite case',
        activeForm: 'Waiting for leanSolver',
        status: SHOW_COMPLETED_TODOS_ONLY
          ? TODO_STATUS.COMPLETED
          : TODO_STATUS.IN_PROGRESS,
      },
      {
        content: 'Merge subagent conclusions into final answer',
        activeForm: 'Merging subagent conclusions',
        status: SHOW_COMPLETED_TODOS_ONLY
          ? TODO_STATUS.COMPLETED
          : TODO_STATUS.PENDING,
      },
    ],
    plan: {
      objective: [
        'Coordinate a small math proof through nested CLI work.',
        'Route proof obligations to the right specialist.',
        'Have a subagent inspect the Lean-style finite case.',
      ].join('\n'),
    },
  };
  publish(
    {
      type: 'run.fact',
      aggregateId: qualifyAggregateId('run', HARNESS_RUN_ID),
      fact: { key: 'todos', todos: [...workPlan.todos] },
    },
    {
      type: 'run.fact',
      aggregateId: qualifyAggregateId('run', HARNESS_RUN_ID),
      fact: { key: 'plan', plan: workPlan.plan },
    },
  );
}

if (SHOW_EDIT_APPROVAL) {
  const showApproval = () => {
    const request = makeEditApprovalRequest();
    const { permission } = prepareToolEditApprovalPrompt(session(), {
      requestId: 'harness-edit-approval',
      request,
      relativePath: request.path,
    });
    // The preview the durable payload cannot carry is staged on the host,
    // exactly as `requestToolEditApproval` stages it. Staging hands back the
    // release for an open that never commits; this request is opened right
    // below, so the harness holds that program and never runs it.
    const releaseStagedPreview = harnessRuntime.runSync(
      session().interactions.presentToolEdit({
        ...request,
        roots: session().roots,
        permission,
      }),
    );
    requestHarnessApproval(
      request.runId,
      { kind: 'toolEdit', data: permission },
      () => undefined,
    );
  };

  showApproval();
}

// The running workflow exists before its agent asks below: a request names
// a run the fold already holds, the way a real run's does.
if (SHOW_WORKFLOW_RUNNING) {
  await seedRunningWorkflow();
}

if (SHOW_BASH_APPROVAL) {
  const showApproval = (index = 1) => {
    const permission = makeBashApprovalPayload(index);
    return harnessRuntime.runPromise(
      session().openRequest(permission.runId, {
        kind: 'bash',
        data: permission,
      }),
    );
  };
  const showRepeatedApprovals = async (): Promise<void> => {
    const decision = await showApproval(1);
    if (decision.action !== 'approve') return;
    const secondDecision = await showApproval(2);
    appendHarnessAssistantTranscript(
      secondDecision.action === 'approve'
        ? 'SECOND-BASH-APPROVED'
        : 'SECOND-BASH-REJECTED',
    );
  };
  const startApprovals = () => {
    if (SHOW_REPEATED_BASH_APPROVAL) {
      void showRepeatedApprovals().catch(() => undefined);
      return;
    }
    void showApproval(1);
  };

  if (SHOW_BASH_APPROVAL_AFTER_CHILD_FOCUS) {
    let pollCount = 0;
    const timer = setInterval(() => {
      pollCount += 1;
      const activeRunId = selectedRunId.get();
      if (activeRunId === undefined || activeRunId === HARNESS_RUN_ID) {
        if (pollCount >= 200) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      startApprovals();
    }, 25);
    timer.unref?.();
  } else {
    startApprovals();
  }
}

if (SHOW_RETRY_APPROVAL) {
  await harnessRuntime.runPromise(
    // A fixture seed, not a product write: the harness only needs the key in
    // its fake store, with none of the notice or refresh a real key write
    // carries. Dropping the API-key lookup cache is part of that refresh, and
    // the seed does not need it: this store is created by this script, and
    // every read of it (`prepareRetry`'s card lookup, the retry gate,
    // `/model`'s access rows) is driven by the approval requested below or by
    // a keypress after it, so nothing can have cached `openai` as absent.
    HARNESS_PLATFORM_SERVICES.secrets.set(
      apiKeySecretName('openai'),
      'sk-harness-openai-key',
    ),
  );
  // The credential the retry lands on is the decision's own field: the TUI
  // host prepares the card and performs the switch off the pending fact.
  requestHarnessApproval(
    HARNESS_RUN_ID,
    { kind: 'retry', data: makeRetryApprovalPayload() },
    appendHarnessRetryResult,
  );
}
if (SHOW_USER_QUESTION) {
  requestHarnessApproval(
    HARNESS_RUN_ID,
    { kind: 'userQuestion', data: makeUserQuestionPayload() },
    () => undefined,
  );
}
if (SHOW_PLAN_APPROVAL) {
  requestHarnessApproval(
    HARNESS_RUN_ID,
    { kind: 'planApproval', data: makePlanApprovalPayload() },
    appendHarnessPlanDecision,
  );
}

if (SHOW_AGENT_PROPOSAL) {
  requestHarnessApproval(
    HARNESS_RUN_ID,
    { kind: 'proposal', data: makeAgentProposalPayload() },
    () => undefined,
  );
}

function markHarnessInterrupted(): void {
  canInterrupt = false;
  harnessSession.markRunCompleted();
  cancelHarnessRequests('Session interrupted.');
  appendHarnessAssistantTranscript(
    'Harness interrupt requested.',
    HARNESS_RUN_ID,
  );
  for (const runId of descendantRuns(currentView(), HARNESS_RUN_ID, {
    includeRoot: true,
  })) {
    const run = runViewOf(currentView(), runId);
    if (run && isInFlightPhase(run.status)) {
      seedRunEnd(runId, RUN_OUTCOME.CANCELLED);
    }
  }
}

function appendHarnessAssistantTranscript(text: string, runId?: RunId): void {
  appendHarnessTranscript('assistant', text, runId);
}

// Which run a local row belongs to is `transcript.ts`'s answer, not a second
// one here: its fallback is the local-conversation id, the one id
// `selectedRunId` keeps selected while no run of this session exists — which
// is exactly the state `/clear` leaves behind.
function appendHarnessTranscript(
  role: 'assistant' | 'error' | 'user',
  text: string,
  explicitRunId?: RunId,
): void {
  switch (role) {
    case 'assistant':
      appendLocalAssistantTranscript(text, explicitRunId);
      return;
    case 'user':
      appendLocalUserTranscript(text);
      return;
    case 'error':
      appendLocalErrorTranscript(text);
      return;
  }
}

function setHarnessApprovalPolicy(policy: TexraApprovalPolicy): void {
  harnessRuntimeSession.setApprovalPolicy(policy);
  sessionMeta.set({
    ...sessionMeta.get(),
    approvalPolicy: policy,
  });
  appendHarnessAssistantTranscript(
    `Approval mode: ${formatTexraApprovalPolicy(policy)}`,
  );
}

function applyHarnessApprovalPolicySelection(
  input: string,
  usage: string,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    if (openCliSlashCommandForm('approval', input)) return;
  }

  const policy = parseTexraApprovalPolicy(normalized);
  if (!policy) {
    appendHarnessAssistantTranscript(usage);
    return;
  }

  setHarnessApprovalPolicy(policy);
}

function handleHarnessSubmit(line: string): void {
  if (handleHarnessSlashCommand(line)) return;
  const view = currentView();
  const focused = runViewOf(view, selectedRunId.get());
  if (focused && focused.parentId !== null) {
    if (!acceptsFollowUp(focused, CLI_FOLLOW_UP_HOST)) {
      appendHarnessAssistantTranscript(
        FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
        focused.id,
      );
      return;
    }
    appendHarnessAssistantTranscript(`Harness received: ${line}`, focused.id);
    return;
  }
  appendHarnessAssistantTranscript(`Harness received: ${line}`);
}

function appendHarnessStatus(): void {
  const meta = sessionMeta.get();
  const view = currentView();
  const runId = selectedRunId.get() ?? HARNESS_RUN_ID;
  const run = runViewOf(view, runId);
  appendHarnessAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent,
      model: meta.model,
      teamName: meta.teamName,
      modelAccess: run?.usage.usageRoute,
      approvalPolicy: harnessRuntimeSession.approvalPolicy,
      approvalBypasses: view.policy.get(runId)?.bypasses,
      statusLabel: run?.statusLabel,
      activeChildSessions: runningChildCount(view, run),
      goal:
        run?.category === AgentCategory.ToolUse && run.goal.active
          ? run.goal
          : undefined,
      // The harness never commits a `skills.snapshot` row.
      activeSkills: [],
      queuedFollowUpMessages: (view.queuedFollowUps.get(runId) ?? []).map(
        (followUp) => followUp.text,
      ),
    }),
  );
}

function resetHarnessForClear(): void {
  const meta = sessionMeta.get();
  cancelHarnessRequests('Session interrupted.');
  void harnessRuntime.runPromise(clearGoal(session(), HARNESS_RUN_ID));
  for (const runId of [...currentView().runs.keys()]) {
    removeRun(runId);
  }
  // `resetCliState` retires the focus the way the real `/clear` does, and
  // nothing re-focuses a run this reset just removed: the next local row
  // adopts the local-conversation id, which is what the surface renders
  // until a new turn mints a run.
  resetCliState(meta);
  // Mirror the real /clear handler (runChatTui.tsx): erase the terminal
  // outside Ink, then notify the erase epoch so the transcript rebuilds
  // after the reset state commits and repaints the session header.
  clearTerminalScrollback();
  notifyStaticTranscriptErased();
}

function handleHarnessSlashCommand(line: string): boolean {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const commandName = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  switch (commandName) {
    case 'help':
      appendHarnessAssistantTranscript(
        formatSlashCommandHelp(listSlashCommands(), {
          shortcutModifierLabel: defaultShortcutModifierLabel(),
        }),
      );
      return true;
    case 'resume':
      appendHarnessAssistantTranscript(`Harness resume selected: ${rest}.`);
      return true;
    case 'status':
      appendHarnessStatus();
      return true;
    case 'plan':
      void showCliWorkPlan(session());
      return true;
    case 'clear':
      resetHarnessForClear();
      return true;
    case 'approval':
      applyHarnessApprovalPolicySelection(rest, HARNESS_APPROVAL_USAGE);
      return true;
    default: {
      const command = findSlashCommand(commandName);
      if (!command) {
        const suggestion = suggestSlashCommand(commandName);
        const didYouMean = suggestion
          ? ` Did you mean /${suggestion.name}?`
          : '';
        appendHarnessAssistantTranscript(
          `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
        );
        return true;
      }
      if (openRegisteredCliSlashForm(command, rest)) return true;
      appendHarnessAssistantTranscript(
        `/${command.name} is registered but has no harness action.`,
      );
      return true;
    }
  }
}

/** The harness's root-run claim, held the way `texra chat` holds its own. */
const harnessSession = new TuiSession(() => undefined);

registerBuiltinSlashCommands({
  secrets: HARNESS_PLATFORM_SERVICES.secrets,
  stores: HARNESS_PLATFORM_SERVICES,
  runtime: HARNESS_PLATFORM_SERVICES.runtime,
  runtimeSession: harnessRuntimeSession,
  // Mirror `texra chat`: agent selection is open exactly while no root run
  // is pending.
  canSelectAgent: () => chatTuiCanStartRootRun(harnessSession),
  canSelectModel: () => CAN_SELECT_MODEL,
  getModelSwitchDisabledReason: (model) =>
    Effect.succeed(
      DISABLED_MODEL_SWITCHES.has(model)
        ? DISABLED_MODEL_SWITCH_REASON
        : undefined,
    ),
  getApprovalPolicy: () => harnessRuntimeSession.approvalPolicy,
  onApprovalPolicySelect: setHarnessApprovalPolicy,
  onModelSelect: (model) =>
    Effect.sync(() => {
      setCliSessionModelOverride(model);
      appendHarnessAssistantTranscript(
        `Harness model selected. Future turns: ${model}.`,
      );
    }),
  onModelAccessSelect: (selection) =>
    selection.provider === 'kimi-code' && selection.state === 'on'
      ? updateCliModelAccess(
          HARNESS_PLATFORM_SERVICES,
          HARNESS_CLI_CONTEXT,
          selection,
          {
            writeProgress: (message) =>
              appendHarnessAssistantTranscript(message),
          },
        ).pipe(
          Effect.map((access) => {
            appendHarnessAssistantTranscript(access.message);
          }),
        )
      : Effect.sync(() => {
          appendHarnessAssistantTranscript(
            `${selection.provider} preference set to ${selection.state}.`,
          );
        }),
  onMemorySelect: (storagePath) =>
    Effect.sync(() => {
      appendHarnessAssistantTranscript(
        `Harness memory selected: ${storagePath}.`,
      );
    }),
  onSkillSelect: (selection) =>
    Effect.sync(() => {
      appendHarnessAssistantTranscript(
        `Harness skill selected: ${selection.name}.`,
      );
    }),
  onResumeSelect: (id) =>
    Effect.sync(() => {
      appendHarnessAssistantTranscript(`Harness resume selected: ${id}.`);
    }),
  configStores: session().roots,
  onError: (error) => {
    appendHarnessAssistantTranscript(
      `Slash command failed: ${toErrorMessage(error)}`,
    );
  },
});
// An interruptible harness run is a pending root-run claim on the harness
// run, so the status bar derives the Ctrl-C stop hint exactly as `texra chat`
// does.
if (canInterrupt) {
  harnessSession.markRunPending(Effect.never);
  harnessSession.runId = HARNESS_RUN_ID;
}

const inkRef: { current?: ReturnType<typeof render> } = {};
const viewportController = createTuiViewportController(inkRef);

function handleHarnessCtrlC(): void {
  if (canInterrupt) {
    markHarnessInterrupted();
    return;
  }
  void exitHarness(0);
}

function renderHarnessApp(): React.JSX.Element {
  return (
    <App
      secrets={HARNESS_PLATFORM_SERVICES.secrets}
      stores={HARNESS_PLATFORM_SERVICES}
      runtime={harnessRuntime}
      session={session()}
      onSubmit={handleHarnessSubmit}
      history={HARNESS_INPUT_HISTORY}
      onStaticTranscriptChange={viewportController.repaintTranscript}
      onCtrlC={handleHarnessCtrlC}
    />
  );
}

// The same recorded fan-out as the drawer, plus the session this terminal
// resumed: `interrupted`, whose previous process is gone, with a `nested`
// child of its own, and a `waiting` run this terminal still owns that is
// parked on an approval. The CLI lists this conversation and the runs this
// terminal owns (#12475), so the resumed root is what puts a foreign,
// owner-less run in the list at all.
if (process.env.HARNESS_SESSION_TREE === '1') {
  const { log, events } = buildScenario();
  const recordedCount = log.events.length;
  const waiting = RunIdSchema.parse('eeeeeeeeeeee');
  const interrupted = RunIdSchema.parse('ffffffffffff');
  const nested = RunIdSchema.parse('111111111111');
  log.emit(PROCESS, 10_000_000, {
    type: 'run.activate',
    category: AgentCategory.ToolUse,
    isRemote: false,
  });
  for (const [id, agent, owner, parentId] of [
    [waiting, 'waiting', OWNER, null],
    [interrupted, 'interrupted', OTHER_OWNER, null],
    [nested, 'nested', OTHER_OWNER, interrupted],
  ] as const) {
    log.emit(
      id,
      10_000_000,
      {
        type: 'run.start',
        identity: { kind: 'agent', agent },
        category: AgentCategory.ToolUse,
        isRemote: false,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        // The creation commit the database stamps, not a guess: `Log.parent`
        // refuses a parent that never started.
        parent: parentId === null ? null : log.parent(parentId),
      },
      owner,
    );
    log.emit(
      id,
      10_000_000,
      {
        type: 'run.activate',
        category: AgentCategory.ToolUse,
        isRemote: false,
      },
      owner,
    );
  }
  log.emit(waiting, 10_000_000, {
    type: 'request.opened',
    requestId: 'tree-approval',
    payload: {
      kind: 'bash',
      data: {
        requestId: 'tree-approval',
        runId: waiting,
        command: 'ls',
        allowBypass: true,
      },
    },
  });
  const view = foldAll([
    ...events,
    ...log.events.slice(recordedCount).map(tail),
    // `buildScenario` stamped its existence snapshot before these runs
    // existed, and a run with no claim has no owner: re-read the log so the
    // three new aggregates carry the owner each was emitted under.
    log.drained(),
    local({ self: [OWNER], dead: [OTHER_OWNER] }),
  ]);
  const ref = await harnessRuntime.runPromise(SubscriptionRef.make(view));
  HARNESS_DISPOSERS.push(bindSessionView(harnessRuntime, ref));
  rootRunId.set(interrupted);
  focusRun(PROCESS);
}

const ink = render(renderHarnessApp(), {
  stdout: HARNESS_STDOUT,
  stderr: process.stderr,
  stdin: process.stdin,
  exitOnCtrlC: false,
});
inkRef.current = ink;

if (SHOW_STREAMING_TOOL_OUTPUT) {
  const fiber = harnessRuntime.runFork(
    Effect.gen(function* () {
      yield* Effect.sleep('1 second');
      seedPhase(HARNESS_RUN_ID, RUN_PHASE.RUNNING);
      session().publishRunEvent(HARNESS_RUN_ID, {
        type: 'stream.start',
        id: 'streaming-thinking',
        kind: MESSAGE_TYPES.THINKING,
      });
      session().publishRunEvent(HARNESS_RUN_ID, {
        type: 'stream.chunk',
        id: 'streaming-thinking',
        text: 'Checking the streamed calculation.',
      });
      session().publishRunEvent(HARNESS_RUN_ID, {
        type: 'tool.start',
        logId: 'streaming-tool',
        toolName: 'bash',
        input: { command: 'python3 calculation.py' },
      });
      for (let index = 1; index <= 12; index += 1) {
        session().publishRunEvent(HARNESS_RUN_ID, {
          type: 'stream.chunk',
          id: 'streaming-tool',
          text: `output-${index}: ${'long result '.repeat(30)}\n`,
        });
        yield* Effect.sleep('80 millis');
      }
    }),
  );
  HARNESS_DISPOSERS.push(() => harnessRuntime.runFork(Fiber.interrupt(fiber)));
}

if (SHOW_TERMINAL_RESUME_REPAINT) {
  void (async () => {
    // Let the first static-transcript commit flush, then exercise the same
    // SIGCONT repair path the real session-exit controller uses. The epoch
    // remounts <Static> and repaints with replace semantics.
    await setTimeout(0);
    await ink.waitUntilRenderFlush();
    viewportController.repaintAfterTerminalResume();
    await setTimeout(0);
    await ink.waitUntilRenderFlush();
  })().catch((error) => {
    process.stderr.write(
      `[tui-harness] HARNESS_TERMINAL_RESUME_REPAINT failed: ${toErrorMessage(error)}\n`,
    );
    void exitHarness(1);
  });
}

if (SHOW_PROCESS_CHILD) {
  seedRunningProcessChild();
}

let harnessExiting = false;
async function exitHarness(exitCode: number): Promise<void> {
  if (harnessExiting) return;
  harnessExiting = true;
  for (const dispose of HARNESS_DISPOSERS.splice(0).toReversed()) {
    dispose();
  }
  ink.unmount();
  try {
    await Effect.runPromise(harnessRuntimeHost.close());
    await Effect.runPromise(HARNESS_PLATFORM_SERVICES.lifecycle.runShutdown);
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', handleHarnessCtrlC);
