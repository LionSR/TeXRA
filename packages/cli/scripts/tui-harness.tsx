// Test harness: seed the session fold with synthetic streams and rows, render
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
import { nanoid } from 'nanoid';
import React from 'react';

import {
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
} from '@agent/index';
import { agentResponseTextConnector } from '@agent/runtime';
import type {
  PlanApprovalResult,
  RetryResult,
} from '@agent/runtime/HostInteractions';
import {
  defaultSession,
  initializeDefaultSession,
} from '@agent/runtime/SessionHandle';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import { planTeamRuns, teamPresets } from '@common/teams/TeamPlan';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_LOG_ENTRY_TYPES,
  TODO_STATUS,
  TOOL_USE_STATUS,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type InquiryThreadId,
  type NormalizedToolUse,
  type PlanApprovalPermission,
  type RetryPermission,
  type StreamPhase,
  type StreamTabId,
  type UserQuestionPermission,
  HISTORY_RUN_STATUS,
} from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import type { SessionEventDraft } from '@shared/schemas/sessionEvent';
import { FOCUSED_BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import { prepareToolEditApprovalPrompt } from '@tools/approval/toolEditApproval';
import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';
import { createRunTrace, StreamLogStore } from '@transcript';
import type { StreamLogAppendInput } from '@transcript/StreamLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { App } from '../src/chat/tui/App';
import { registerBuiltinSlashCommands } from '../src/chat/tui/commands/registerBuiltins';
import { showCliWorkPlan } from '../src/chat/tui/commands/handlers/sessionCommands';
import { cliSettingsStores } from '../src/runtime/settingsStores';
import {
  formatSlashCommandHelp,
  GOAL_MODE_HELP,
} from '../src/chat/tui/commands/helpText';
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
  activeStreamId as activeStreamIdSignal,
  rootRunPending,
  rootRunStreamId,
  rootStreamId,
  resetCliState,
  sessionMeta,
  setCliSessionModelOverride,
} from '../src/chat/tui/state/cliState';
import {
  bindSessionView,
  cumulativeUsageOf,
  currentView,
  focusedChildAcceptsFollowUps,
  runningChildCount,
  sessionView,
  streamViewOf,
} from '../src/chat/tui/state/sessionView';
import { formatCliSessionStatus } from '../src/chat/tui/sessionStatus';
import { notify } from '../src/chat/tui/notifications/terminalNotifier';
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
  resolveLocalTranscriptStreamId,
} from '../src/chat/tui/state/transcript';
import { clearTerminalScrollback } from '../src/tui/terminalCleanup';
import { defaultShortcutModifierLabel } from '../src/runtime/shortcutLabels';
import { OrchestrationApp } from '../src/orchestration/runOrchestrationTui';
import {
  formatCliModelAccessRouteInline,
  resolveCliModelAccessRoute,
} from '../src/runtime/modelAccessRoute';
import { updateCliModelAccess } from '../src/runtime/modelAccessSelection';
import { formatCliAuthStatusLine } from '../src/runtime/apiStatus';
import {
  buildCliAccountAccessItems,
  buildCliAgentItems,
  buildCliOrchestrationItems,
  buildCliResumeItems,
  buildCliTeamItems,
} from '../src/runtime/orchestration';
import { initLocalCliPlatform } from '../src/runtime/initPlatform';
import { saveProviderApiKey } from '../src/runtime/providerApiKey';
import { resolveCliResourcesPath } from '../src/runtime/resourcesPath';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '../src/runtime/cliPresentationHost';
import { setCliToolEnabled } from '../src/runtime/tools';
import type { CliHistoryEntry } from '../src/runtime/history';
import type { CliContext } from '../src/runtime/cliContext';
import type { CliModelAccess } from '../src/runtime/modelAccess';
import type { InputHistory } from '../src/chat/tui/history/inputHistory';

const STREAM_ID = 'harness-stream-1';
const HARNESS_MODEL = 'harness-model';
const RUNNING_WORKFLOW_FIRST_AGENT_STREAM_ID =
  'correct@harness-model#harness-workflow-agent-a' as StreamTabId;
const SHOW_WORKFLOW_RUNNING = process.env.HARNESS_WORKFLOW_RUNNING === '1';
const SHOW_PROCESS_CHILD = process.env.HARNESS_PROCESS_CHILD === '1';
const RESET_WORKFLOW_SCRIPT_DISABLED =
  process.env.HARNESS_WORKFLOW_SCRIPT_DISABLED === '1';
const HARNESS_APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
const HARNESS_YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';
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
const SHOW_EXTERNAL_INQUIRY = process.env.HARNESS_EXTERNAL_INQUIRY === '1';
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
const SHOW_WIDE_FIRST_CHILD_LINE =
  process.env.HARNESS_WIDE_FIRST_CHILD_LINE === '1';
const SHOW_ORCHESTRATION = process.env.HARNESS_ORCHESTRATION === '1';
const SHOW_ORCHESTRATION_STATUS_LINES =
  process.env.HARNESS_ORCHESTRATION_STATUS_LINES !== '0';
const SHOW_BOTH_SUBSCRIPTION_PREFERENCES =
  process.env.HARNESS_BOTH_SUBSCRIPTION_PREFERENCES === '1';
const SHOW_KIMI_CODE_SUBSCRIPTION =
  process.env.HARNESS_KIMI_CODE_SUBSCRIPTION === '1';
const SHOW_ORCHESTRATION_HISTORY =
  process.env.HARNESS_ORCHESTRATION_HISTORY === '1';
const SHOW_NO_RUNNABLE_ORCHESTRATION_MODELS =
  process.env.HARNESS_NO_RUNNABLE_MODELS === '1';
const BASH_APPROVAL_COMMAND =
  process.env.HARNESS_BASH_APPROVAL_COMMAND ?? 'npm run compile:safe';
const SHOW_BASH_APPROVAL_AFTER_CHILD_FOCUS =
  process.env.HARNESS_BASH_APPROVAL_AFTER_CHILD_FOCUS === '1';
const EXTERNAL_INQUIRY_QUESTION =
  process.env.HARNESS_EXTERNAL_INQUIRY_QUESTION ??
  [
    'I need an independent verification of an enumeration of Pythagorean triples.',
    '',
    'Problem: Find all integer triples (a,b,c) with 0 <= a <= b <= c <= 60 and a^2 + b^2 = c^2, whose perimeter is at most 120.',
    '',
    'Please enumerate them independently and verify these results:',
    '',
    'Non-degenerate triples: (3,4,5), (5,12,13), (6,8,10), (7,24,25), (8,15,17), (9,12,15), (9,40,41), (10,24,26), (12,16,20), (12,35,37), (14,48,50), (15,20,25), (15,36,39), (16,30,34), (18,24,30), (20,21,29), (20,48,52), (21,28,35), (24,32,40), (24,45,51), (27,36,45), (30,40,50).',
    '',
    'Degenerate triples: (0,b,b) for 0 <= b <= 60.',
  ].join('\n');
const EXTERNAL_INQUIRY_THREAD_ID = 'ei_123456abcdef' as InquiryThreadId;
const USER_QUESTION_CONTEXT =
  process.env.HARNESS_USER_QUESTION_CONTEXT ??
  [
    'The agent is asking for direction before continuing a math workflow.',
    'We need a choice that keeps the proof useful while avoiding a long detour.',
    'Context detail: the candidate proof has a finite enumeration, a symbolic recurrence, and one unresolved edge case around degenerate triples.',
    'Please answer the questions below so the agent can continue without guessing.',
  ].join('\n');
const AGENT_PROPOSAL_INSTRUCTION =
  process.env.HARNESS_AGENT_PROPOSAL_INSTRUCTION ??
  [
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
  process.env.HARNESS_DISABLED_MODEL_SWITCH_REASON ??
  'different conversation format; start new chat';
const SHOW_CHILDREN = process.env.HARNESS_CHILDREN === '1';
const SHOW_NESTED_CHILDREN = process.env.HARNESS_NESTED_CHILDREN === '1';
const SHOW_TODOS = process.env.HARNESS_TODOS === '1';
const SHOW_IDLE_TODOS = process.env.HARNESS_TODOS_IDLE === '1';
const SHOW_COMPLETED_TODOS_ONLY = process.env.HARNESS_TODOS_COMPLETED === '1';
const FAILED_CHILD_AGENT = process.env.HARNESS_FAILED_CHILD?.trim();
const TEAM_NAME = process.env.HARNESS_TEAM_NAME?.trim() || undefined;
let canInterrupt = process.env.HARNESS_CAN_INTERRUPT === '1';
const HARNESS_INITIAL_APPROVAL_POLICY: TexraApprovalPolicy =
  parseTexraApprovalPolicy(process.env.HARNESS_APPROVAL_POLICY ?? '') ??
  TEXRA_APPROVAL_POLICY_DEFAULT;
const EDIT_APPROVAL_DELAY_MS = Number(
  process.env.HARNESS_EDIT_APPROVAL_DELAY_MS ?? '0',
);
const QUEUED_FOLLOW_UPS = parseList(process.env.HARNESS_QUEUED_FOLLOWUPS);
const HARNESS_CWD_INPUT = process.env.HARNESS_CWD?.trim();
// Keep platform state writes out of the repository unless a scenario opts in.
const HARNESS_CWD =
  HARNESS_CWD_INPUT || mkdtempSync(path.join(tmpdir(), 'texra-tui-harness-'));
const HARNESS_COLOR_ENABLED = process.env.HARNESS_COLOR_ENABLED !== '0';
const HARNESS_RESOURCES_PATH = resolveCliResourcesPath();
const HARNESS_CLI_CONTEXT: CliContext = {
  approvalPolicy: HARNESS_INITIAL_APPROVAL_POLICY,
  cliConfig: {},
  commandName: 'texra',
  configWarnings: [],
  cwd: HARNESS_CWD,
  mode: 'interactive',
  outputFormat: 'text',
  quietLogs: true,
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
if (!HARNESS_CWD_INPUT && process.env.HARNESS_KEEP_CWD !== '1') {
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
        async push(line) {
          HARNESS_INPUT_HISTORY_ENTRIES.push(line);
        },
        reverseFind: () => undefined,
        at: (index) => HARNESS_INPUT_HISTORY_ENTRIES[index],
        length: () => HARNESS_INPUT_HISTORY_ENTRIES.length,
      };

if (SHOW_PROJECT_SKILL) {
  seedHarnessProjectSkill();
}

await initLocalCliPlatform({
  cwd: HARNESS_CWD,
  installSignalHandlers: false,
  resourcesPath: HARNESS_RESOURCES_PATH,
  storageRoot: path.join(HARNESS_CWD, '.texra-storage'),
  skillSourceOptions: {},
  version: '0.0.0-harness',
});
if (RESET_WORKFLOW_SCRIPT_DISABLED) {
  await setCliToolEnabled('workflow-script', false);
}
// Seed workspace-storage memory files so `/memory` has rows to list. Files
// get descending mtimes in list order, so the first name is the newest row
// and the listing order is deterministic.
if (HARNESS_MEMORY_FILES.length > 0) {
  const memoryRoot = path.join(workspaceRoots().storage, MEMORY_STORAGE_DIR);
  const newestEpochSeconds = Date.now() / 1000;
  HARNESS_MEMORY_FILES.forEach((name, index) => {
    const filePath = path.join(memoryRoot, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `Harness memory ${name}.\n`);
    const mtime = newestEpochSeconds - index * 60;
    utimesSync(filePath, mtime, mtime);
  });
}
const harnessRuntimeSession = initializeDefaultSession({
  transcripts: await StreamLogStore.open(),
  responseTextProcessing: createTexraResponseTextProcessing(
    agentResponseTextConnector,
  ),
});
harnessRuntimeSession.setApprovalPolicy(HARNESS_INITIAL_APPROVAL_POLICY);
const harnessFollowUpLease = defaultSession().followUps.claimLive(
  STREAM_ID,
  'flow',
)!;
const harnessFollowUpQueue =
  defaultSession().followUps.queue(harnessFollowUpLease);
for (const followUp of QUEUED_FOLLOW_UPS) {
  harnessFollowUpQueue.enqueue({ text: followUp });
}
if (
  process.env.HARNESS_VISIBLE_TOOL_USE_AGENTS !== undefined ||
  process.env.HARNESS_VISIBLE_WORKFLOW_AGENTS !== undefined
) {
  await workspaceRoots().workspaceState.update(
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
  );
}
if (process.env.HARNESS_VISIBLE_MODELS !== undefined) {
  await platform().globalState.update(
    GlobalStateKey.ENABLED_MODELS,
    HARNESS_VISIBLE_MODELS,
  );
}
await loadAgents({ includeRemote: false });

// Models the production boundary: `listCliHistoryEntries` already applies
// `isUserVisibleExecution`, so menu builders only ever see user-started rows.
const HARNESS_ORCHESTRATION_HISTORY: readonly CliHistoryEntry[] =
  SHOW_ORCHESTRATION_HISTORY
    ? [
        {
          id: 'cccccccccccc' as ExecutionId,
          timestamp: '2026-06-06T00:02:00Z',
          agent: 'orchestrator',
          model: HARNESS_MODEL,
          status: HISTORY_RUN_STATUS.RESUMABLE,
          resumable: true,
          inputBasename: '-',
          category: AgentCategory.ToolUse,
        },
      ]
    : [];
const HARNESS_VISIBLE_TOOL_USE_AGENT_ENTRIES = getVisibleAgents(
  AgentCategory.ToolUse,
);
const HARNESS_ALL_TOOL_USE_AGENTS = getAgentsByCategory(AgentCategory.ToolUse);
const HARNESS_PRESET_PLANS = planTeamRuns(teamPresets(undefined), {
  agents: {
    workflow: getAgentsByCategory(AgentCategory.Workflow),
    toolUse: HARNESS_ALL_TOOL_USE_AGENTS,
  },
});
const HARNESS_MODEL_ACCESS =
  SHOW_BOTH_SUBSCRIPTION_PREFERENCES || SHOW_KIMI_CODE_SUBSCRIPTION
    ? {
        preferences: {
          chatGpt: SHOW_BOTH_SUBSCRIPTION_PREFERENCES
            ? ('on' as const)
            : ('off' as const),
          // Grok stays off in the dual-subscription harness so ChatGPT + Kimi
          // remain the visible "on" pair (Grok still appears as a row).
          grok: 'off' as const,
        },
        codingPlans: {
          kimiCode: { preferred: true, keySet: true },
          glmCodingPlan: { preferred: false, keySet: true },
        },
        chatGptSignedIn: SHOW_BOTH_SUBSCRIPTION_PREFERENCES,
        ...(SHOW_BOTH_SUBSCRIPTION_PREFERENCES
          ? { chatGptAccountLabel: 'harness@example.edu' }
          : {}),
        grokSignedIn: false,
        texraSignedIn: false,
      }
    : undefined;
const HARNESS_ORCHESTRATION_ITEMS = buildCliOrchestrationItems({
  presetPlans: HARNESS_PRESET_PLANS,
  history: HARNESS_ORCHESTRATION_HISTORY,
  toolUseAgents: HARNESS_VISIBLE_TOOL_USE_AGENT_ENTRIES,
  accountAccess: HARNESS_MODEL_ACCESS,
});
const HARNESS_ORCHESTRATION_ACCOUNT_ACCESS_ITEMS = HARNESS_MODEL_ACCESS
  ? buildCliAccountAccessItems(HARNESS_MODEL_ACCESS)
  : undefined;
const HARNESS_ORCHESTRATION_RESUME_ITEMS = buildCliResumeItems(
  HARNESS_ORCHESTRATION_HISTORY,
);
const HARNESS_ORCHESTRATION_AGENT_ITEMS = buildCliAgentItems(
  HARNESS_VISIBLE_TOOL_USE_AGENT_ENTRIES,
);
const HARNESS_ORCHESTRATION_TEAM_ITEMS = buildCliTeamItems(
  HARNESS_PRESET_PLANS,
  {
    includeLoginHint: true,
    remoteAgentCatalogAvailable: false,
  },
);

type HarnessModelFixture = Readonly<{
  value: string;
  label: string;
  availability: NonNullable<CliModelAccess['model']['availability']>;
  provider?: string;
}>;

const HARNESS_ORCHESTRATION_MODEL_FIXTURES: readonly HarnessModelFixture[] = [
  {
    value: 'sonnet46T',
    label: 'Sonnet 4.6 (Thinking)',
    availability: 'provider-key',
  },
  { value: 'gpt54', label: 'GPT-5.4', availability: 'provider-key' },
  {
    value: 'deepseekT',
    label: 'DeepSeek V4 Flash',
    availability: 'provider-key',
  },
  ...(SHOW_KIMI_CODE_SUBSCRIPTION
    ? [
        {
          value: 'kimi3',
          label: 'Kimi K3',
          availability: 'provider-key' as const,
          provider: 'kimiCode',
        },
      ]
    : []),
];

function harnessModelStatus(
  availability: HarnessModelFixture['availability'],
): string {
  switch (availability) {
    case 'provider-key':
      return 'api key set';
    case 'openrouter-key':
      return 'openrouter key set';
    default:
      return availability.replaceAll('-', ' ');
  }
}

function harnessOrchestrationModels(): readonly CliModelAccess[] {
  return HARNESS_ORCHESTRATION_MODEL_FIXTURES.map((fixture) => ({
    model: fixture,
    available: SHOW_NO_RUNNABLE_ORCHESTRATION_MODELS
      ? false
      : fixture.availability === 'provider-key' ||
        fixture.availability === 'openrouter-key',
    status: SHOW_NO_RUNNABLE_ORCHESTRATION_MODELS
      ? 'missing key'
      : harnessModelStatus(fixture.availability),
  }));
}

if (SHOW_ORCHESTRATION) {
  const instance = render(
    <OrchestrationApp
      items={HARNESS_ORCHESTRATION_ITEMS}
      resumeItems={HARNESS_ORCHESTRATION_RESUME_ITEMS}
      agentItems={HARNESS_ORCHESTRATION_AGENT_ITEMS}
      teamItems={HARNESS_ORCHESTRATION_TEAM_ITEMS}
      models={process.env.HARNESS_API_MODE ? harnessOrchestrationModels() : []}
      accountAccessItems={HARNESS_ORCHESTRATION_ACCOUNT_ACCESS_ITEMS}
      version="0.0.0-harness"
      statusLines={
        SHOW_ORCHESTRATION_STATUS_LINES
          ? [
              `api: ${formatCliModelAccessRouteInline('personal')}`,
              formatCliAuthStatusLine({ authenticated: false }),
            ]
          : undefined
      }
      allowDefaultModelLaunch={false}
      onResolve={() => undefined}
    />,
    {
      stdout: HARNESS_STDOUT,
      stderr: process.stderr,
      stdin: process.stdin,
    },
  );
  await instance.waitUntilExit();
  process.exit(0);
}

// =========================================================================
// Fold seeding: every fixture is a session fact
// =========================================================================

const HARNESS_DISPOSERS: Array<() => void> = [];

/** The session every fixture publishes into and the TUI renders. */
function session() {
  return defaultSession();
}

function publish(...drafts: SessionEventDraft[]): void {
  session().publish(drafts);
}

// The TUI reads the session fold (PRD 10.1): bind it and subscribe every
// stream's transcript tier the way `runChat` does.
HARNESS_DISPOSERS.push(bindSessionView(session().view));
{
  let subscribed = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = [...currentView().streams.keys()];
    const key = ids.join('\0');
    if (key === subscribed) return;
    subscribed = key;
    session().setTranscriptSubscriptions(
      'tui-harness',
      ids.map((id) => ({ id, fromSeq: 0 })),
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
HARNESS_DISPOSERS.push(
  session().interactions.use(
    createTuiHostInteractions(harnessRuntimeHost, HARNESS_CLI_CONTEXT),
  ),
);
HARNESS_DISPOSERS.push(announceForegroundApprovals());

const harnessStreams = new Set<StreamTabId>();

/** Mint a stream: its `run.start` existence fact (PRD 6, item 2), then the
 *  `run.config` launch fact a real run publishes next, which names the model
 *  an agent runs on (a child's scrollback header waits for it). */
function seedStream(
  streamId: StreamTabId,
  options: {
    readonly category?: AgentCategory;
    readonly identity?: NonNullable<
      Extract<SessionEventDraft, { type: 'run.start' }>['identity']
    >;
    readonly parentStreamId?: StreamTabId;
    readonly executionId?: string;
    readonly userFollowUpSupport?: Extract<
      SessionEventDraft,
      { type: 'run.start' }
    >['userFollowUpSupport'];
  } = {},
): void {
  if (harnessStreams.has(streamId)) return;
  harnessStreams.add(streamId);
  const executionId = (options.executionId ?? nanoid(12)) as ExecutionId;
  const identity = options.identity ?? {
    kind: 'agent' as const,
    agent: streamId.split('#')[0] ?? streamId,
  };
  publish({
    type: 'run.start',
    aggregateId: streamId,
    executionId,
    identity,
    category: options.category ?? AgentCategory.ToolUse,
    isRemote: false,
    userFollowUpSupport:
      options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    ...(options.parentStreamId === undefined
      ? {}
      : { parentStreamId: options.parentStreamId }),
  });
  if (identity.kind === 'agent') {
    publish({
      type: 'run.config',
      aggregateId: streamId,
      executionId,
      config: { model: HARNESS_MODEL },
    });
  }
}

/** Place a stream in a phase: the status fact every renderer folds. */
function seedPhase(
  streamId: StreamTabId,
  phase: StreamPhase,
  runStartedAt?: number,
): void {
  seedStream(streamId);
  publish({
    type: 'status',
    aggregateId: streamId,
    phase,
    cause: 'harness',
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
  });
}

function seedDescription(streamId: StreamTabId, description: string): void {
  publish({
    type: 'updateStreamDescription',
    aggregateId: streamId,
    description,
  });
}

function removeStream(streamId: StreamTabId): void {
  publish({ type: 'stream.removed', aggregateId: streamId });
  harnessStreams.delete(streamId);
}

/** Append settled rows to a stream's transcript; the store's change feed
 *  publishes them as `transcript.entry` facts the fold projects. */
function seedRows(
  streamId: StreamTabId,
  entries: readonly StreamLogAppendInput[],
): void {
  seedStream(streamId);
  const writer = session().transcripts.acquireWriter(streamId, 'tui-harness');
  for (const entry of entries) writer.appendSettled(entry);
  writer.close();
}

/** Every stream under `rootId`, the root first. */
function descendantsOf(rootId: StreamTabId): StreamTabId[] {
  const view = currentView();
  const out: StreamTabId[] = [];
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.shift()!;
    const stream = view.streams.get(id);
    if (!stream) continue;
    out.push(id);
    pending.push(...stream.childIds);
  }
  return out;
}

/** A text entry the transcript store settles and the fold projects. */
function harnessTextRow(
  id: string,
  kind: 'assistant' | 'error' | 'user',
  text: string,
  seqNo: number,
): StreamLogAppendInput {
  const messageType = {
    user: MESSAGE_TYPES.USER_MESSAGE,
    error: MESSAGE_TYPES.ERROR,
    assistant: MESSAGE_TYPES.MODEL_RESPONSE,
  }[kind];
  return {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: kind === 'error' ? LOG_LEVELS.ERROR : LOG_LEVELS.INFO,
    timestamp: seqNo,
    messageType,
    text,
  };
}

function makeEntries(count: number): StreamLogAppendInput[] {
  const entries: StreamLogAppendInput[] = [];
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
    isError: false,
    isUserFeedback: false,
    headerSummary: 'python3 enumerate_triples.py',
    status: TOOL_USE_STATUS.COMPLETED,
  };
}

/** A tool entry the fold projects into a tool row. */
function harnessToolEntry(
  id: string,
  toolUse: NormalizedToolUse,
  seqNo = 2,
): StreamLogAppendInput {
  return {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: seqNo,
    messageType: MESSAGE_TYPES.TOOL_USE,
    data: {
      toolName: toolUse.toolName,
      input: toolUse.input,
      output: toolUse.outputText,
      summary: toolUse.headerSummary,
      isError: toolUse.isError,
      status: toolUse.status,
    },
  };
}

function makeLongToolOutputEntries(): StreamLogAppendInput[] {
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

function makeAssistantToolPreambleEntries(): StreamLogAppendInput[] {
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
        isError: false,
        isUserFeedback: false,
        headerSummary: 'Read README.md',
        status: TOOL_USE_STATUS.COMPLETED,
      },
      3,
    ),
  ];
}

function seedLiveToolOnlyTranscript(): void {
  const store = defaultSession().transcripts;
  const writer = store.acquireWriter(STREAM_ID, 'tui-harness');
  const timestamp = Date.now();
  writer.append({
    id: 'live-tool-user',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    text: 'what is this repo about',
  });
  writer.append({
    id: 'live-tool-empty-assistant',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
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
    writer.append({
      id: `live-tool-${toolName}-${index}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + 2 + index,
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName,
        input,
        output: '',
        summary,
        isError: false,
        status: TOOL_USE_STATUS.COMPLETED,
      },
    });
  }
  writer.close();
}

function makeRejectedBashToolEntries(): StreamLogAppendInput[] {
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
      isError: true,
      isUserFeedback: false,
      headerSummary: command,
      status: TOOL_USE_STATUS.COMPLETED,
    }),
  ];
}

function seedSubagentFollowupTranscript(): void {
  const store = defaultSession().transcripts;
  const writer = store.acquireWriter(STREAM_ID, 'tui-harness');
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
    writer.append({
      id: `harness-subagent-followup-${index}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + index,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: `<orchestrator-followup>${text}</orchestrator-followup>`,
    });
  }
  writer.close();
}

function makeChildEntries(
  agent: string,
  action: string,
): StreamLogAppendInput[] {
  const assistantText =
    SHOW_LONG_CHILD_OUTPUT && agent === 'strategy'
      ? Array.from({ length: 18 }, (_, index) =>
          index === 0 && SHOW_WIDE_FIRST_CHILD_LINE
            ? `strategy detail line 01 ${'wide output wraps '.repeat(10)}`
            : `strategy detail line ${String(index + 1).padStart(2, '0')}${index === 17 ? ' final contradiction found' : ''}`,
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
      streamId: STREAM_ID,
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
    streamId: STREAM_ID,
  };
}

function makeBashApprovalPayload(index = 1) {
  return {
    requestId:
      index === 1 ? 'harness-bash-approval' : `harness-bash-approval-${index}`,
    command: BASH_APPROVAL_COMMAND,
    cwd: HARNESS_CWD,
    allowBypass: true,
    streamId: SHOW_WORKFLOW_RUNNING
      ? RUNNING_WORKFLOW_FIRST_AGENT_STREAM_ID
      : STREAM_ID,
  };
}

function makeRetryApprovalPayload(): RetryPermission {
  return {
    requestId: `harness-retry-${nanoid()}`,
    streamId: STREAM_ID,
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
  };
}

function makePlanApprovalPayload(): PlanApprovalPermission {
  return {
    requestId: 'harness-plan-approval',
    streamId: STREAM_ID,
    goalEnabled: PLAN_APPROVAL_GOAL,
    plan: {
      objective: PLAN_APPROVAL_OBJECTIVE,
    },
  };
}

function makeAgentProposalPayload() {
  return {
    requestId: 'harness-agent-proposal',
    streamId: STREAM_ID,
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
    streamId: STREAM_ID,
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

/** One request through the session's port: the runtime publishes its
 *  `approval.requested`, the modal reads the fold, the decision settles it. */
function requestHarnessApproval<T>(
  request: () => Promise<T> | undefined,
  onSettled: (result: T) => void | Promise<void>,
): void {
  const result = request();
  if (!result) return;
  void result.then(onSettled).catch((error: unknown) => {
    appendLocalErrorTranscript(
      `Harness approval failed: ${toErrorMessage(error)}`,
    );
  });
}

function appendHarnessExternalInquiryContinuation(
  status: 'answered' | 'dropped',
  answer?: string,
): void {
  appendHarnessTranscript(
    'user',
    buildContinuationText({
      event: status,
      threadId: EXTERNAL_INQUIRY_THREAD_ID,
      question: EXTERNAL_INQUIRY_QUESTION,
      ...(answer ? { answer } : {}),
      stillOpen: [],
    }),
  );
}

function appendHarnessRetryResult(
  result: RetryResult,
  credentialSelection: 'configured' | 'personal' | undefined,
): void {
  if (result.action === 'retry' && credentialSelection === 'personal') {
    appendHarnessAssistantTranscript('RETRY-PERSONAL-CREDENTIALS');
    return;
  }
  appendHarnessAssistantTranscript(
    result.action === 'retry' ? 'RETRY-APPROVED' : 'RETRY-REJECTED',
  );
}

async function appendHarnessPlanDecision(
  result: PlanApprovalResult,
): Promise<void> {
  if (result.action === 'approve_and_goal') {
    await GoalStore.start(STREAM_ID, PLAN_APPROVAL_OBJECTIVE);
    seedPhase(STREAM_ID, STREAM_PHASE.RUNNING);
    appendHarnessAssistantTranscript('PLAN-GOAL');
    return;
  }
  appendHarnessAssistantTranscript(
    result.action === 'approve' ? 'PLAN-APPROVED' : 'PLAN-REJECTED',
  );
}

// Queued follow-ups or active (non-idle) todos simulate an in-flight run;
// idle todos instead park the stream in a waiting state.
const HARNESS_RUN_ACTIVE =
  QUEUED_FOLLOW_UPS.length > 0 || (SHOW_TODOS && !SHOW_IDLE_TODOS);
const HARNESS_RUN_IDLE = SHOW_TODOS && SHOW_IDLE_TODOS;

function harnessInitialStreamStatus(): StreamPhase | undefined {
  if (HARNESS_RUN_ACTIVE) return STREAM_PHASE.RUNNING;
  if (HARNESS_RUN_IDLE) return STREAM_PHASE.WAITING;
  return undefined;
}

function harnessInitialEntries(): StreamLogAppendInput[] {
  if (SHOW_REJECTED_BASH_TOOL) return makeRejectedBashToolEntries();
  if (SHOW_LONG_TOOL_OUTPUT) return makeLongToolOutputEntries();
  if (SHOW_ASSISTANT_TOOL_PREAMBLE) return makeAssistantToolPreambleEntries();
  if (SHOW_LIVE_TOOL_ONLY) return [];
  return makeEntries(ENTRY_COUNT);
}

sessionMeta.set({
  agent: 'chat',
  model: HARNESS_MODEL,
  modelSource: 'builtin-default',
  cwd: HARNESS_CWD,
  approvalPolicy: HARNESS_INITIAL_APPROVAL_POLICY,
  transcriptMode: 'persistent',
  teamName: TEAM_NAME,
  version: '0.0.0-harness',
});
// The harness root: minted before any fixture, like a real run's start.
seedStream(STREAM_ID);
activeStreamIdSignal.set(STREAM_ID);
rootStreamId.set(STREAM_ID);
seedRows(STREAM_ID, harnessInitialEntries());
if (QUEUED_FOLLOW_UPS.length > 0) {
  publish({
    type: 'updateQueuedFollowUps',
    aggregateId: STREAM_ID,
    messages: QUEUED_FOLLOW_UPS,
  });
}
const HARNESS_INITIAL_STREAM_STATUS = harnessInitialStreamStatus();
if (HARNESS_INITIAL_STREAM_STATUS) {
  seedPhase(
    STREAM_ID,
    HARNESS_INITIAL_STREAM_STATUS,
    // Backdated so the status bar shows a plausible elapsed time.
    HARNESS_RUN_ACTIVE ? Date.now() - 42_000 : undefined,
  );
}

if (SHOW_LIVE_TOOL_ONLY) {
  seedLiveToolOnlyTranscript();
}

if (SHOW_SUBAGENT_FOLLOWUPS) {
  seedSubagentFollowupTranscript();
}

function seedRunningWorkflow(): void {
  const executionId = 'aaaa0002f10e' as ExecutionId;
  const childStreamId = 'workflow-script#aaaa0002f10e' as StreamTabId;
  const firstAgentStreamId = RUNNING_WORKFLOW_FIRST_AGENT_STREAM_ID;
  const secondAgentStreamId =
    'correct@harness-model#harness-workflow-agent-b' as StreamTabId;
  seedStream(childStreamId, {
    category: AgentCategory.Workflow,
    identity: {
      kind: 'multiAgentWorkflow',
      workflowName: 'live-workflow-validation',
    },
    executionId,
    parentStreamId: STREAM_ID,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
  });
  seedPhase(childStreamId, STREAM_PHASE.RUNNING);
  const runTrace = createRunTrace(childStreamId, session().transcripts);
  const runStage = runTrace.trace.openStage(
    "Workflow script 'live-workflow-validation'",
    {
      id: 'harness-workflow-running-run',
      kind: 'run',
    },
  );
  const phaseStage = runTrace.trace.openStage('Proofread', {
    id: 'harness-workflow-running-phase',
    index: 0,
    kind: 'phase',
    parent: runStage,
    total: 1,
  });
  runTrace.trace.emit({
    type: 'workflow.call',
    logId: 'harness-workflow-running-task-a',
    call: {
      id: 'proofread-a',
      label: 'Proofread paper A',
      phase: 'Proofread',
      status: 'running',
      childStreamId: firstAgentStreamId,
    },
    stageId: phaseStage.id,
  });
  runTrace.trace.emit({
    type: 'workflow.call',
    logId: 'harness-workflow-running-task-b',
    call: {
      id: 'proofread-b',
      label: 'Proofread paper B',
      phase: 'Proofread',
      status: 'running',
      childStreamId: secondAgentStreamId,
    },
    stageId: phaseStage.id,
  });
  for (const [agentStreamId, agentExecutionId] of [
    [firstAgentStreamId, 'harness-workflow-agent-a'],
    [secondAgentStreamId, 'harness-workflow-agent-b'],
  ] as const) {
    seedStream(agentStreamId, {
      category: AgentCategory.Workflow,
      identity: { kind: 'agent', agent: 'correct' },
      executionId: agentExecutionId,
      parentStreamId: childStreamId,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    });
    seedPhase(agentStreamId, STREAM_PHASE.RUNNING);
  }
  HARNESS_DISPOSERS.push(() => {
    phaseStage.end('cancelled');
    runStage.end('cancelled');
    runTrace.dispose();
  });
}

function seedRunningProcessChild(): void {
  const childStreamId = 'bash#aaaa0003f10e' as StreamTabId;
  seedStream(childStreamId, {
    identity: { kind: 'process', tool: 'bash' },
    executionId: 'aaaa0003f10e',
    parentStreamId: STREAM_ID,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
  });
  seedDescription(childStreamId, 'sleep 30');
  seedPhase(childStreamId, STREAM_PHASE.RUNNING);
  activeStreamIdSignal.set(childStreamId);
}

if (SHOW_CHILDREN) {
  const startedAt = Date.now() - 74_000;
  const nestedStartedAt = startedAt + 24_000;
  const nestedStrategyChild = {
    executionId: 'harness-nested-local-checker',
    identity: { kind: 'agent' as const, agent: 'localChecker' },
    agentName: 'localChecker',
    childStreamId: 'harness-nested-local-checker-stream',
    status: STREAM_PHASE.RUNNING,
    startedAt: nestedStartedAt,
  };
  const childStreams = [
    {
      executionId: 'harness-child-strategy',
      identity: { kind: 'agent' as const, agent: 'strategy' },
      agentName: 'strategy',
      childStreamId: 'harness-child-strategy-stream',
      status: STREAM_PHASE.RUNNING,
      startedAt,
    },
    {
      executionId: 'harness-child-lean',
      identity: { kind: 'agent' as const, agent: 'leanSolver' },
      agentName: 'leanSolver',
      childStreamId: 'harness-child-lean-stream',
      status: STREAM_PHASE.WAITING,
      startedAt: startedAt - 123_000,
    },
    {
      executionId: 'harness-child-review',
      identity: { kind: 'agent' as const, agent: 'reviewer' },
      agentName: 'reviewer',
      childStreamId: 'harness-child-review-stream',
      status: STREAM_PHASE.RUNNING,
      startedAt: startedAt + 12_000,
    },
  ].map((child) =>
    child.agentName === FAILED_CHILD_AGENT
      ? {
          ...child,
          status: STREAM_PHASE.FAILED,
          startedAt: undefined,
        }
      : child,
  );
  seedPhase(
    STREAM_ID,
    STREAM_PHASE.RUNNING,
    // One run window across every later active phase: a scenario that
    // already seeded an initial RUNNING keeps that backdated start.
    streamViewOf(currentView(), STREAM_ID)?.runStartedAt ?? startedAt,
  );
  for (const child of childStreams) {
    const streamId = child.childStreamId as StreamTabId;
    seedStream(streamId, {
      identity: child.identity,
      executionId: child.executionId,
      parentStreamId: STREAM_ID,
    });
    seedDescription(streamId, `${child.agentName} sub-workflow`);
    seedRows(streamId, makeChildEntries(child.agentName, child.executionId));
    // One child carries usage so scenarios pin the row metadata column's
    // generated-token figure (`↓40k`).
    if (child.agentName === 'reviewer') {
      publish({
        type: 'usage',
        aggregateId: streamId,
        storageKey: child.executionId as ExecutionId,
        usage: { inputTokens: 52_000, outputTokens: 39_900, cost: 0.12 },
      });
    }
    if (child.status !== undefined) {
      seedPhase(
        streamId,
        child.status,
        child.status === STREAM_PHASE.RUNNING ? child.startedAt : undefined,
      );
    }
  }
  if (SHOW_NESTED_CHILDREN) {
    const nestedStreamId = nestedStrategyChild.childStreamId as StreamTabId;
    seedStream(nestedStreamId, {
      identity: nestedStrategyChild.identity,
      executionId: nestedStrategyChild.executionId,
      parentStreamId: 'harness-child-strategy-stream' as StreamTabId,
    });
    seedDescription(nestedStreamId, 'localChecker nested proof check');
    seedRows(
      nestedStreamId,
      makeChildEntries('localChecker', 'nested proof check'),
    );
    seedPhase(nestedStreamId, STREAM_PHASE.RUNNING, nestedStartedAt);
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
    { type: 'updateTodos', aggregateId: STREAM_ID, todos: [...workPlan.todos] },
    { type: 'updatePlan', aggregateId: STREAM_ID, plan: workPlan.plan },
  );
}

if (SHOW_EDIT_APPROVAL) {
  const showApproval = () => {
    const request = makeEditApprovalRequest();
    requestHarnessApproval(
      () =>
        session().interactions.requestToolEditApproval({
          ...request,
          permission: prepareToolEditApprovalPrompt(session(), {
            requestId: 'harness-edit-approval',
            request,
            relativePath: request.path,
          }),
        }),
      () => undefined,
    );
  };

  if (EDIT_APPROVAL_DELAY_MS > 0) {
    globalThis.setTimeout(showApproval, EDIT_APPROVAL_DELAY_MS);
  } else {
    showApproval();
  }
}

// The running workflow exists before its agent asks below: a request names
// a stream the fold already holds, the way a real run's does.
if (SHOW_WORKFLOW_RUNNING) {
  seedRunningWorkflow();
}

if (SHOW_BASH_APPROVAL) {
  const showApproval = (index = 1) => {
    const permission = makeBashApprovalPayload(index);
    const streamId = permission.streamId as StreamTabId;
    return session().interactions.requestBashApproval({
      streamId,
      command: permission.command,
      permission,
    });
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
      const activeStreamId = activeStreamIdSignal.get();
      if (activeStreamId === undefined || activeStreamId === STREAM_ID) {
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
  await saveProviderApiKey('openai', 'sk-harness-openai-key');
  let credentialSelection: 'configured' | 'personal' | undefined;
  requestHarnessApproval(
    () =>
      session().interactions.requestRetry(makeRetryApprovalPayload(), {
        prepareRetry: async (selection) => {
          credentialSelection = selection;
        },
      }),
    (result) => appendHarnessRetryResult(result, credentialSelection),
  );
}
if (SHOW_EXTERNAL_INQUIRY) {
  // The tool opens the thread with the host, then publishes its listing
  // fact; the continuation the agent would receive is mirrored here once
  // the thread settles in the fold.
  void session().interactions.openExternalInquiry({
    requestId: 'harness-external-inquiry',
    question: EXTERNAL_INQUIRY_QUESTION,
    threadId: EXTERNAL_INQUIRY_THREAD_ID,
    allowBypass: false,
    streamId: STREAM_ID,
    sessionLinks: null,
    draft: null,
    transcript: null,
  });
  publish({
    type: 'inquiryThreadUpdated',
    aggregateId: EXTERNAL_INQUIRY_THREAD_ID,
    threadId: EXTERNAL_INQUIRY_THREAD_ID,
    parentStreamId: STREAM_ID,
    status: 'open',
    lastQuestionPreview: EXTERNAL_INQUIRY_QUESTION.slice(0, 80),
    lastActivityIso: new Date().toISOString(),
    turnCount: 1,
  });
  let reported = false;
  HARNESS_DISPOSERS.push(
    subscribeToSignalChanges([sessionView()], () => {
      if (reported) return;
      const thread = currentView().inquiries.find(
        (entry) => entry.threadId === EXTERNAL_INQUIRY_THREAD_ID,
      );
      if (!thread || thread.status === 'open') return;
      reported = true;
      appendHarnessExternalInquiryContinuation(thread.status);
    }),
  );
}
if (SHOW_USER_QUESTION) {
  requestHarnessApproval(
    () => session().interactions.askUserQuestion(makeUserQuestionPayload()),
    () => undefined,
  );
}
if (SHOW_PLAN_APPROVAL) {
  requestHarnessApproval(
    () => session().interactions.requestPlanApproval(makePlanApprovalPayload()),
    appendHarnessPlanDecision,
  );
}

if (SHOW_AGENT_PROPOSAL) {
  requestHarnessApproval(
    () =>
      session().interactions.requestAgentProposal(makeAgentProposalPayload()),
    () => undefined,
  );
}

function markHarnessInterrupted(): void {
  canInterrupt = false;
  rootRunPending.set(false);
  session().interactions.cancel({ cause: 'Session interrupted.' });
  appendHarnessAssistantTranscript('Harness interrupt requested.', STREAM_ID);
  for (const streamId of descendantsOf(STREAM_ID)) {
    const stream = streamViewOf(currentView(), streamId);
    if (stream && isInFlightPhase(stream.status)) {
      seedPhase(streamId, STREAM_PHASE.CANCELLED);
    }
  }
}

function markHarnessStreamInterrupted(streamId: StreamTabId): void {
  session().interactions.cancel({ streamId, cause: 'Run interrupted.' });
  if (streamId === STREAM_ID) {
    canInterrupt = false;
    rootRunPending.set(false);
  }
  appendHarnessAssistantTranscript(
    `Harness focused interrupt requested for ${streamId}.`,
    streamId,
  );
  seedPhase(streamId, STREAM_PHASE.CANCELLED);
}

function appendHarnessAssistantTranscript(
  text: string,
  streamId?: StreamTabId,
): void {
  appendHarnessTranscript('assistant', text, streamId);
}

function appendHarnessTranscript(
  role: 'assistant' | 'error' | 'user',
  text: string,
  explicitStreamId?: StreamTabId,
): void {
  const view = currentView();
  const streamId =
    explicitStreamId ??
    resolveLocalTranscriptStreamId({
      activeStreamId: activeStreamIdSignal.get(),
      fallbackStreamId: STREAM_ID,
      parentOf: (id) => streamViewOf(view, id)?.parentId ?? undefined,
      rootStreamId: rootStreamId.get(),
    });
  switch (role) {
    case 'assistant':
      appendLocalAssistantTranscript(text, streamId);
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

function markHarnessExecutionStopped(executionId: string): void {
  const view = currentView();
  const child = [...view.streams.values()].find(
    (stream) => stream.executionId === executionId,
  );
  if (!child) return;
  appendHarnessAssistantTranscript(
    `Harness kill requested for ${executionId}.`,
    STREAM_ID,
  );
  appendHarnessAssistantTranscript(
    'Harness kill requested for this sub-workflow.',
    child.id,
  );
  seedPhase(child.id, STREAM_PHASE.CANCELLED);
}

function handleHarnessSubmit(line: string): void {
  if (handleHarnessSlashCommand(line)) return;
  const view = currentView();
  const focused = streamViewOf(view, activeStreamIdSignal.get());
  if (focused && focused.parentId !== null) {
    if (!focusedChildAcceptsFollowUps(focused)) {
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
  const streamId = activeStreamIdSignal.get() ?? STREAM_ID;
  const stream = streamViewOf(view, streamId);
  appendHarnessAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent,
      model: meta.model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        usageRoute: cumulativeUsageOf(stream)?.usageRoute,
      }),
      approvalPolicy: harnessRuntimeSession.approvalPolicy,
      approvalBypasses: view.policy.get(streamId)?.bypasses,
      statusLabel: stream?.statusLabel,
      activeChildSessions: runningChildCount(view, stream),
      goal: GoalStore.getForStream(streamId),
      // The harness never emits an ACTIVE_SKILLS snapshot.
      activeSkills: [],
      queuedFollowUpMessages: view.queuedFollowUps.get(streamId) ?? [],
    }),
  );
}

function resetHarnessForClear(): void {
  const meta = sessionMeta.get();
  session().interactions.cancel({ cause: 'Session interrupted.' });
  harnessFollowUpQueue.drainItems();
  void GoalStore.forget(STREAM_ID);
  for (const streamId of [...currentView().streams.keys()]) {
    removeStream(streamId);
  }
  resetCliState(meta);
  activeStreamIdSignal.set(STREAM_ID);
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
    case 'status':
      appendHarnessStatus();
      return true;
    case 'plan':
      void showCliWorkPlan();
      return true;
    case 'goal':
    case 'goals':
      appendHarnessAssistantTranscript(GOAL_MODE_HELP);
      return true;
    case 'clear':
      resetHarnessForClear();
      return true;
    case 'approval':
      applyHarnessApprovalPolicySelection(rest, HARNESS_APPROVAL_USAGE);
      return true;
    case 'yolo':
      applyHarnessApprovalPolicySelection(rest || 'yolo', HARNESS_YOLO_USAGE);
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

registerBuiltinSlashCommands({
  // Mirror `texra chat`: agent selection is open exactly while no root run
  // is pending, the same fact the status bar's `/agent` hint derives from.
  canSelectAgent: () => !rootRunPending.get(),
  canSelectModel: () => CAN_SELECT_MODEL,
  getModelSwitchDisabledReason: (model) =>
    DISABLED_MODEL_SWITCHES.has(model)
      ? DISABLED_MODEL_SWITCH_REASON
      : undefined,
  getApprovalPolicy: () => harnessRuntimeSession.approvalPolicy,
  onApprovalPolicySelect: setHarnessApprovalPolicy,
  onModelSelect: (model) => {
    setCliSessionModelOverride(model);
    appendHarnessAssistantTranscript(
      `Harness model selected. Future turns: ${model}.`,
    );
  },
  onModelAccessSelect: (selection) => {
    if (selection.provider === 'kimi-code' && selection.state === 'on') {
      return updateCliModelAccess(HARNESS_CLI_CONTEXT, selection, {
        writeProgress: appendHarnessAssistantTranscript,
      }).then((access) => {
        appendHarnessAssistantTranscript(access.message);
      });
    }
    appendHarnessAssistantTranscript(
      `${selection.provider} preference set to ${selection.state}.`,
    );
  },
  onMemorySelect: (storagePath) => {
    appendHarnessAssistantTranscript(
      `Harness memory selected: ${storagePath}.`,
    );
  },
  onSkillSelect: (selection) => {
    appendHarnessAssistantTranscript(
      `Harness skill selected: ${selection.name}.`,
    );
  },
  onResumeSelect: (id) => {
    appendHarnessAssistantTranscript(`Harness resume selected: ${id}.`);
  },
  workPlanSnapshots: defaultSession().snapshots,
  getConfigStores: cliSettingsStores,
  onError: (error) => {
    appendHarnessAssistantTranscript(
      `Slash command failed: ${toErrorMessage(error)}`,
    );
  },
});
// Mirror the real publisher's run facts: an interruptible harness run is a
// pending root-run claim on the harness stream, so the status bar derives
// the Ctrl-C stop hint from these signals exactly as `texra chat` does.
rootRunPending.set(canInterrupt);
rootRunStreamId.set(canInterrupt ? STREAM_ID : undefined);

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
      onSubmit={handleHarnessSubmit}
      onKillExecution={markHarnessExecutionStopped}
      onWorkflowControl={() => undefined}
      canInterruptStream={(streamId) =>
        isInFlightPhase(streamViewOf(currentView(), streamId)?.status)
      }
      colorEnabled={HARNESS_COLOR_ENABLED}
      history={HARNESS_INPUT_HISTORY}
      onInterruptStream={markHarnessStreamInterrupted}
      onStaticTranscriptChange={viewportController.repaintTranscript}
      onCtrlC={handleHarnessCtrlC}
    />
  );
}

const ink = render(renderHarnessApp(), {
  stdout: HARNESS_STDOUT,
  stderr: process.stderr,
  stdin: process.stdin,
  exitOnCtrlC: false,
});
inkRef.current = ink;

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
    await harnessRuntimeHost.close();
    await platform().lifecycle.runShutdown();
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', handleHarnessCtrlC);
