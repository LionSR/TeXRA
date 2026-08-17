// Test harness: seed cliState with synthetic finalized entries, render <App />
// to the real terminal. Used to verify the ConversationPane viewport without
// needing API access. Exits on Ctrl-C.

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
import type { RetryResult } from '@agent/runtime/HostInteractions';
import {
  defaultSession,
  initializeDefaultSession,
} from '@agent/runtime/SessionHandle';
import { SupabaseClient } from '@auth/SupabaseClient';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import { planTeamRuns, teamPresets } from '@common/teams/TeamPlan';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { platform, tryPlatform } from '@platform/platform';
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
  USER_FOLLOW_UP_SUPPORT,
  TODO_STATUS,
  TOOL_USE_STATUS,
  type ActiveChildInfo,
  type ExecutionId,
  type InquiryThreadId,
  type NormalizedToolUse,
  type PlanApprovalPermission,
  type RetryPermission,
  type StreamPhase,
  type StreamTabId,
  type UserQuestionPermission,
} from '@shared/schemas';
import { FOCUSED_BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  isActivePhase,
  isInFlightPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { GoalStore } from '@tools/goal';
import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';
import { createRunTrace, StreamLogStore } from '@transcript';
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
  rootRunStartAvailable,
  rootRunStreamId,
  rootStreamId,
  resetCliState,
  sessionMeta,
  setCliSessionModelOverride,
  patchStream,
  streams,
  type ConversationEntry,
  setStreamStatusInCliState,
} from '../src/chat/tui/state/cliState';
import {
  activeSubagentsFor,
  projectChildRoster,
  childStreamEntries,
  parentStream,
  setParentStream,
  visibleSubagentRows,
} from '../src/chat/tui/state/childExecutions';
import { focusedChildFollowUpRoute } from '../src/chat/tui/state/focusedChildFollowUp';
import { formatCliSessionStatus } from '../src/chat/tui/sessionStatus';
import { notify } from '../src/chat/tui/notifications/terminalNotifier';
import { createTuiViewportController } from '../src/chat/tui/render/tuiViewportController';
import {
  approvalPayloadStreamId,
  clearApprovals,
  clearApprovalsWhere,
  enqueueApproval,
  type ApprovalDecision,
  type ApprovalPayload,
} from '../src/chat/tui/state/approvalQueue';
import { syncStreamLog } from '../src/chat/tui/state/subscribeStreamLog';
import { attachSessionSignalsAdapter } from '../src/chat/tui/state/sessionSignalsAdapter';
import { notifyStaticTranscriptErased } from '../src/chat/tui/state/staticTranscriptRepaint';
import { createTuiHostInteractions } from '../src/chat/tui/state/subscribeApprovals';
import { subscribeStreamStatus } from '../src/chat/tui/state/subscribeStreamStatus';
import { resolveLocalTranscriptStreamId } from '../src/chat/tui/state/transcript';
import { clearTerminalScrollback } from '../src/tui/terminalCleanup';
import { defaultShortcutModifierLabel } from '../src/runtime/shortcutLabels';
import { OrchestrationApp } from '../src/orchestration/runOrchestrationTui';
import { parseCliApiMode } from '../src/runtime/apiAccessMode';
import {
  formatCliModelAccessRouteInline,
  resolveCliModelAccessRoute,
} from '../src/runtime/modelAccessRoute';
import { updateCliModelAccess } from '../src/runtime/modelAccessSelection';
import {
  formatCliApiStatusActionHint,
  formatCliAuthStatusLine,
} from '../src/runtime/apiStatus';
import {
  buildCliAgentItems,
  buildCliOrchestrationItems,
  buildCliResumeItems,
  buildCliTeamItems,
} from '../src/runtime/orchestration';
import {
  CLI_HISTORY_RESUMABLE_STATUS,
  type CliHistoryEntry,
} from '../src/runtime/history';
import { initLocalCliPlatform } from '../src/runtime/initPlatform';
import { saveProviderApiKey } from '../src/runtime/providerApiKey';
import { resolveCliResourcesPath } from '../src/runtime/resourcesPath';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '../src/runtime/cliPresentationHost';
import { setCliToolEnabled } from '../src/runtime/tools';
import type { CliContext } from '../src/runtime/cliContext';
import type { CliModelAccess } from '../src/runtime/modelAccess';
import type { InputHistory } from '../src/chat/tui/history/inputHistory';

const STREAM_ID = 'harness-stream-1';
const RUNNING_WORKFLOW_FIRST_AGENT_STREAM_ID =
  'correct@harness-model#harness-workflow-agent-a' as StreamTabId;
const SHOW_WORKFLOW_TIMELINE = process.env.HARNESS_WORKFLOW_TIMELINE === '1';
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
const HARNESS_API_MODE_FROM_ENV = parseCliApiMode(
  process.env.HARNESS_API_MODE ?? '',
);
const HARNESS_API_MODE: ApiAccessMode = HARNESS_API_MODE_FROM_ENV ?? 'personal';
const HARNESS_AUTHENTICATED = process.env.HARNESS_AUTHENTICATED?.trim();
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
const CAN_DELEGATE = process.env.HARNESS_CAN_DELEGATE === '1';
const CAN_SELECT_AGENT = process.env.HARNESS_CAN_SELECT_AGENT === '1';
const CAN_SELECT_MODEL = process.env.HARNESS_CAN_SELECT_MODEL === '1';
const DISABLED_MODEL_SWITCHES = new Set(
  parseList(process.env.HARNESS_DISABLED_MODEL_SWITCHES),
);
const DISABLED_MODEL_SWITCH_REASON =
  process.env.HARNESS_DISABLED_MODEL_SWITCH_REASON ??
  'different conversation format; start new chat';
const SHOW_CHILDREN = process.env.HARNESS_CHILDREN === '1';
const SHOW_NESTED_CHILDREN = process.env.HARNESS_NESTED_CHILDREN === '1';
// Opt-in fixture for the PTY ordering tests (issue #7972, follow-up from
// #7967 / the "PTY ordering tests" section of
// docs/proposals/2026-07-10-cli-child-stream-state-consolidation.md): drives one child
// stream through the real event-subscription path
// (attachSessionSignalsAdapter + subscribeStreamStatus, exactly as
// runChatTui.tsx/chatSessionController.ts wire a real run — see
// `runChildEventOrderFixture` below) in each of the eight orderings the
// design names, so validate-tui.mjs can assert both intermediate render
// checkpoints and (for the four order-equivalent cases) a byte-identical
// settled frame no matter which order the attachment/roster/edge/status
// facts arrive in.
const CHILD_EVENT_ORDER_VALUES = [
  'canonical',
  'roster-first',
  'edge-first',
  'status-first',
  'promotion-late-roster',
  'reattach-late-old-roster',
  'parent-removal',
  'completion-remove',
] as const;
type ChildEventOrder = (typeof CHILD_EVENT_ORDER_VALUES)[number];
const CHILD_EVENT_ORDER_RAW = process.env.HARNESS_CHILD_EVENT_ORDER?.trim();
if (
  CHILD_EVENT_ORDER_RAW &&
  !(CHILD_EVENT_ORDER_VALUES as readonly string[]).includes(
    CHILD_EVENT_ORDER_RAW,
  )
) {
  throw new Error(
    `HARNESS_CHILD_EVENT_ORDER must be one of ${CHILD_EVENT_ORDER_VALUES.join(', ')}, got ${JSON.stringify(CHILD_EVENT_ORDER_RAW)}`,
  );
}
const CHILD_EVENT_ORDER = CHILD_EVENT_ORDER_RAW as ChildEventOrder | undefined;
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
  apiMode: HARNESS_API_MODE,
  approvalPolicy: HARNESS_INITIAL_APPROVAL_POLICY,
  cliConfig: {},
  commandName: 'texra',
  configWarnings: [],
  cwd: HARNESS_CWD,
  helperModel: 'harness-model',
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
  apiMode: HARNESS_API_MODE,
  cwd: HARNESS_CWD,
  installSignalHandlers: false,
  resourcesPath: HARNESS_RESOURCES_PATH,
  storageRoot: path.join(HARNESS_CWD, '.texra-storage'),
  helperModel: 'harness-model',
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
  const memoryRoot = path.join(
    platform().storage.getStoragePath(),
    MEMORY_STORAGE_DIR,
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
  await platform().workspaceState.update(
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
function harnessOrchestrationHistory(): readonly CliHistoryEntry[] {
  if (!SHOW_ORCHESTRATION_HISTORY) return [];
  return [
    {
      id: 'cccccccccccc' as ExecutionId,
      timestamp: '2026-06-06T00:02:00Z',
      agent: 'orchestrator',
      model: 'harness-model',
      status: CLI_HISTORY_RESUMABLE_STATUS,
      inputBasename: '-',
      category: AgentCategory.ToolUse,
    },
  ];
}

const HARNESS_ORCHESTRATION_HISTORY = harnessOrchestrationHistory();
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
        apiFallback: HARNESS_API_MODE,
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
      }
    : undefined;
const HARNESS_ORCHESTRATION_ITEMS = buildCliOrchestrationItems({
  presetPlans: HARNESS_PRESET_PLANS,
  history: HARNESS_ORCHESTRATION_HISTORY,
  toolUseAgents: HARNESS_VISIBLE_TOOL_USE_AGENT_ENTRIES,
  modelAccess: HARNESS_MODEL_ACCESS,
});
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
    availability: 'included-access',
  },
  { value: 'gpt54', label: 'GPT-5.4', availability: 'included-access' },
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

function isHarnessModelAvailable(
  availability: HarnessModelFixture['availability'],
  apiMode: ApiAccessMode,
): boolean {
  return apiMode === 'included'
    ? availability === 'included-access'
    : availability === 'provider-key' || availability === 'openrouter-key';
}

function harnessModelStatus(
  availability: HarnessModelFixture['availability'],
): string {
  switch (availability) {
    case 'included-access':
      return 'included access';
    case 'provider-key':
      return 'api key set';
    case 'openrouter-key':
      return 'openrouter key set';
    default:
      return availability.replaceAll('-', ' ');
  }
}

function harnessModel(
  fixture: HarnessModelFixture,
  apiMode: ApiAccessMode,
): CliModelAccess {
  return {
    model: fixture,
    available: isHarnessModelAvailable(fixture.availability, apiMode),
    status: harnessModelStatus(fixture.availability),
  };
}

function harnessOrchestrationModels(
  apiMode: ApiAccessMode,
): readonly CliModelAccess[] {
  const models = HARNESS_ORCHESTRATION_MODEL_FIXTURES.map((fixture) =>
    harnessModel(fixture, apiMode),
  );
  return SHOW_NO_RUNNABLE_ORCHESTRATION_MODELS
    ? models.map((model) => ({
        ...model,
        available: false,
        status: 'missing key',
      }))
    : models;
}

function harnessOrchestrationStatusLines(): readonly string[] {
  const authenticated = HARNESS_AUTHENTICATED === '1';
  const profile = {
    authenticated,
    accountLabel: authenticated ? 'harness@example.edu' : undefined,
  };
  return [
    `api: ${formatCliModelAccessRouteInline(HARNESS_API_MODE)}`,
    formatCliAuthStatusLine(profile),
    formatCliApiStatusActionHint(HARNESS_API_MODE, profile),
  ];
}

if (SHOW_ORCHESTRATION) {
  const instance = render(
    <OrchestrationApp
      items={HARNESS_ORCHESTRATION_ITEMS}
      resumeItems={HARNESS_ORCHESTRATION_RESUME_ITEMS}
      agentItems={HARNESS_ORCHESTRATION_AGENT_ITEMS}
      teamItems={HARNESS_ORCHESTRATION_TEAM_ITEMS}
      models={
        HARNESS_API_MODE_FROM_ENV
          ? harnessOrchestrationModels(HARNESS_API_MODE)
          : []
      }
      apiMode={HARNESS_API_MODE}
      modelAccess={HARNESS_MODEL_ACCESS}
      version="0.0.0-harness"
      statusLines={
        SHOW_ORCHESTRATION_STATUS_LINES
          ? harnessOrchestrationStatusLines()
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

if (HARNESS_AUTHENTICATED === '1' || HARNESS_AUTHENTICATED === '0') {
  const accessToken = HARNESS_AUTHENTICATED === '1' ? 'harness-token' : null;
  SupabaseClient.setAuthProvider({
    whenReady: async () => {},
    ensureFreshToken: async () => accessToken,
    getSessionTokens: async () =>
      accessToken
        ? { accessToken, refreshToken: 'harness-refresh-token' }
        : null,
    getStoredSessionState: async () =>
      accessToken === null ? 'none' : 'authenticated',
    getStoredAccountLabel: async () => null,
    isTokenExpiringSoon: () => false,
    getLastRefreshFailure: () => null,
  });
}

function makeEntries(count: number): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (let i = 1; i <= count; i += 1) {
    const role = i % 3 === 0 ? 'assistant' : 'user';
    const text =
      role === 'user'
        ? `entry-${i} chat history line to grow the transcript pane`
        : `assistant reply ${i} - confirming receipt of entry ${i}`;
    entries.push({
      id: `entry-${i}`,
      role,
      text,
      finalized: true,
    });
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

function makeLongToolOutputEntries(): ConversationEntry[] {
  return [
    {
      id: 'long-tool-user',
      role: 'user',
      text: 'Enumerate Pythagorean triples and show the complete output.',
      finalized: true,
    },
    {
      id: 'long-tool-output',
      role: 'tool',
      text: '',
      finalized: true,
      toolUse: makeLongToolOutput(),
    },
  ];
}

function makeAssistantToolPreambleEntries(): ConversationEntry[] {
  return [
    {
      id: 'preamble-user',
      role: 'user',
      text: 'what is this repo about',
      finalized: true,
    },
    {
      id: 'preamble-assistant',
      role: 'assistant',
      text: 'I will read the README first.',
      finalized: true,
    },
    {
      id: 'preamble-tool',
      role: 'tool',
      text: '',
      finalized: true,
      toolUse: {
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
    },
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
  syncStreamLog(STREAM_ID);
}

function makeRejectedBashToolEntries(): ConversationEntry[] {
  const command = "printf 'approval-reject-live\\n'";
  const message = `User rejected command: ${command}`;
  return [
    {
      id: 'rejected-bash-user',
      role: 'user',
      text: 'Run a harmless command, but reject it at the approval prompt.',
      finalized: true,
    },
    {
      id: 'rejected-bash-tool',
      role: 'tool',
      text: '',
      finalized: true,
      toolUse: {
        toolName: 'bash',
        errorText: message,
        outputText: message,
        userInstructionText: '',
        input: { command },
        isError: true,
        isUserFeedback: false,
        headerSummary: command,
        status: TOOL_USE_STATUS.COMPLETED,
      },
    },
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
  syncStreamLog(STREAM_ID);
}

function makeChildEntries(agent: string, action: string): ConversationEntry[] {
  const assistantText =
    SHOW_LONG_CHILD_OUTPUT && agent === 'strategy'
      ? Array.from({ length: 18 }, (_, index) =>
          index === 0 && SHOW_WIDE_FIRST_CHILD_LINE
            ? `strategy detail line 01 ${'wide output wraps '.repeat(10)}`
            : `strategy detail line ${String(index + 1).padStart(2, '0')}${index === 17 ? ' final contradiction found' : ''}`,
        ).join('\n')
      : `${agent} is checking the ${action} details and preparing a concise result.`;
  return [
    {
      id: `${agent}-user`,
      role: 'user',
      text: `Please handle the ${action} sub-workflow.`,
      finalized: true,
    },
    {
      id: `${agent}-assistant`,
      role: 'assistant',
      text: assistantText,
      finalized: false,
    },
  ];
}

function harnessMessageEntry(
  id: string,
  text: string,
  role: 'assistant' | 'error' | 'user' = 'assistant',
  finalized = true,
): ConversationEntry {
  return {
    id,
    role,
    text,
    finalized,
  };
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
  if (RETRY_APPROVAL_CHATGPT) {
    return {
      requestId: `harness-retry-${nanoid()}`,
      streamId: STREAM_ID,
      operation: 'Model request',
      model: 'harness-model',
      errorMessage: 'ChatGPT subscription usage limit reached. Resets in 2h.',
      errorDetails: {
        exhaustionReason: 'chatgpt-subscription',
        isRelayError: false,
        provider: 'openai',
        statusCode: 429,
      },
    };
  }
  return {
    requestId: `harness-retry-${nanoid()}`,
    streamId: STREAM_ID,
    operation: 'Model request',
    model: 'harness-model',
    errorMessage: 'HTTP 429 Too Many Requests',
    errorDetails: {
      // Keep this fixture interactive: relay-limit retries auto-switch when
      // a usable personal key exists, while upstream-credit requires an
      // explicit user decision before changing credentials.
      exhaustionReason: 'upstream-credit',
      isRelayError: true,
      provider: 'openai',
      statusCode: 429,
    },
  };
}

function makePlanApprovalPayload(): PlanApprovalPermission {
  return {
    approvalId: 'harness-plan-approval',
    streamId: STREAM_ID,
    goalEnabled: PLAN_APPROVAL_GOAL,
    plan: {
      objective: PLAN_APPROVAL_OBJECTIVE,
    },
  };
}

function makeAgentProposalPayload() {
  return {
    proposalId: 'harness-agent-proposal',
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

function enqueueHarnessApproval(
  payload: ApprovalPayload,
  onDecision: (decision: ApprovalDecision) => void | Promise<void>,
): void {
  void enqueueApproval(payload, {
    onPresent: () => notify('approvalNeeded'),
  }).then(onDecision);
}

function applyHarnessApprovalDecision(decision: ApprovalDecision): void {
  if (!decision.accepted) return;
  if (decision.bypass === 'bash') {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { ...slice.bypass, bash: true },
    }));
  } else if (decision.bypass === 'toolEdit') {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { ...slice.bypass, toolEdit: true },
    }));
  } else if (decision.bypass === 'superYolo') {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { bash: true, superYolo: true, toolEdit: true },
    }));
  }
}

function appendHarnessExternalInquiryDecision(
  decision: ApprovalDecision,
): void {
  appendHarnessTranscript(
    'user',
    buildContinuationText({
      event: decision.accepted && decision.userMessage ? 'answered' : 'dropped',
      threadId: EXTERNAL_INQUIRY_THREAD_ID,
      question: EXTERNAL_INQUIRY_QUESTION,
      ...(decision.accepted && decision.userMessage
        ? { answer: decision.userMessage }
        : {}),
      stillOpen: [],
    }),
  );
}

function appendHarnessRetryResult(
  result: RetryResult,
  credentialSelection: 'configured' | 'personal' | undefined,
): void {
  if (result.action === 'retry' && credentialSelection === 'personal') {
    appendHarnessAssistantTranscript(
      `RETRY-API-MODE ${sessionMeta.get().apiMode}`,
    );
    return;
  }
  appendHarnessAssistantTranscript(
    result.action === 'retry' ? 'RETRY-APPROVED' : 'RETRY-REJECTED',
  );
}

async function appendHarnessPlanDecision(
  decision: ApprovalDecision,
): Promise<void> {
  if (decision.planAction === 'approve_and_goal') {
    await GoalStore.start(STREAM_ID, PLAN_APPROVAL_OBJECTIVE);
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { ...slice.bypass, bash: true },
    }));
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.RUNNING,
    });
    appendHarnessAssistantTranscript('PLAN-GOAL');
    return;
  }
  appendHarnessAssistantTranscript(
    decision.accepted ? 'PLAN-APPROVED' : 'PLAN-REJECTED',
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

function harnessInitialEntries(): ConversationEntry[] {
  if (SHOW_WORKFLOW_TIMELINE) return [];
  if (SHOW_REJECTED_BASH_TOOL) return makeRejectedBashToolEntries();
  if (SHOW_LONG_TOOL_OUTPUT) return makeLongToolOutputEntries();
  if (SHOW_ASSISTANT_TOOL_PREAMBLE) return makeAssistantToolPreambleEntries();
  if (SHOW_LIVE_TOOL_ONLY) return [];
  return makeEntries(ENTRY_COUNT);
}

sessionMeta.set({
  agent: 'chat',
  category: AgentCategory.ToolUse,
  model: 'harness-model',
  modelSource: 'builtin-default',
  cwd: HARNESS_CWD,
  apiMode: HARNESS_API_MODE,
  approvalPolicy: HARNESS_INITIAL_APPROVAL_POLICY,
  canDelegate: CAN_DELEGATE,
  transcriptMode: 'persistent',
  teamName: TEAM_NAME,
  version: '0.0.0-harness',
});
activeStreamIdSignal.set(STREAM_ID);
patchStream(STREAM_ID, (slice) => ({
  ...slice,
  entries: harnessInitialEntries(),
  queuedFollowUpMessages: QUEUED_FOLLOW_UPS,
}));
const HARNESS_INITIAL_STREAM_STATUS = harnessInitialStreamStatus();
if (HARNESS_INITIAL_STREAM_STATUS) {
  setStreamStatusInCliState({
    streamId: STREAM_ID,
    status: HARNESS_INITIAL_STREAM_STATUS,
    // Backdated so the status bar shows a plausible elapsed time.
    ...(HARNESS_RUN_ACTIVE ? { nowMs: Date.now() - 42_000 } : {}),
  });
}

if (SHOW_LIVE_TOOL_ONLY) {
  seedLiveToolOnlyTranscript();
}

if (SHOW_SUBAGENT_FOLLOWUPS) {
  seedSubagentFollowupTranscript();
}

function seedWorkflowTimeline(): void {
  // Hex-valid: the StreamSnapshotStore (the one artifact accumulator) parses
  // payload execution ids and drops non-conforming rows.
  const executionId = 'aaaa0001f10e' as ExecutionId;
  const childStreamId = 'workflow-script#aaaa0001f10e' as StreamTabId;
  emitSetActiveStream(childStreamId, AgentCategory.Workflow);
  emitChildEventOrderRoster(STREAM_ID, [
    {
      executionId,
      agentName: 'repositoryAudit',
      childStreamId,
      identity: { kind: 'multiAgentWorkflow', workflowName: 'repositoryAudit' },
    },
  ]);
  emitChildEventOrderEdge(childStreamId, STREAM_ID);
  transitionChildEventOrderRunning(childStreamId);
  // Mirror a user focusing the running child before its terminal transition.
  // `subscribeStreamStatus` must return this focus to the owner below.
  activeStreamIdSignal.set(childStreamId);

  const output = {
    source: 'paper.tex',
    location: {
      kind: 'runStorage' as const,
      executionId,
      relativePath: 'r1/paper.tex',
      absolutePath: '/private/tmp/texra-harness/r1/paper.tex',
    },
    round: 0,
    lineage: null,
    diff: null,
  };
  const runTrace = createRunTrace(childStreamId, defaultSession().transcripts);
  const runStage = runTrace.trace.openStage('Repository audit', {
    id: 'harness-workflow-run',
    kind: 'run',
  });
  const roundStage = runTrace.trace.openStage('Round 1', {
    id: 'harness-workflow-round-1',
    index: 0,
    kind: 'round',
    parent: runStage,
    total: 2,
  });

  roundStage.end('completed');
  defaultSession().events.emit({
    scope: 'run',
    streamId: childStreamId,
    event: {
      type: 'addOutputFiles',
      filesByRound: { 0: [output] },
      streamId: childStreamId,
    },
  });
  defaultSession().events.emit({
    scope: 'run',
    streamId: childStreamId,
    event: {
      type: 'updateCompileFailures',
      filesByRound: {
        0: [
          {
            round: 0,
            displayName: 'paper.tex',
            output: output.location,
            log: {
              kind: 'runStorage',
              executionId,
              relativePath: 'r1/paper.log',
              absolutePath: '/private/tmp/texra-harness/r1/paper.log',
            },
            logRelativePath: 'r1/paper.log',
          },
        ],
      },
      streamId: childStreamId,
    },
  });
  const secondRoundStage = runTrace.trace.openStage('Round 2', {
    id: 'harness-workflow-round-2',
    index: 1,
    kind: 'round',
    parent: runStage,
    total: 2,
  });
  secondRoundStage.end('completed');
  runStage.end('completed');
  syncStreamLog(childStreamId);
  transitionChildEventOrderTerminal(childStreamId);
  emitChildEventOrderRoster(STREAM_ID, []);
  runTrace.dispose();

  if (activeStreamIdSignal.get() !== STREAM_ID) {
    throw new Error('Completed workflow child did not return focus to owner');
  }
  const retained = visibleSubagentRows(
    STREAM_ID,
    childStreamEntries.get(),
    streams.get(),
  );
  if (!retained.some((child) => child.childStreamId === childStreamId)) {
    throw new Error('Completed workflow child was not retained for refocus');
  }
}

function seedRunningWorkflow(): void {
  const executionId = 'aaaa0002f10e' as ExecutionId;
  const childStreamId = 'workflow-script#aaaa0002f10e' as StreamTabId;
  const firstAgentStreamId = RUNNING_WORKFLOW_FIRST_AGENT_STREAM_ID;
  const secondAgentStreamId =
    'correct@harness-model#harness-workflow-agent-b' as StreamTabId;

  emitSetActiveStream(childStreamId, AgentCategory.Workflow);
  emitChildEventOrderRoster(STREAM_ID, [
    {
      executionId,
      agentName: 'live-workflow-validation',
      childStreamId,
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'live-workflow-validation',
      },
    },
  ]);
  emitChildEventOrderEdge(childStreamId, STREAM_ID);
  transitionChildEventOrderRunning(childStreamId);

  const runTrace = createRunTrace(childStreamId, defaultSession().transcripts);
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
  // Focus before projection: background workflow streams intentionally keep
  // only operational rows, while the focused stream owns the task transcript.
  activeStreamIdSignal.set(childStreamId);
  syncStreamLog(childStreamId);

  const workflowChildren = [
    {
      executionId: 'harness-workflow-agent-a',
      identity: { kind: 'agent', agent: 'correct' },
      agentName: 'correct',
      childStreamId: firstAgentStreamId,
      elapsed: '18s',
      workflowPhase: 'Proofread',
    },
    {
      executionId: 'harness-workflow-agent-b',
      identity: { kind: 'agent', agent: 'correct' },
      agentName: 'correct',
      childStreamId: secondAgentStreamId,
      elapsed: '17s',
      workflowPhase: 'Proofread',
    },
  ] as const satisfies readonly ActiveChildInfo[];
  for (const child of workflowChildren) {
    emitSetActiveStream(child.childStreamId, AgentCategory.Workflow);
    emitChildEventOrderEdge(child.childStreamId, childStreamId);
    transitionChildEventOrderRunning(child.childStreamId);
  }
  emitChildEventOrderRoster(childStreamId, workflowChildren);
  patchStream(childStreamId, (slice) => ({
    ...slice,
    identity: {
      kind: 'multiAgentWorkflow',
      workflowName: 'live-workflow-validation',
    },
  }));

  HARNESS_DISPOSERS.push(() => {
    phaseStage.end('cancelled');
    runStage.end('cancelled');
    runTrace.dispose();
  });
}

function seedRunningProcessChild(): void {
  const childStreamId = 'bash#aaaa0003f10e' as StreamTabId;
  patchStream(childStreamId, (slice) => ({
    ...slice,
    identity: { kind: 'process', tool: 'bash' },
    // Matches the synthetic run config emitted by background Bash.
    category: AgentCategory.ToolUse,
    description: 'sleep 30',
  }));
  setStreamStatusInCliState({
    streamId: childStreamId,
    status: STREAM_PHASE.RUNNING,
  });
  projectChildRoster(STREAM_ID, [
    {
      executionId: 'aaaa0003f10e',
      agentName: 'bash',
      childStreamId,
      identity: { kind: 'process', tool: 'bash' },
      status: STREAM_PHASE.RUNNING,
    },
  ]);
  setParentStream(childStreamId, STREAM_ID);
  activeStreamIdSignal.set(childStreamId);
}

// One child stream, its attachment/roster/edge/status/removal facts driven
// through the real production subscription path rather than the CHILD_STREAMS
// map mutators (`projectChildRoster`/`setParentStream`) directly — a
// regression in `attachSessionSignalsAdapter` or `subscribeStreamStatus`
// wiring must be able to fail these scenarios, matching the "PTY ordering
// tests" section of docs/proposals/2026-07-10-cli-child-stream-state-consolidation.md.
// No `startedAt` is set on the roster row, so `childElapsed` returns the
// static `elapsed` string instead of a live-ticking duration
// (packages/cli/src/chat/tui/state/childControls.ts); `setActiveStream`
// always sets `suppressViewSwitch: true` so the harness's own active/focused
// stream (and its live wall-clock `runStartedAt` elapsed display) stays on
// the root session throughout — required for the four order-equivalent
// scenarios' settled frame to be byte-identical across separate process
// launches, not just across orderings within one launch.
const CHILD_EVENT_ORDER_STREAM_ID =
  'harness-child-event-order-stream' as StreamTabId;
const CHILD_EVENT_ORDER_EXECUTION_ID = 'harness-child-event-order-exec';
const CHILD_EVENT_ORDER_AGENT_NAME = 'orderChecker';
// Second, never-displayed parent identity used only by the promotion/
// reattachment/parent-removal orderings (matrix scenarios 7/11 in
// TuiStateAndFocus.vitest.mts) — reusing the harness's own root `STREAM_ID`
// as a *removable* parent would tear down the harness's own active session.
const CHILD_EVENT_ORDER_OTHER_PARENT_ID =
  'harness-child-event-order-other-parent' as StreamTabId;
const CHILD_EVENT_ORDER_MARKER_PREFIX =
  '\u001b]777;texra-harness-child-event-order:';
const CHILD_EVENT_ORDER_MARKER_SUFFIX = '\u0007';
const HARNESS_DISPOSERS: Array<() => void> = [];

function childEventOrderRosterRow(): ActiveChildInfo {
  return {
    executionId: CHILD_EVENT_ORDER_EXECUTION_ID,
    identity: { kind: 'agent', agent: CHILD_EVENT_ORDER_AGENT_NAME },
    agentName: CHILD_EVENT_ORDER_AGENT_NAME,
    childStreamId: CHILD_EVENT_ORDER_STREAM_ID,
    elapsed: '1m 4s',
  };
}

// `child.activity` run fact — the real roster wiring
// (`ExecutionRegistry.emitChildActivity`, src/agent/runtime/executionRegistry.ts).
function emitChildEventOrderRoster(
  parentStreamId: StreamTabId,
  children: readonly ActiveChildInfo[],
): void {
  defaultSession().events.emit({
    scope: 'run',
    streamId: parentStreamId,
    event: {
      type: 'child.activity',
      parentStreamId,
      items: children,
    },
  });
}

// `setParentStream` session fact — the real edge wiring
// (`ExecutionRegistry.emitParentStreamUpdate`).
function emitChildEventOrderEdge(
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null,
): void {
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'setParentStream',
      payload: { childStreamId, parentStreamId },
    },
  });
}

// `removeStream` session fact — the real removal wiring (src/tools/delegation/childStream.ts).
function emitChildEventOrderRemoval(streamId: StreamTabId): void {
  defaultSession().events.emit({
    scope: 'session',
    event: { type: 'removeStream', payload: { streamId } },
  });
}

// `setActiveStream` session fact — used both as the child-order fixture's
// "attachment" step and as the workflow-timeline/running-workflow focus
// switch. Always background-registers (`suppressViewSwitch: true`) so the
// harness's own active/focused stream never becomes the child (see the
// wall-clock note above).
function emitSetActiveStream(
  streamId: StreamTabId,
  agentCategory?: AgentCategory,
): void {
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'setActiveStream',
      payload: { streamId, agentCategory, suppressViewSwitch: true },
    },
  });
}

// Real status-machine transitions on the default session —
// `subscribeStreamStatus()` projects these into `cliState` (see
// `runChildEventOrderFixture`), exactly as `runChatTui.tsx` wires it for a
// real session.
function transitionChildEventOrderRunning(streamId: StreamTabId): void {
  defaultSession().status.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

function transitionChildEventOrderTerminal(streamId: StreamTabId): void {
  defaultSession().status.transitionToTerminal(
    streamId,
    STREAM_PHASE.COMPLETED,
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
  );
}

// Late resume-transition attempt for an already-removed stream: unlike a
// repeated terminal transition (a same-value no-op the status machine drops
// before it ever reaches `cliState`), COMPLETED -> RUNNING via `resume` is a
// transition the machine itself allows, so it reaches
// `setStreamStatusInCliState` and actually exercises that function's
// `isChildStreamRemoved` tombstone guard (see `completion-remove` below).
function attemptChildEventOrderLateResume(streamId: StreamTabId): void {
  defaultSession().status.transition(
    streamId,
    STREAM_PHASE.RUNNING,
    STREAM_TRANSITION_CAUSE.RESUME,
  );
}

/**
 * The eight orderings named by the design doc's "PTY ordering tests"
 * section, expressed as ordered real-fact steps with a flushed-render marker
 * after each boundary. `canonical` through `status-first` are byte-identical
 * settled orderings of the same four facts (attachment, running status,
 * roster, edge) — see the vitest
 * "child-stream ordered transition matrix" (scenarios 1-4,
 * src/test-kernel/cli/TuiStateAndFocus.vitest.mts) this mirrors at the PTY
 * layer. The remaining four correct old ambiguous transients (promotion,
 * reattachment, parent removal, completion+removal — matrix scenarios 6, 7,
 * 11, and 5-then-8) get their own checkpoint expectations in
 * validate-tui.mjs rather than byte-equivalence.
 */
function childEventOrderSteps(order: ChildEventOrder): readonly (() => void)[] {
  const child = CHILD_EVENT_ORDER_STREAM_ID;
  const root = STREAM_ID as StreamTabId;
  const other = CHILD_EVENT_ORDER_OTHER_PARENT_ID;
  const A = () => emitSetActiveStream(child);
  const Srun = () => transitionChildEventOrderRunning(child);
  const Sterm = () => transitionChildEventOrderTerminal(child);
  const RPlus = (parent: StreamTabId) =>
    emitChildEventOrderRoster(parent, [childEventOrderRosterRow()]);
  const RMinus = (parent: StreamTabId) => emitChildEventOrderRoster(parent, []);
  const EPlus = (parent: StreamTabId) => emitChildEventOrderEdge(child, parent);
  const E0 = () => emitChildEventOrderEdge(child, null);
  const X = (streamId: StreamTabId) => emitChildEventOrderRemoval(streamId);

  switch (order) {
    case 'canonical':
      return [A, Srun, () => RPlus(root), () => EPlus(root)];
    case 'roster-first':
      return [() => RPlus(root), A, Srun, () => EPlus(root)];
    case 'edge-first':
      return [() => EPlus(root), A, Srun, () => RPlus(root)];
    case 'status-first':
      return [Srun, A, () => EPlus(root), () => RPlus(root)];
    case 'promotion-late-roster':
      // Matrix 6: A, S(running), R_P+, E_P+, E0, R_P+ — a stale roster from
      // the former parent must not resurrect the edge or active membership.
      return [
        A,
        Srun,
        () => RPlus(root),
        () => EPlus(root),
        E0,
        () => RPlus(root),
      ];
    case 'reattach-late-old-roster':
      // Matrix 7 (relabeled so the *current* parent is the renderable root):
      // attach/run/roster/edge under `other`, promote, a stale `other`
      // roster, then an explicit edge+roster to `root`, and finally a late
      // roster from `other` again — which must not erase active membership
      // under `root`.
      return [
        A,
        Srun,
        () => RPlus(other),
        () => EPlus(other),
        E0,
        () => RPlus(other),
        () => EPlus(root),
        () => RPlus(root),
        () => RPlus(other),
      ];
    case 'parent-removal':
      // Matrix 11: P -> child, X(P), R_P+, E_P+ — `other` stands in for the
      // removed parent so the harness's own active root session is never
      // torn down by the removal itself.
      return [
        Srun,
        () => RPlus(other),
        () => EPlus(other),
        () => X(other),
        () => RPlus(other),
        () => EPlus(other),
      ];
    case 'completion-remove':
      // Matrix 5 then 8: roster omission arrives before the terminal status,
      // then the child itself is removed and every later fact for it —
      // including a late attachment and a late resume attempt — must stay
      // suppressed.
      return [
        A,
        Srun,
        () => RPlus(root),
        () => EPlus(root),
        () => RMinus(root),
        Sterm,
        () => X(child),
        () => RPlus(root),
        () => EPlus(root),
        A,
        () => attemptChildEventOrderLateResume(child),
      ];
  }
}

async function writeChildEventOrderMarker(label: string): Promise<void> {
  const marker = `${CHILD_EVENT_ORDER_MARKER_PREFIX}${label}${CHILD_EVENT_ORDER_MARKER_SUFFIX}`;
  await new Promise<void>((resolve, reject) => {
    HARNESS_STDOUT.write(marker, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runChildEventOrderFixture(
  ink: ReturnType<typeof render>,
  order: ChildEventOrder,
): Promise<void> {
  const steps = childEventOrderSteps(order);
  // `render()` mounts synchronously, and this first flush establishes the
  // single origin for the fixture protocol. No event may precede it.
  await ink.waitUntilRenderFlush();
  await writeChildEventOrderMarker('mounted');

  for (const [stepIndex, step] of steps.entries()) {
    step();
    ink.rerender(renderHarnessApp());
    await ink.waitUntilRenderFlush();
    await writeChildEventOrderMarker(`step-${stepIndex + 1}`);
  }
}

if (SHOW_CHILDREN) {
  const startedAt = Date.now() - 74_000;
  const nestedStartedAt = startedAt + 24_000;
  const nestedStrategyChild = {
    kind: 'subagent' as const,
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
      elapsed: '2m 3s',
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
          elapsed: null,
        }
      : child,
  );
  const activeSubagents = childStreams.filter(
    (child) => child.status !== STREAM_PHASE.FAILED,
  );
  // Seed through the real transition functions rather than poking StreamSlice
  // fields directly: register the complete roster first (so the errored
  // child gets a retained row), then re-apply the roster with it omitted —
  // mirroring the production sequence where a roster stops including a child
  // once it leaves the runtime's active registry, while its retained history
  // survives.
  projectChildRoster(STREAM_ID, childStreams);
  projectChildRoster(STREAM_ID, activeSubagents);
  setStreamStatusInCliState({
    streamId: STREAM_ID,
    status: STREAM_PHASE.RUNNING,
    nowMs: startedAt,
  });
  for (const child of childStreams) {
    const streamId = child.childStreamId;
    const addNestedChildren =
      SHOW_NESTED_CHILDREN && child.agentName === 'strategy';
    setParentStream(streamId, STREAM_ID);
    if (addNestedChildren) projectChildRoster(streamId, [nestedStrategyChild]);
    patchStream(streamId, (slice) => ({
      ...slice,
      category: AgentCategory.ToolUse,
      identity: child.identity,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      description: `${child.agentName} sub-workflow`,
      entries: makeChildEntries(child.agentName, child.executionId),
      // One child carries usage so scenarios pin the row metadata column's
      // generated-token figure (`↓40k`).
      cumulativeUsage:
        child.agentName === 'reviewer'
          ? { inputTokens: 52_000, outputTokens: 39_900, cost: 0.12 }
          : slice.cumulativeUsage,
    }));
    setStreamStatusInCliState({
      streamId: streamId,
      status: child.status,
      nowMs:
        child.status === STREAM_PHASE.RUNNING ? child.startedAt : undefined,
    });
  }
  if (SHOW_NESTED_CHILDREN) {
    setParentStream(
      'harness-nested-local-checker-stream',
      'harness-child-strategy-stream',
    );
    patchStream('harness-nested-local-checker-stream', (slice) => ({
      ...slice,
      category: AgentCategory.ToolUse,
      identity: nestedStrategyChild.identity,
      description: 'localChecker nested proof check',
      entries: makeChildEntries('localChecker', 'nested proof check'),
    }));
    setStreamStatusInCliState({
      streamId: 'harness-nested-local-checker-stream',
      status: STREAM_PHASE.RUNNING,
      nowMs: nestedStartedAt,
    });
  }
}

if (SHOW_TODOS) {
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
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
  }));
  const workPlan = streams.get().get(STREAM_ID)!;
  defaultSession().events.emit({
    scope: 'run',
    streamId: STREAM_ID,
    event: {
      type: 'updateTodos',
      streamId: STREAM_ID,
      todos: [...workPlan.todos],
    },
  });
  defaultSession().events.emit({
    scope: 'run',
    streamId: STREAM_ID,
    event: {
      type: 'updatePlan',
      streamId: STREAM_ID,
      plan: workPlan.plan,
    },
  });
}

if (SHOW_EDIT_APPROVAL) {
  const showApproval = () =>
    enqueueHarnessApproval(
      { kind: 'toolEdit', payload: makeEditApprovalRequest() },
      applyHarnessApprovalDecision,
    );

  if (EDIT_APPROVAL_DELAY_MS > 0) {
    globalThis.setTimeout(showApproval, EDIT_APPROVAL_DELAY_MS);
  } else {
    showApproval();
  }
}

if (SHOW_BASH_APPROVAL) {
  const showApproval = (index = 1) =>
    enqueueApproval(
      {
        kind: 'bash',
        payload: makeBashApprovalPayload(index),
      },
      { onPresent: () => notify('approvalNeeded') },
    );
  const showRepeatedApprovals = async (): Promise<void> => {
    const decision = await showApproval(1);
    applyHarnessApprovalDecision(decision);
    if (!decision.accepted) return;
    const secondDecision = await showApproval(2);
    applyHarnessApprovalDecision(secondDecision);
    appendHarnessAssistantTranscript(
      secondDecision.accepted ? 'SECOND-BASH-APPROVED' : 'SECOND-BASH-REJECTED',
    );
  };
  const startApprovals = () => {
    if (SHOW_REPEATED_BASH_APPROVAL) {
      void showRepeatedApprovals().catch(() => undefined);
      return;
    }
    void showApproval(1).then(applyHarnessApprovalDecision);
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

let harnessRetryRuntimeHost: CliRuntimeHost | undefined;
if (SHOW_RETRY_APPROVAL) {
  await saveProviderApiKey('openai', 'sk-harness-openai-key');
  harnessRetryRuntimeHost = createCliRuntimeHost(HARNESS_CLI_CONTEXT);
  HARNESS_DISPOSERS.push(
    defaultSession().useHostInteractions(
      createTuiHostInteractions(harnessRetryRuntimeHost, HARNESS_CLI_CONTEXT),
    ),
  );
  let credentialSelection: 'configured' | 'personal' | undefined;
  void defaultSession()
    .interactions.requestRetry(makeRetryApprovalPayload(), {
      prepareRetry: async (selection) => {
        credentialSelection = selection;
      },
    })
    .then((result) => appendHarnessRetryResult(result, credentialSelection));
}

if (SHOW_EXTERNAL_INQUIRY) {
  enqueueHarnessApproval(
    {
      kind: 'externalInquiry',
      payload: {
        requestId: 'harness-external-inquiry',
        mode: 'followUp' as const,
        question: EXTERNAL_INQUIRY_QUESTION,
        threadId: EXTERNAL_INQUIRY_THREAD_ID,
        allowBypass: false,
        streamId: STREAM_ID,
      },
    },
    appendHarnessExternalInquiryDecision,
  );
}

if (SHOW_USER_QUESTION) {
  enqueueHarnessApproval(
    { kind: 'userQuestion', payload: makeUserQuestionPayload() },
    applyHarnessApprovalDecision,
  );
}

if (SHOW_PLAN_APPROVAL) {
  enqueueHarnessApproval(
    { kind: 'planApproval', payload: makePlanApprovalPayload() },
    appendHarnessPlanDecision,
  );
}

if (SHOW_AGENT_PROPOSAL) {
  enqueueHarnessApproval(
    { kind: 'proposal', payload: makeAgentProposalPayload() },
    applyHarnessApprovalDecision,
  );
}

function markHarnessInterrupted(): void {
  canInterrupt = false;
  rootRunPending.set(false);
  const childStreamIds = new Set(
    visibleSubagentRows(STREAM_ID, childStreamEntries.get(), streams.get())
      .map((child) => child.childStreamId)
      .filter((streamId): streamId is string => streamId !== undefined),
  );
  // Clear active roster membership through the real transition function;
  // each retained row's status comes from its own StreamSlice, set by the
  // per-child patchStream loop below.
  projectChildRoster(STREAM_ID, []);
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      {
        id: 'harness-interrupted',
        role: 'assistant',
        text: 'Harness interrupt requested.',
        finalized: true,
      },
    ],
  }));
  setStreamStatusInCliState({
    streamId: STREAM_ID,
    status: STREAM_PHASE.CANCELLED,
    nowMs: undefined,
  });
  for (const streamId of childStreamIds) {
    setStreamStatusInCliState({
      streamId: streamId,
      status: STREAM_PHASE.CANCELLED,
      nowMs: undefined,
    });
  }
}

function canInterruptHarnessStream(streamId: StreamTabId): boolean {
  return isInFlightPhase(streams.get().get(streamId)?.status);
}

function markHarnessStreamInterrupted(streamId: StreamTabId): void {
  clearApprovalsWhere(
    (payload) => approvalPayloadStreamId(payload) === streamId,
  );
  if (streamId === STREAM_ID) {
    canInterrupt = false;
    rootRunPending.set(false);
  } else {
    projectChildRoster(
      STREAM_ID,
      activeSubagentsFor(
        STREAM_ID,
        childStreamEntries.get(),
        streams.get(),
      ).filter((child) => child.childStreamId !== streamId),
    );
  }
  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      {
        id: `harness-focused-interrupted-${streamId}`,
        role: 'assistant',
        text: `Harness focused interrupt requested for ${streamId}.`,
        finalized: true,
      },
    ],
  }));
  setStreamStatusInCliState({
    streamId: streamId,
    status: STREAM_PHASE.CANCELLED,
    nowMs: undefined,
  });
  defaultSession().status.transition(
    streamId,
    STREAM_PHASE.CANCELLED,
    STREAM_TRANSITION_CAUSE.USER_STOP,
  );
}

function appendHarnessAssistantTranscript(
  text: string,
  streamId?: StreamTabId,
): void {
  appendHarnessTranscript('assistant', text, streamId);
}

function appendHarnessChildSubmitAck(
  text: string,
  streamId: StreamTabId,
): void {
  const isLive = isActivePhase(streams.get().get(streamId)?.status);
  appendHarnessTranscript('assistant', text, streamId, { finalized: !isLive });
}

function appendHarnessTranscript(
  role: 'assistant' | 'error' | 'user',
  text: string,
  explicitStreamId?: StreamTabId,
  options: { readonly finalized?: boolean } = {},
): void {
  const streamId = explicitStreamId ?? defaultHarnessTranscriptStreamId();
  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        `harness-local-${Date.now()}-${slice.entries.length}`,
        text,
        role,
        options.finalized,
      ),
    ],
  }));
}

function defaultHarnessTranscriptStreamId(): StreamTabId {
  return resolveLocalTranscriptStreamId({
    activeStreamId: activeStreamIdSignal.get(),
    fallbackStreamId: STREAM_ID,
    parentStream: parentStream.get(),
    rootStreamId: rootStreamId.get(),
  });
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

function getHarnessModelSwitchDisabledReason(
  model: string,
): string | undefined {
  return DISABLED_MODEL_SWITCHES.has(model)
    ? DISABLED_MODEL_SWITCH_REASON
    : undefined;
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
  const parentSlice = streams.get().get(STREAM_ID);
  if (!parentSlice) return;

  const activeSubagentRows = activeSubagentsFor(
    STREAM_ID,
    childStreamEntries.get(),
    streams.get(),
  );
  const executionRows = [
    ...activeSubagentRows,
    ...visibleSubagentRows(STREAM_ID, childStreamEntries.get(), streams.get()),
  ];
  const executionRow = executionRows.find(
    (child) => child.executionId === executionId,
  );
  if (!executionRow) return;

  const messageId = `harness-killed-${executionId}-${Date.now()}`;
  projectChildRoster(
    STREAM_ID,
    activeSubagentRows.filter((child) => child.executionId !== executionId),
  );
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        messageId,
        `Harness kill requested for ${executionId}.`,
      ),
    ],
  }));

  if (!executionRow.childStreamId) return;
  patchStream(executionRow.childStreamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        `${messageId}-${executionRow.childStreamId}`,
        'Harness kill requested for this sub-workflow.',
      ),
    ],
  }));
  setStreamStatusInCliState({
    streamId: executionRow.childStreamId,
    status: STREAM_PHASE.CANCELLED,
    nowMs: undefined,
  });
}

function handleHarnessSubmit(line: string): void {
  if (handleHarnessSlashCommand(line)) return;
  const focusedChildRoute = focusedChildFollowUpRoute({
    activeStreamId: activeStreamIdSignal.get(),
    parentStream: parentStream.get(),
    streams: streams.get(),
  });
  if (focusedChildRoute.kind === 'reject') {
    appendHarnessAssistantTranscript(
      FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
      focusedChildRoute.streamId,
    );
    return;
  }
  if (focusedChildRoute.kind === 'accept') {
    appendHarnessChildSubmitAck(
      `Harness received: ${line}`,
      focusedChildRoute.streamId,
    );
    return;
  }
  appendHarnessAssistantTranscript(`Harness received: ${line}`);
}

function appendHarnessStatus(): void {
  const meta = sessionMeta.get();
  const streamId = activeStreamIdSignal.get() ?? STREAM_ID;
  const slice = streams.get().get(streamId);
  appendHarnessAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent,
      model: meta.model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        apiMode: meta.apiMode,
        subscriptionActive: false,
        usageRoute: slice?.usage?.usageRoute,
      }),
      approval: formatTexraApprovalPolicy(harnessRuntimeSession.approvalPolicy),
      approvalBypasses: slice?.bypass,
      status: slice?.status,
      goal: GoalStore.getForStream(streamId),
      queuedFollowUpMessages: defaultSession().followUps.getAll(streamId),
    }),
  );
}

function resetHarnessForClear(): void {
  const meta = sessionMeta.get();
  clearApprovals();
  harnessFollowUpQueue.drainItems();
  void GoalStore.forget(STREAM_ID);
  const store = defaultSession().transcripts;
  for (const streamId of streams.get().keys()) {
    store.delete(streamId).catch(() => {
      // The harness reset is best-effort; visible cliState is reset below.
    });
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
  canSelectAgent: () => CAN_SELECT_AGENT,
  canSelectModel: () => CAN_SELECT_MODEL,
  getModelSwitchDisabledReason: getHarnessModelSwitchDisabledReason,
  getApprovalPolicy: () => harnessRuntimeSession.approvalPolicy,
  onApprovalPolicySelect: setHarnessApprovalPolicy,
  onModelSelect: (model) => {
    setCliSessionModelOverride(model);
    appendHarnessAssistantTranscript(
      `Harness model selected. Future turns: ${model}.`,
    );
  },
  onModelAccessSelect: (selection) => {
    if (selection.kind === 'subscription-preference') {
      if (selection.provider === 'kimi-code' && selection.state === 'on') {
        return updateCliModelAccess(
          { ...HARNESS_CLI_CONTEXT, apiMode: sessionMeta.get().apiMode },
          selection,
          { writeProgress: appendHarnessAssistantTranscript },
        ).then((access) => {
          sessionMeta.set({ ...sessionMeta.get(), apiMode: access.apiMode });
          appendHarnessAssistantTranscript(access.message);
        });
      }
      appendHarnessAssistantTranscript(
        `${selection.provider} preference set to ${selection.state}.`,
      );
      return;
    }
    sessionMeta.set({ ...sessionMeta.get(), apiMode: selection.apiMode });
    appendHarnessAssistantTranscript(
      `API fallback set to ${selection.apiMode}.`,
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
rootRunStartAvailable.set(CAN_SELECT_AGENT);
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
      canInterruptActiveRun={() => canInterrupt}
      canInterruptStream={canInterruptHarnessStream}
      canStopActiveRun={() => canInterrupt}
      colorEnabled={HARNESS_COLOR_ENABLED}
      history={HARNESS_INPUT_HISTORY}
      onInterruptActive={markHarnessInterrupted}
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

if (CHILD_EVENT_ORDER || SHOW_WORKFLOW_TIMELINE || SHOW_WORKFLOW_RUNNING) {
  // Mirror real CLI startup: `runChatTui.tsx` installs
  // the session adapter before `subscribeStreamStatus()` once per TUI
  // session.
  HARNESS_DISPOSERS.push(
    attachSessionSignalsAdapter({
      events: defaultSession().events,
      session: defaultSession(),
      snapshots: defaultSession().snapshots,
    }),
  );
}
HARNESS_DISPOSERS.push(subscribeStreamStatus());

if (SHOW_WORKFLOW_TIMELINE) {
  seedWorkflowTimeline();
}

if (SHOW_WORKFLOW_RUNNING) {
  seedRunningWorkflow();
}

if (SHOW_PROCESS_CHILD) {
  seedRunningProcessChild();
}

if (CHILD_EVENT_ORDER) {
  void runChildEventOrderFixture(ink, CHILD_EVENT_ORDER).catch((error) => {
    process.stderr.write(
      `[tui-harness] HARNESS_CHILD_EVENT_ORDER failed: ${toErrorMessage(error)}\n`,
    );
    void exitHarness(1);
  });
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
    await harnessRetryRuntimeHost?.close();
    await tryPlatform()?.lifecycle.runShutdown();
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', handleHarnessCtrlC);
