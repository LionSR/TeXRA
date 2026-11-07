// Test harness: seed the session fold with synthetic runs and rows, render
// <App /> to the real terminal. Every fixture is published through the
// runtime session (its log, the transcript store, the
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
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  SubscriptionRef,
} from 'effect';
import { nanoid } from 'nanoid';
import React from 'react';

import { apiKeySecretName } from '@texra-ai/llm';
import {
  AgentCatalog,
  describeFollowUpFailure,
  Secrets,
} from '@texra-ai/harness/host';
import {
  attachInteractions,
  Interactions,
} from '@agent/runtime/HostInteractions';
import { openRequest, SessionRequests } from '@agent/runtime/requests';
import { queuedRow } from '@agent/followUp/followUpMessages';
import { SessionOwner } from '@agent/runtime/rootLaunch';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { SessionRoots } from '@platform/rootedFs';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';
import {
  RunHistory,
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { acceptsFollowUp, descendantRuns } from '@shared/session/sessionView';
import { runBypasses } from '@shared/approvalBypassKind';
import { summarizeSubagentFollowup } from '@shared/subagentFollowup';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import {
  parseApprovalPolicy,
  APPROVAL_POLICY_DEFAULT,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  qualifyAggregateId,
  AgentProposalRequestSchema,
  AgentConfigSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  TOOL_CALL_STATUS,
  RunIdSchema,
  toJsonValue,
  type JsonValue,
  type LogLevel,
  type MessageType,
  type AgentProposalRequest,
  type NormalizedToolUse,
  type RequestPayload,
  type PlanApprovalRequest,
  type RequestDecision,
  type RetryRequest,
  type RunOutcome,
  type RunId,
  type SessionRowDraft,
  type UserQuestionRequest,
  aggregateTarget,
  type ToolEditContent,
} from '@shared/schemas';
import type { DraftBlob } from '@shared/session/historyTurns';
import { WORKSPACE_AGENTS_KEY } from '@agent/workspaceAgents/workspaceAgentsState';
import { MODEL_SELECTION_KEY } from '@model/computeModelOptions';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import {
  ALL_RUNS,
  buildScenario,
  viewOf,
  local,
  PROCESS,
  tail,
} from '@test/shared/session/fanOutScenario';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import {
  buildDiffHunks,
  countLineChanges,
  firstChangedLine,
} from '@tools/unifiedDiff';
import { runStatus } from '@ui/copy/runStatus';
import { formatApprovalPolicy } from '@ui/copy/approvalPolicy';
import { blobAddress } from '@utils/core/idHash';
import { nodeFileServices } from '@utils/files/fsDurability';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { App } from '../src/chat/tui/App';
import { builtinSlashCommands } from '../src/chat/tui/commands/registerBuiltins';
import { loginFromChat } from '../src/chat/tui/commands/handlers/loginCommands';
import { showCliWorkPlan } from '../src/chat/tui/commands/handlers/sessionCommands';
import { formatSlashCommandHelp } from '../src/chat/tui/commands/helpText';
import {
  parseSlashInput,
  SlashCommandsProvider,
} from '../src/chat/tui/commands/slashRegistry';
import { openRegisteredCliSlashForm } from '../src/chat/tui/commands/slashForms';
import {
  focusRun,
  rootRunId,
  patchSessionMeta,
  resetCliState,
  selectedRunId,
  sessionMeta,
  setCliSessionModelOverride,
  setTransientNotice,
} from '../src/chat/tui/state/cliState';
import {
  bindSessionView,
  currentView,
  runningChildCount,
  sessionView,
  runViewOf,
} from '../src/chat/tui/state/sessionView';
import { TuiSession } from '../src/chat/tui/state/sessionRunState';
import {
  formatCliSessionStatus,
  taskCostStatus,
} from '../src/chat/tui/sessionStatus';
import { chatScrollback } from '../src/chat/tui/panes/staticTranscriptRing';
import {
  EMPTY_DRAFT,
  expandText,
} from '../src/chat/tui/input/draftAttachments';
import {
  announceForegroundApprovals,
  createTuiHostInteractions,
} from '../src/chat/tui/state/subscribeApprovals';
import {
  appendLocalNotice,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
} from '../src/chat/tui/state/transcript';
import { clearTerminalScrollback } from '../src/tui/terminalCleanup';
import { defaultShortcutModifierLabel } from '../src/runtime/terminal/shortcutLabels';
import { updateCliModelAccess } from '../src/runtime/models/modelAccessSelection';
import { makeCliProcessRuntime } from '../src/runtime/platform/cliProcessRuntime';
import { cliPlatform } from '../src/runtime/platform/initPlatform';
import { resolveCliResourcesPath } from '../src/runtime/platform/resourcesPath';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '../src/runtime/headless/cliPresentationHost';
import { setCliToolEnabled } from '../src/runtime/tools';
import type { CliContext } from '../src/runtime/platform/cliContext';

const harnessRunId = Schema.decodeUnknownSync(RunIdSchema);
const HARNESS_RUN_ID = harnessRunId('aaaa0001f10e');
const HARNESS_MODEL = 'harness-model';
const RUNNING_SCRIPT_FIRST_AGENT_RUN_ID = harnessRunId('aaaa000af10e');
const SHOW_SCRIPT_RUNNING = process.env.HARNESS_SCRIPT_RUNNING === '1';
const SHOW_PROCESS_CHILD = process.env.HARNESS_PROCESS_CHILD === '1';
const RESET_MULTI_AGENT_DISABLED =
  process.env.HARNESS_MULTI_AGENT_DISABLED === '1';
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
/** The proposal is a script's request for its `agent` calls. */
const SCRIPT_PROPOSAL = process.env.HARNESS_SCRIPT_PROPOSAL === '1';
/** A finished `agent` call whose output is its delivery envelope. */
const SHOW_AGENT_RESULT = process.env.HARNESS_AGENT_RESULT === '1';
/** An agent call that may have run before TeXRA stopped, with no result. */
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
  process.env.HARNESS_BASH_APPROVAL_COMMAND ?? 'npm run typecheck';
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
const SHOW_PLAN = process.env.HARNESS_PLAN === '1';
const SHOW_IDLE_PLAN = process.env.HARNESS_PLAN_IDLE === '1';
const FAILED_CHILD_AGENT = process.env.HARNESS_FAILED_CHILD?.trim();
const TEAM_NAME = process.env.HARNESS_TEAM_NAME?.trim() || undefined;
let canInterrupt = process.env.HARNESS_CAN_INTERRUPT === '1';
const QUEUED_FOLLOW_UPS = parseList(process.env.HARNESS_QUEUED_FOLLOWUPS);
// Deliveries a child run queued on the root (a `<subagent-result>`
// envelope), as opposed to the user's own messages.
const QUEUED_DELIVERIES = parseList(process.env.HARNESS_QUEUED_DELIVERIES);
const DELIVERING_CHILD_RUN_ID = harnessRunId('aaaa00c1f10e');
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
  approvalPolicy: APPROVAL_POLICY_DEFAULT,
  config: new MemoryConfigProvider(TEXRA_SETTINGS.catalog),
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
  renderRunProgress: false,
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

const HARNESS_VISIBLE_AGENTS = parseList(process.env.HARNESS_VISIBLE_AGENTS);
const HARNESS_VISIBLE_MODELS = parseList(process.env.HARNESS_VISIBLE_MODELS);
const HARNESS_MEMORY_FILES = parseList(process.env.HARNESS_MEMORY_FILES);

if (SHOW_PROJECT_SKILL) {
  seedHarnessProjectSkill();
}

// The harness runs over the same runtime and platform `texra chat` builds,
// from the harness context (its provider is the one its rows resolve
// through), with no signal handler of its own.
const HARNESS_PLATFORM_SERVICES = await makeCliProcessRuntime(
  HARNESS_CLI_CONTEXT,
  { installSignalHandlers: false },
).runPromise(cliPlatform);
if (RESET_MULTI_AGENT_DISABLED) {
  await HARNESS_PLATFORM_SERVICES.runtime.runPromise(
    setCliToolEnabled('multi-agent', false),
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
// The persistent session the platform opened over the harness roots,
// and its internal owners, which the fixtures seed rows through: the same
// root's, from the process's session owner.
const harnessRunSession = await harnessRuntime.runPromise(
  HARNESS_PLATFORM_SERVICES.session,
);
const harnessRuntimeSession = await harnessRuntime.runPromise(
  Effect.flatMap(harnessRuntime.contextEffect, (context) =>
    Context.getUnsafe(context, SessionOwner).open({
      roots: harnessRunSession.roots,
    }),
  ),
);
if (process.env.HARNESS_VISIBLE_AGENTS !== undefined) {
  await harnessRuntime.runPromise(
    harnessRoots.repoState.update(WORKSPACE_AGENTS_KEY.key, {
      kind: 'custom',
      agentKeys: HARNESS_VISIBLE_AGENTS,
    }),
  );
}
if (process.env.HARNESS_VISIBLE_MODELS !== undefined) {
  await harnessRuntime.runPromise(
    harnessRoots.globalState.update(MODEL_SELECTION_KEY.key, {
      enabledExtras: HARNESS_VISIBLE_MODELS,
      disabledDefaults: DEFAULT_MODELS.filter(
        (model) => !HARNESS_VISIBLE_MODELS.includes(model),
      ),
    }),
  );
}
await harnessRuntime.runPromise(AgentCatalog.use((catalog) => catalog.refresh));

// =========================================================================
// Fold seeding: every fixture is a session fact
// =========================================================================

const HARNESS_DISPOSERS: Array<() => void> = [];

/** The owners of the session every fixture publishes into and the TUI
 *  renders. */
const harnessOwners = {
  log: Context.get(harnessRuntimeSession, SessionLog),
  runHistory: Context.get(harnessRuntimeSession, RunHistory),
  view: Context.get(harnessRuntimeSession, SessionViewAccess),
  interactions: Context.get(harnessRuntimeSession, Interactions),
  requests: Context.get(harnessRuntimeSession, SessionRequests),
  roots: Context.get(harnessRuntimeSession, SessionRoots),
};
function session() {
  return harnessOwners;
}

/**
 * Write fixture rows the way the session does: a row no run's state folds
 * as one transaction, a `run.activate` as its run's opening, and the rows a
 * run's state folds that the fixtures seed through that run's cell. Any
 * other folded kind has no seeding path here: it does not type-check.
 */
function publish(...drafts: SeedRow[]): void {
  const { log, runHistory } = session();
  const folded = drafts.filter(isCellRow);
  const unfolded = drafts.filter(
    (draft): draft is UnfoldedDraft =>
      !isCellRow(draft) && draft.type !== 'run.activate',
  );
  harnessRuntime.runFork(
    Effect.gen(function* () {
      if (unfolded.length > 0) yield* log.transact(unfolded);
      for (const draft of drafts) {
        const target = aggregateTarget(draft.aggregateId);
        if (draft.type === 'run.activate' && target.kind === 'run')
          yield* runHistory.open(target.id, {
            activation: () => Effect.succeed([draft]),
          });
      }
      for (const [key, rows] of Map.groupBy(folded, (row) => row.aggregateId)) {
        const target = aggregateTarget(key);
        if (target.kind !== 'run')
          return yield* Effect.die(new Error(`${key} is not a run`));
        const cell = yield* runHistory.open(target.id);
        yield* cell.append(rows);
      }
    }),
  );
}

/** The run rows the fixtures seed that a run's state folds. */
type CellRow = Extract<
  SessionRowDraft,
  { type: 'run.config' | 'run.position' | 'request.decided' }
>;
/** What a fixture seeds: a row no run folds, its cell's rows, its opening. */
type SeedRow =
  | UnfoldedDraft
  | CellRow
  | Extract<SessionRowDraft, { type: 'run.activate' }>;
const isCellRow = (draft: SeedRow): draft is CellRow =>
  draft.type === 'run.config' ||
  draft.type === 'run.position' ||
  draft.type === 'request.decided';

// The TUI reads the session fold (PRD 10.1): bind it and subscribe every
// run's transcript tier the way `runChat` does.
HARNESS_DISPOSERS.push(bindSessionView(harnessRuntime, harnessRunSession.view));
{
  // The harness's set, held until it disposes.
  const scope = Scope.makeUnsafe();
  HARNESS_DISPOSERS.push(() =>
    harnessRuntime.runFork(Scope.close(scope, Exit.void)),
  );
  const interest = harnessRuntime.runSync(
    session().view.subscribe([]).pipe(Scope.provide(scope)),
  );
  let subscribed = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = [...currentView().runs.keys()];
    const key = ids.join('\0');
    if (key === subscribed) return;
    subscribed = key;
    harnessRuntime.runFork(
      interest.set(
        ids.map((id) => ({ id: qualifyAggregateId('run', id), fromSeq: 0 })),
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
const harnessRuntimeHost: CliRuntimeHost =
  createCliRuntimeHost(HARNESS_CLI_CONTEXT);
const harnessHostScope = Effect.runSync(Scope.make());
HARNESS_DISPOSERS.push(() =>
  Effect.runSync(Scope.close(harnessHostScope, Exit.void)),
);
Effect.runSync(
  attachInteractions(
    session().interactions,
    createTuiHostInteractions(harnessRuntimeHost, HARNESS_CLI_CONTEXT, {
      requests: {
        request: (req) =>
          session()
            .requests.request(req)
            .pipe(Effect.provide(harnessRuntimeSession)),
        view: {
          current: () => SubscriptionRef.getUnsafe(session().view.ref),
          changes: session().view.changes,
        },
      },
      settings: HARNESS_PLATFORM_SERVICES,
      runtime: harnessRuntime,
    }),
  ).pipe(Scope.provide(harnessHostScope)),
);
HARNESS_DISPOSERS.push(announceForegroundApprovals());

/**
 * The runs this harness has minted. `publish` enqueues a job on the session's one publisher, so the fold — and
 * the view every render reads — lands after the seeding that queued it. A
 * seeder therefore reads what it published from here, never from the view.
 */
const harnessRuns = new Set<RunId>();

/** Mint a run, held here from its birth: its `run.start` existence fact
 *  (PRD 6, item 2), then the `run.config` launch fact a real run publishes
 *  next, which names the model an agent runs on (a child's scrollback
 *  header waits for it). */
function seedRun(
  runId: RunId,
  options: {
    readonly identity?: NonNullable<
      Extract<SessionRowDraft, { type: 'run.start' }>['identity']
    >;
    readonly parentRunId?: RunId;
    /** The agent name for a default (agent) identity; a run id names nothing. */
    readonly agent?: string;
    readonly takesFollowUps?: Extract<
      SessionRowDraft,
      { type: 'run.start' }
    >['takesFollowUps'];
  } = {},
): void {
  if (harnessRuns.has(runId)) return;
  harnessRuns.add(runId);
  holdRun(runId);
  const identity = options.identity ?? {
    kind: 'agent' as const,
    agent: options.agent ?? 'harness-agent',
  };
  publish({
    type: 'run.start',
    aggregateId: qualifyAggregateId('run', runId),
    identity,
    takesFollowUps: options.takesFollowUps ?? true,
    parent:
      options.parentRunId === undefined
        ? null
        : { id: options.parentRunId, call: null },
    provenance: null,
  });
  if (identity.kind === 'agent') {
    publish({
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: identity.agent,
        model: HARNESS_MODEL,
      }),
    });
  }
}

/**
 * The runs held as launches of this session, as the registry holds a run
 * from its birth job until its fiber ends: the view reads them as
 * `runsHere`, which a run needs to read as running or waiting rather than
 * interrupted. A fixture has no fiber, so each hold is one that never ends
 * until the run's terminal row or removal releases it.
 */
const heldRuns = new Map<RunId, Fiber.Fiber<unknown, unknown>>();
function holdRun(runId: RunId): void {
  if (heldRuns.has(runId)) return;
  heldRuns.set(
    runId,
    harnessRuntime.runSync(
      Effect.map(
        registryOf(Context.get(harnessRuntimeSession, Runs)).start(runId, {
          open: Effect.void,
          run: () => Effect.never,
        }),
        ({ fiber }) => fiber,
      ),
    ),
  );
}
function releaseRun(runId: RunId): void {
  const held = heldRuns.get(runId);
  if (held === undefined) return;
  heldRuns.delete(runId);
  harnessRuntime.runFork(Fiber.interrupt(held));
}

/** Where a fixture puts a run: inside a turn, between turns, or ended on
 *  an outcome. */
type SeededStanding = 'running' | 'waiting' | RunOutcome;

/**
 * Place a run the way production does: `run.activate` opens the running
 * window and a `run.position` parks it. An outcome is `run.end`, so a
 * fixture that names one lands there instead.
 *
 * The run window opens at the activation row's publish clock, which the
 * publisher stamps, so a fixture cannot backdate the elapsed time the status
 * bar shows.
 */
function seedStanding(runId: RunId, standing: SeededStanding): void {
  seedRun(runId);
  if (standing !== 'running' && standing !== 'waiting') {
    seedRunEnd(runId, standing);
    return;
  }
  const run = runViewOf(currentView(), runId);
  if (run?.position !== 'running') {
    publish({
      type: 'run.activate',
      aggregateId: qualifyAggregateId('run', runId),
    });
  }
  if (standing === 'waiting') {
    publish({
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'waiting' },
    });
  } else {
    publish({
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
    });
  }
}

/** End a run the way a real session does: the terminal `run.end` fact the
 *  fold turns into the terminal phase and the durable outcome. The run is
 *  looked up in the mint record, not the view: a fixture that seeds a
 *  terminal phase during boot does it before the publisher has folded the
 *  `run.start` it just queued. */
function seedRunEnd(runId: RunId, outcome: RunOutcome): void {
  if (!harnessRuns.has(runId)) {
    throw new Error(`tui-harness: cannot end unknown run ${runId}`);
  }
  releaseRun(runId);
  publish({
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome,
    output: { response: '', files: [] },
  });
}

function seedDescription(runId: RunId, description: string): void {
  publish({
    type: 'run.description',
    by: 'model',
    aggregateId: qualifyAggregateId('run', runId),
    description,
  });
}

function removeRun(runId: RunId): void {
  releaseRun(runId);
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
  readonly data?: JsonValue;
  readonly groupId?: string;
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
    data: toJsonValue({
      toolName: toolUse.toolName,
      input: toolUse.input,
      output: toolUse.outputText,
      summary: toolUse.headerSummary,
      status: toolUse.status,
    }),
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
    [
      '<subagent-result id="child-b" agent="leanSolver" status="completed">',
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
  // The run's transcript stores a delivery as its queue wrote it: the
  // envelope's summary (`FollowUpContent.displayText`), not the envelope.
  for (const [index, text] of followups.entries()) {
    entries.push({
      id: `harness-subagent-followup-${index}`,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + index,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: summarizeSubagentFollowup(text),
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
    offersGrant: true,
    runId: SHOW_SCRIPT_RUNNING
      ? RUNNING_SCRIPT_FIRST_AGENT_RUN_ID
      : HARNESS_RUN_ID,
  };
}

function makeRetryApprovalPayload(): RetryRequest {
  return {
    requestId: `harness-retry-${nanoid()}`,
    runId: HARNESS_RUN_ID,
    operation: 'Model request',
    model: HARNESS_MODEL,
    // The failure as the harness records it: its own plain words, and the
    // facts the modal words in the app's (the plan and its reset).
    errorDetails: RETRY_APPROVAL_CHATGPT
      ? {
          message:
            'Usage limit reached on your OpenAI plan. Resets in 2h. Switch to your own API key to keep working, or wait until the limit resets.',
          classification: {
            kind: 'chatgpt-subscription',
            resetsInMs: 7_200_000,
          },
          provider: 'openai',
          statusCode: 429,
        }
      : {
          message: 'HTTP 429 Too Many Requests',
          // The default stays upstream-credit: that classification requires
          // an explicit user decision before changing credentials, so this
          // fixture remains interactive.
          classification: { kind: 'upstream-credit' },
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

function makePlanApprovalPayload(): PlanApprovalRequest {
  return {
    requestId: 'harness-plan-approval',
    runId: HARNESS_RUN_ID,
    plan: {
      objective: PLAN_APPROVAL_OBJECTIVE,
    },
  };
}

function makeAgentProposalPayload(): AgentProposalRequest {
  // A chat delegation: the schema fills the empty file fields a document
  // task would carry.
  return Schema.decodeUnknownSync(AgentProposalRequestSchema)({
    requestId: 'harness-agent-proposal',
    runId: HARNESS_RUN_ID,
    task: false,
    agent: 'review',
    model: 'deepseek/deepseek-flash',
    instruction: AGENT_PROPOSAL_INSTRUCTION,
    memories: [],
    workingDirectory: HARNESS_CWD,
    offersGrant: true,
    ...(SCRIPT_PROPOSAL
      ? {
          script: {
            title: 'Review and fix chapter 2',
            source: [
              "phase('Review')",
              'const reviews = await Promise.all(',
              "  ['A', 'B'].map((name) =>",
              "    agent(`Review chapter 2 as referee ${name}.`, { agentName: 'review' }),",
              '  ),',
              ')',
            ].join('\n'),
            calls: [{ toolName: 'read_file', preview: 'chapter2.tex' }],
          },
        }
      : {}),
  });
}

/** A finished `agent` call: its card's output is the delivery envelope the
 *  parent's model reads, which no surface prints. */
function seedAgentResultTranscript(): void {
  seedRows(HARNESS_RUN_ID, [
    {
      id: 'agent-result-call',
      level: LOG_LEVELS.INFO,
      timestamp: Date.now(),
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName: 'agent',
        input: { agentName: 'review', prompt: 'Review chapter 2.' },
        output: [
          '<subagent-result id="aaaa0009f10e" agent="review" status="completed">',
          '<wall-time>2m 4s</wall-time>',
          '<response>Lemma 4 needs a bound on the error term.',
          'The rest of chapter 2 reads cleanly.</response>',
          '</subagent-result>',
        ].join('\n'),
        summary: "Completed 'review'",
        status: TOOL_CALL_STATUS.COMPLETED,
      },
    },
  ]);
}

function makeUserQuestionPayload(): UserQuestionRequest {
  return {
    requestId: 'harness-user-question',
    runId: HARNESS_RUN_ID,
    offersGrant: false,
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

/** Open one request the way a run asks (`openRequest`): committed through
 *  the session's log, answered by the surface's `request.decided`. */
const askHarness = (
  runId: RunId,
  payload: RequestPayload,
  blobs?: readonly DraftBlob[],
) =>
  openRequest(runId, payload, {
    ...(blobs && { blobs }),
    commit: (rows) =>
      session()
        .log.transact((tx) => runStateAppend(tx.append)(rows))
        .pipe(Effect.as(session().log.now())),
  }).pipe(Effect.provide(harnessRuntimeSession));

/** One request the way a run asks: `request.opened` on the run, the modal
 *  reads it off the fold, and the surface's `request.decided` answers it. */
function requestHarnessApproval(
  runId: RunId,
  payload: RequestPayload,
  onSettled: (decision: RequestDecision) => void | Promise<void>,
  /** What the payload names by address, stored with the request's row. */
  blobs?: readonly DraftBlob[],
): void {
  void harnessRuntime
    .runPromise(askHarness(runId, payload, blobs))
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
    // A plan run as a goal launches a goal run beside the chat; the chat's
    // own grants stay as they were.
    seedStanding(HARNESS_RUN_ID, 'running');
    appendHarnessAssistantTranscript(
      result.autoApproveAll ? 'PLAN-GOAL-ALL' : 'PLAN-GOAL',
    );
    return;
  }
  appendHarnessAssistantTranscript(
    result.action === 'approve' ? 'PLAN-APPROVED' : 'PLAN-REJECTED',
  );
}

// Queued follow-ups or an active (non-idle) plan simulate an in-flight run;
// an idle plan instead parks the run in a waiting state.
const HARNESS_RUN_ACTIVE =
  QUEUED_FOLLOW_UPS.length > 0 ||
  QUEUED_DELIVERIES.length > 0 ||
  (SHOW_PLAN && !SHOW_IDLE_PLAN);
// A root that has finished a turn and waits, as a real chat after its first
// message: the state an approval grant applies to.
const HARNESS_RUN_IDLE =
  (SHOW_PLAN && SHOW_IDLE_PLAN) || process.env.HARNESS_ROOT_WAITING === '1';

function harnessInitialRunStatus(): SeededStanding | undefined {
  if (HARNESS_RUN_ACTIVE) return 'running';
  if (HARNESS_RUN_IDLE) return 'waiting';
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
  approvalPolicy: APPROVAL_POLICY_DEFAULT,
  teamName: TEAM_NAME,
  version: '0.0.0-harness',
});
// The harness root: minted before any fixture, like a real run's start.
seedRun(HARNESS_RUN_ID);
focusRun(HARNESS_RUN_ID);
rootRunId.set(HARNESS_RUN_ID);
seedRows(HARNESS_RUN_ID, harnessInitialEntries());
// Built as the run's inbox builds them (`queuedRow`), so a delivery carries
// the summary (`displayText`) every surface shows and a message from the user
// is kept as typed.
publish(
  ...[
    ...QUEUED_FOLLOW_UPS.map((text) => ({
      text,
      from: { kind: 'user' as const },
    })),
    ...QUEUED_DELIVERIES.map((text) => ({
      text,
      from: { kind: 'run' as const, runId: DELIVERING_CHILD_RUN_ID },
    })),
  ].map((item, index) => ({
    type: 'followup.queued' as const,
    aggregateId: qualifyAggregateId('run', HARNESS_RUN_ID),
    followUpId: `harness-follow-up-${index + 1}`,
    content: queuedRow(item, undefined, () => 'child').content,
  })),
);
const HARNESS_INITIAL_RUN_STANDING = harnessInitialRunStatus();
if (HARNESS_INITIAL_RUN_STANDING) {
  seedStanding(HARNESS_RUN_ID, HARNESS_INITIAL_RUN_STANDING);
}

if (SHOW_LIVE_TOOL_ONLY) {
  seedLiveToolOnlyTranscript();
}

if (SHOW_SUBAGENT_FOLLOWUPS) {
  seedSubagentFollowupTranscript();
}

if (SHOW_AGENT_RESULT) {
  seedAgentResultTranscript();
}

/** A background script run with two `agent` children still running. */
function seedRunningScript(): void {
  const scriptRunId = harnessRunId('aaaa0002f10e');
  seedRun(scriptRunId, {
    identity: { kind: 'script', title: 'live-script-validation' },
    parentRunId: HARNESS_RUN_ID,
    takesFollowUps: false,
  });
  seedStanding(scriptRunId, 'running');
  for (const agentRunId of [
    RUNNING_SCRIPT_FIRST_AGENT_RUN_ID,
    harnessRunId('aaaa000bf10e'),
  ]) {
    seedRun(agentRunId, {
      identity: { kind: 'agent', agent: 'correct' },
      parentRunId: scriptRunId,
      takesFollowUps: false,
    });
    seedStanding(agentRunId, 'running');
  }
}

function seedRunningProcessChild(): void {
  const childRunId = harnessRunId('aaaa0003f10e');
  seedRun(childRunId, {
    identity: { kind: 'process', tool: 'bash' },
    parentRunId: HARNESS_RUN_ID,
    takesFollowUps: false,
  });
  seedDescription(childRunId, 'sleep 30');
  seedStanding(childRunId, 'running');
  focusRun(childRunId);
}

if (SHOW_CHILDREN) {
  const nestedStrategyChild = {
    runId: harnessRunId('aaaa0004f10e'),
    identity: { kind: 'agent' as const, agent: 'localChecker' },
    agentName: 'localChecker',
    status: 'running',
  };
  const childRuns = [
    {
      runId: harnessRunId('aaaa0005f10e'),
      identity: { kind: 'agent' as const, agent: 'strategy' },
      agentName: 'strategy',
      status: 'running' as SeededStanding,
    },
    {
      runId: harnessRunId('aaaa0006f10e'),
      identity: { kind: 'agent' as const, agent: 'leanSolver' },
      agentName: 'leanSolver',
      status: 'waiting' as SeededStanding,
    },
    {
      runId: harnessRunId('aaaa0007f10e'),
      identity: { kind: 'agent' as const, agent: 'reviewer' },
      agentName: 'reviewer',
      status: 'running' as SeededStanding,
    },
  ].map((child) =>
    child.agentName === FAILED_CHILD_AGENT
      ? { ...child, status: 'failed' as SeededStanding }
      : child,
  );
  // One run window across every later active phase: an activation on a run
  // already running would re-open it, so `seedStanding` keeps the first one.
  seedStanding(HARNESS_RUN_ID, 'running');
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
        usage: { inputTokens: 52_000, outputTokens: 39_900, cost: 0.12 },
      });
    }
    seedStanding(runId, child.status);
  }
  if (SHOW_NESTED_CHILDREN) {
    const nestedRunId = nestedStrategyChild.runId;
    seedRun(nestedRunId, {
      identity: nestedStrategyChild.identity,
      parentRunId: harnessRunId('aaaa0005f10e'),
    });
    seedDescription(nestedRunId, 'localChecker nested proof check');
    seedRows(
      nestedRunId,
      makeChildEntries('localChecker', 'nested proof check'),
    );
    seedStanding(nestedRunId, 'running');
  }
}

if (SHOW_PLAN) {
  publish({
    type: 'plugin.fact',
    aggregateId: qualifyAggregateId('run', HARNESS_RUN_ID),
    plugin: 'goal',
    kind: 'plan',
    version: 1,
    parent: null,
    value: {
      objective: [
        'Coordinate a small math proof through nested CLI work.',
        'Route proof obligations to the right specialist.',
        'Have a subagent inspect the Lean-style finite case.',
      ].join('\n'),
    },
  });
}

if (SHOW_EDIT_APPROVAL) {
  const showApproval = () => {
    const request = makeEditApprovalRequest();
    // The payload and the content `requestToolEditApproval` builds, the
    // content stored with the request's row as it stores it.
    const { hunks } = buildDiffHunks(
      request.originalContent,
      request.proposedContent,
    );
    const lines = countLineChanges(hunks);
    const content: ToolEditContent = {
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
      hunks,
      firstChangedLine: firstChangedLine(hunks, request.proposedContent),
    };
    const text = JSON.stringify(content);
    const permission = {
      requestId: 'harness-edit-approval',
      path: request.path,
      relativePath: request.path,
      sourceTool: request.sourceTool,
      offersGrant: true,
      runId: request.runId,
      addedLines: lines.added,
      removedLines: lines.removed,
      content: blobAddress(text),
    };
    requestHarnessApproval(
      request.runId,
      { kind: 'toolEdit', data: permission },
      () => undefined,
      [{ digest: permission.content, text }],
    );
  };

  showApproval();
}

// The running script exists before its agent asks below: a request names
// a run the fold already holds, the way a real run's does.
if (SHOW_SCRIPT_RUNNING) {
  seedRunningScript();
}

if (SHOW_BASH_APPROVAL) {
  const showApproval = (index = 1) => {
    const permission = makeBashApprovalPayload(index);
    return harnessRuntime.runPromise(
      askHarness(permission.runId, { kind: 'bash', data: permission }),
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
    Effect.flatMap(Secrets, (secrets) =>
      secrets.set(apiKeySecretName('openai'), 'sk-harness-openai-key'),
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
  if (harnessLaunch)
    harnessSession.endLaunch(harnessLaunch, { runId: HARNESS_RUN_ID });
  cancelHarnessRequests('Session interrupted.');
  appendHarnessAssistantTranscript(
    'Harness interrupt requested.',
    HARNESS_RUN_ID,
  );
  for (const runId of descendantRuns(currentView(), HARNESS_RUN_ID, {
    includeRoot: true,
  })) {
    const run = runViewOf(currentView(), runId);
    if (run && run.outcome === null && run.position !== 'ready') {
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
      appendLocalNotice(text, explicitRunId);
      return;
    case 'user':
      appendLocalUserTranscript(text);
      return;
    case 'error':
      appendLocalErrorTranscript(text);
      return;
  }
}

/** The harness chat's launch policy, which `/approval` sets, as the chat's
 *  does; it never writes the project's. */
let harnessPolicy: ApprovalPolicy = APPROVAL_POLICY_DEFAULT;
const harnessApprovalPolicy = (): ApprovalPolicy => harnessPolicy;

function setHarnessApprovalPolicy(policy: ApprovalPolicy): void {
  harnessPolicy = policy;
  sessionMeta.set({
    ...sessionMeta.get(),
    approvalPolicy: policy,
  });
  appendHarnessAssistantTranscript(
    `Approval mode: ${formatApprovalPolicy(policy)}`,
  );
}

function applyHarnessApprovalPolicySelection(
  input: string,
  usage: string,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    const approval = harnessCommands.find('approval');
    if (approval && openRegisteredCliSlashForm(approval)) return;
  }

  const policy = parseApprovalPolicy(normalized);
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
    // The session refuses a message to an agent that takes none.
    if (!acceptsFollowUp(focused)) {
      appendHarnessAssistantTranscript(
        describeFollowUpFailure('notResumable'),
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
      approvalPolicy: harnessApprovalPolicy(),
      approvalBypasses: runBypasses(view, runId),
      statusLabel: run && runStatus(run).word,
      activeChildSessions: runningChildCount(view, run),
      // The harness never commits a `skills.snapshot` row.
      activeSkills: [],
      queuedFollowUpMessages: (view.queuedFollowUps.get(runId) ?? []).map(
        (followUp) => followUp.text,
      ),
      cost: taskCostStatus(view, run),
    }),
  );
}

function resetHarnessForClear(): void {
  const meta = sessionMeta.get();
  cancelHarnessRequests('Session interrupted.');
  for (const runId of [...currentView().runs.keys()]) {
    removeRun(runId);
  }
  // `resetCliState` retires the focus the way the real `/clear` does, and
  // nothing re-focuses a run this reset just removed: the next local row
  // adopts the local-conversation id, which is what the surface renders
  // until a new turn mints a run.
  resetCliState(meta);
  // Mirror the real /clear handler (runChatTui.tsx): erase the terminal
  // outside Ink, then print the scrollback again from a new origin.
  clearTerminalScrollback();
  scrollback.restart();
}

function handleHarnessSlashCommand(line: string): boolean {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const commandName = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  switch (commandName) {
    case 'help':
      appendHarnessAssistantTranscript(
        formatSlashCommandHelp(harnessCommands.list, {
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
      showCliWorkPlan();
      return true;
    case 'clear':
      resetHarnessForClear();
      return true;
    case 'approval':
      applyHarnessApprovalPolicySelection(rest, HARNESS_APPROVAL_USAGE);
      return true;
    default: {
      const command = harnessCommands.find(commandName);
      if (!command) {
        const suggestion = harnessCommands.suggest(commandName);
        const didYouMean = suggestion
          ? ` Did you mean /${suggestion.name}?`
          : '';
        appendHarnessAssistantTranscript(
          `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
        );
        return true;
      }
      if (openRegisteredCliSlashForm(command)) return true;
      appendHarnessAssistantTranscript(
        `/${command.name} is registered but has no harness action.`,
      );
      return true;
    }
  }
}

/** The harness's root-run claim, held the way `texra chat` holds its own. */
const harnessSession = new TuiSession();

const harnessCommands = builtinSlashCommands({
  stores: HARNESS_PLATFORM_SERVICES,
  runtime: HARNESS_PLATFORM_SERVICES.runtime,
  runSession: harnessRunSession,
  onAgentSelect: (agent) => Effect.sync(() => patchSessionMeta({ agent })),
  onTeamSelect: () =>
    Effect.sync(() =>
      setTransientNotice('Teams can only be chosen in `texra chat`.'),
    ),
  onAccountChanged: () => Effect.void,
  onLoginSelect: (value, output) =>
    loginFromChat(value, HARNESS_PLATFORM_SERVICES, undefined, output),
  // Mirror `texra chat`: agent selection is open exactly while no root run
  // is pending.
  canSelectAgent: () => harnessSession.canStartRootRun(),
  canSelectModel: () => CAN_SELECT_MODEL,
  getModelSwitchDisabledReason: (model) =>
    Effect.succeed(
      DISABLED_MODEL_SWITCHES.has(model)
        ? DISABLED_MODEL_SWITCH_REASON
        : undefined,
    ),
  getApprovalPolicy: harnessApprovalPolicy,
  onApprovalPolicySelect: (policy) =>
    Effect.sync(() => setHarnessApprovalPolicy(policy)),
  onProjectApprovalPolicyChanged: (policy) =>
    appendHarnessAssistantTranscript(
      `Project approval policy: ${formatApprovalPolicy(policy)}`,
    ),
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
  configRoots: session().roots,
  onError: (error) => {
    appendHarnessAssistantTranscript(
      `Slash command failed: ${toErrorMessage(error)}`,
    );
  },
});
// An interruptible harness run is a root launch on its way to the session,
// ended when the harness is interrupted, so the status bar derives the
// Ctrl-C stop hint exactly as `texra chat` does.
const harnessLaunch = canInterrupt ? harnessSession.claimLaunch() : undefined;

const inkRef: { current?: ReturnType<typeof render> } = {};
const scrollback = chatScrollback(harnessRuntime, inkRef);
const harnessDraft = harnessRuntime.runSync(SubscriptionRef.make(EMPTY_DRAFT));

function handleHarnessCtrlC(): void {
  if (canInterrupt) {
    markHarnessInterrupted();
    return;
  }
  void exitHarness(0);
}

function renderHarnessApp(): React.JSX.Element {
  return (
    <SlashCommandsProvider value={harnessCommands}>
      <App
        stores={HARNESS_PLATFORM_SERVICES}
        runtime={harnessRuntime}
        session={harnessRunSession}
        draft={harnessDraft}
        onSubmit={(draft) => handleHarnessSubmit(expandText(draft).trim())}
        scrollback={scrollback}
        onCtrlC={handleHarnessCtrlC}
      />
    </SlashCommandsProvider>
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
  const waiting = harnessRunId('eeeeeeeeeeee');
  const interrupted = harnessRunId('ffffffffffff');
  const nested = harnessRunId('111111111111');
  log.emit(PROCESS, 10_000_000, { type: 'run.activate' });
  for (const [id, agent, parentId] of [
    [waiting, 'waiting', null],
    [interrupted, 'interrupted', null],
    [nested, 'nested', interrupted],
  ] as const) {
    log.emit(id, 10_000_000, {
      type: 'run.start',
      identity: { kind: 'agent', agent },
      takesFollowUps: true,
      // The creation commit the database stamps, not a guess: `Log.parent`
      // refuses a parent that never started.
      parent: parentId === null ? null : log.parent(parentId),
      provenance: null,
    });
    log.emit(id, 10_000_000, { type: 'run.activate' });
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
        offersGrant: true,
      },
    },
  });
  const view = viewOf([
    ...events,
    ...log.events.slice(recordedCount).map(tail),
    // `buildScenario` stamped its existence snapshot before these runs
    // existed: re-read the log so the three new aggregates exist. The
    // interrupted root and its child run nowhere any more.
    log.drained(),
    local({ runsHere: [...ALL_RUNS, waiting] }),
  ]);
  const ref = await harnessRuntime.runPromise(SubscriptionRef.make(view));
  HARNESS_DISPOSERS.push(
    bindSessionView(harnessRuntime, {
      current: () => SubscriptionRef.getUnsafe(ref),
      changes: SubscriptionRef.changes(ref),
    }),
  );
  rootRunId.set(interrupted);
  focusRun(PROCESS);
}

const ink = render(renderHarnessApp(), {
  stdout: HARNESS_STDOUT,
  stderr: process.stderr,
  stdin: process.stdin,
  exitOnCtrlC: false,
  // As runChatTui renders, so the frames are the ones a user sees.
  incrementalRendering: true,
});
inkRef.current = ink;

if (SHOW_STREAMING_TOOL_OUTPUT) {
  const fiber = harnessRuntime.runFork(
    Effect.gen(function* () {
      yield* Effect.sleep('1 second');
      seedStanding(HARNESS_RUN_ID, 'running');
      session().log.publish(HARNESS_RUN_ID, {
        type: 'stream.start',
        id: 'streaming-thinking',
        kind: MESSAGE_TYPES.THINKING,
      });
      session().log.publish(HARNESS_RUN_ID, {
        type: 'stream.chunk',
        id: 'streaming-thinking',
        text: 'Checking the streamed calculation.',
      });
      session().log.publish(HARNESS_RUN_ID, {
        type: 'tool.start',
        logId: 'streaming-tool',
        toolName: 'bash',
        input: { command: 'python3 calculation.py' },
      });
      for (let index = 1; index <= 12; index += 1) {
        session().log.publish(HARNESS_RUN_ID, {
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
    scrollback.restart();
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
    await harnessRuntime.dispose();
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', handleHarnessCtrlC);
