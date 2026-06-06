// Test harness: seed cliState with synthetic finalized entries, render <App />
// to the real terminal. Used to verify the ConversationPane viewport without
// needing API access. Exits on Ctrl-C.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { render } from 'ink';
import React from 'react';

import { getToolUseAgents, getWorkflowAgents, loadAgents } from '@agent/index';
import { getWorkspaceState } from '@agent/core/stateStore';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { SupabaseClient } from '@auth/SupabaseClient';
import { isInFlightStatus } from '@common/constants/streamStatus';
import { toErrorMessage } from '@common/errors';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { tryPlatform } from '@platform/platform';
import {
  AGENT_CATEGORY,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_STATUS,
  STREAM_LOG_ENTRY_TYPES,
  TODO_STATUS,
  TOOL_USE_STATUS,
  type ActiveChildInfo,
  type ExternalInquiryThreadId,
  type NormalizedToolUse,
  type RetryPermission,
  type StreamTabId,
  type UserQuestionPermission,
} from '@shared/schemas';
import { buildContinuationText } from '@tools/inquiry/inquiryContinuation';
import { getDefaultStreamLogStore } from '@transcript';

import { App } from '../src/chat/tui/App';
import {
  transcriptViewportRepaintOptions,
  type TranscriptViewportChange,
} from '../src/chat/tui/state/transcriptViewportMode';
import { registerBuiltinSlashCommands } from '../src/chat/tui/commands/registerBuiltins';
import {
  listSlashCommands,
  parseSlashInput,
  type SlashCommand,
} from '../src/chat/tui/commands/slashRegistry';
import { formatApprovalPolicyForCli } from '../src/chat/tui/forms/ApprovalPolicyForm';
import {
  cliState,
  patchStream,
  setParentStream,
  type ConversationEntry,
} from '../src/chat/tui/state/cliState';
import { formatCliSessionStatus } from '../src/chat/tui/sessionStatus';
import { notify } from '../src/chat/tui/notifications/terminalNotifier';
import { tuiOutputStreamForColor } from '../src/chat/tui/render/noColorOutput';
import {
  enqueueApproval,
  type ApprovalDecision,
} from '../src/chat/tui/state/approvalQueue';
import { syncStreamLog } from '../src/chat/tui/state/subscribeStreamLog';
import { effectiveStreamStatus } from '../src/chat/tui/state/streamStatus';
import { OrchestrationApp } from '../src/orchestration/runOrchestrationTui';
import { parseCliApiMode, type CliApiMode } from '../src/runtime/apiAccessMode';
import type { CliModelAccess } from '../src/runtime/modelAccess';
import {
  cliMultiAgentPresets,
  planCliMultiAgentPresets,
} from '../src/runtime/multiAgentPresets';
import { buildCliOrchestrationItems } from '../src/runtime/orchestration';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../src/schemas/cliSettings';
import { initLocalCliPlatform } from '../src/runtime/initPlatform';
import { resolveCliResourcesPath } from '../src/runtime/resourcesPath';

const STREAM_ID = 'harness-stream-1';
const HARNESS_APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
const HARNESS_YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';
const ENTRY_COUNT = Number(process.env.HARNESS_ENTRIES ?? '15');
const SHOW_EDIT_APPROVAL = process.env.HARNESS_EDIT_APPROVAL === '1';
const SHOW_BASH_APPROVAL = process.env.HARNESS_BASH_APPROVAL === '1';
const SHOW_RETRY_APPROVAL = process.env.HARNESS_RETRY_APPROVAL === '1';
const SHOW_EXTERNAL_INQUIRY = process.env.HARNESS_EXTERNAL_INQUIRY === '1';
const SHOW_USER_QUESTION = process.env.HARNESS_USER_QUESTION === '1';
const SHOW_PLAN_APPROVAL = process.env.HARNESS_PLAN_APPROVAL === '1';
const SHOW_AGENT_PROPOSAL = process.env.HARNESS_AGENT_PROPOSAL === '1';
const PLAN_APPROVAL_ODYSSEY = process.env.HARNESS_PLAN_APPROVAL_ODYSSEY === '1';
const SHOW_SUBAGENT_FOLLOWUPS = process.env.HARNESS_SUBAGENT_FOLLOWUPS === '1';
const SHOW_LONG_TOOL_OUTPUT = process.env.HARNESS_LONG_TOOL_OUTPUT === '1';
const SHOW_PROJECT_SKILL = process.env.HARNESS_PROJECT_SKILL === '1';
const WIDE_TRANSCRIPT_SUFFIX =
  ' hidden-middle wide-column-A wide-column-B wide-column-C wide-column-D wide-column-E wide-column-F';
const SHOW_REJECTED_BASH_TOOL = process.env.HARNESS_REJECTED_BASH_TOOL === '1';
const SHOW_LONG_CHILD_OUTPUT = process.env.HARNESS_LONG_CHILD_OUTPUT === '1';
const SHOW_WIDE_FIRST_CHILD_LINE =
  process.env.HARNESS_WIDE_FIRST_CHILD_LINE === '1';
const SHOW_ORCHESTRATION = process.env.HARNESS_ORCHESTRATION === '1';
const SHOW_NO_RUNNABLE_ORCHESTRATION_MODELS =
  process.env.HARNESS_NO_RUNNABLE_MODELS === '1';
const HARNESS_API_MODE_FROM_ENV = parseCliApiMode(
  process.env.HARNESS_API_MODE ?? '',
);
const HARNESS_API_MODE: CliApiMode = HARNESS_API_MODE_FROM_ENV ?? 'personal';
const HARNESS_AUTHENTICATED = process.env.HARNESS_AUTHENTICATED?.trim();
const BASH_APPROVAL_COMMAND =
  process.env.HARNESS_BASH_APPROVAL_COMMAND ?? 'npm run compile:safe';
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
const EXTERNAL_INQUIRY_THREAD_ID = 'ei_123456abcdef' as ExternalInquiryThreadId;
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
const SHOW_TODOS = process.env.HARNESS_TODOS === '1';
const SHOW_IDLE_TODOS = process.env.HARNESS_TODOS_IDLE === '1';
const FAILED_CHILD_AGENT = process.env.HARNESS_FAILED_CHILD?.trim();
const TEAM_NAME = process.env.HARNESS_TEAM_NAME?.trim() || undefined;
let canInterrupt = process.env.HARNESS_CAN_INTERRUPT === '1';
let harnessApprovalPolicy: CliApprovalPolicy = 'ask';
const EDIT_APPROVAL_DELAY_MS = Number(
  process.env.HARNESS_EDIT_APPROVAL_DELAY_MS ?? '0',
);
const QUEUED_FOLLOW_UPS = parseList(process.env.HARNESS_QUEUED_FOLLOWUPS);
const HARNESS_FOLLOW_UP_QUEUE = ToolUseFollowUpQueue.acquire(STREAM_ID);
const HARNESS_CWD_INPUT = process.env.HARNESS_CWD?.trim();
// Keep platform state writes out of the repository unless a scenario opts in.
const HARNESS_CWD =
  HARNESS_CWD_INPUT || mkdtempSync(path.join(tmpdir(), 'texra-tui-harness-'));
const HARNESS_COLOR_ENABLED = process.env.HARNESS_COLOR_ENABLED !== '0';
const HARNESS_STDOUT = tuiOutputStreamForColor(
  process.stdout,
  HARNESS_COLOR_ENABLED,
);
if (!HARNESS_CWD_INPUT && process.env.HARNESS_KEEP_CWD !== '1') {
  process.once('exit', () => {
    rmSync(HARNESS_CWD, { recursive: true, force: true });
  });
}
for (const followUp of QUEUED_FOLLOW_UPS) {
  HARNESS_FOLLOW_UP_QUEUE.enqueue(followUp);
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

if (SHOW_PROJECT_SKILL) {
  seedHarnessProjectSkill();
}

await initLocalCliPlatform({
  apiMode: HARNESS_API_MODE,
  cwd: HARNESS_CWD,
  installSignalHandlers: false,
  resourcesPath: resolveCliResourcesPath(),
  storageRoot: path.join(HARNESS_CWD, '.texra-storage'),
  helperModel: 'harness-model',
});
if (process.env.HARNESS_VISIBLE_TOOL_USE_AGENTS !== undefined) {
  await getWorkspaceState().update(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
    HARNESS_VISIBLE_TOOL_USE_AGENTS,
  );
}
await loadAgents({ includeRemote: false });

const HARNESS_ORCHESTRATION_ITEMS = buildCliOrchestrationItems({
  presetPlans: planCliMultiAgentPresets(cliMultiAgentPresets(undefined), {
    workflowAgents: getWorkflowAgents(),
    toolUseAgents: getToolUseAgents(),
  }),
  history: [],
  toolUseAgents: getToolUseAgents(),
});

type HarnessModelFixture = Readonly<{
  value: string;
  label: string;
  availability: NonNullable<CliModelAccess['model']['availability']>;
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
];

function isHarnessModelAvailable(
  availability: HarnessModelFixture['availability'],
  apiMode: CliApiMode,
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
  apiMode: CliApiMode,
): CliModelAccess {
  return {
    model: fixture,
    available: isHarnessModelAvailable(fixture.availability, apiMode),
    status: harnessModelStatus(fixture.availability),
  };
}

function harnessOrchestrationModels(
  apiMode: CliApiMode,
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

if (SHOW_ORCHESTRATION) {
  const instance = render(
    <OrchestrationApp
      items={HARNESS_ORCHESTRATION_ITEMS}
      models={
        HARNESS_API_MODE_FROM_ENV
          ? harnessOrchestrationModels(HARNESS_API_MODE)
          : []
      }
      apiMode={HARNESS_API_MODE}
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
    parsed: {},
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

function makeRejectedBashToolEntries(): ConversationEntry[] {
  const command = "printf 'approval-reject-live\\n'";
  const message = `User rejected bash command: ${command}`;
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
        parsed: {},
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
  const store = getDefaultStreamLogStore();
  const timestamp = Date.now();
  const followups = [
    '<subagent-progress id="child-a" agent="strategy" type="round" current="2" total="3" />',
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
    store.append(STREAM_ID, {
      id: `harness-subagent-followup-${index}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: timestamp + index,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: `<orchestrator-followup>${text}</orchestrator-followup>`,
    });
  }
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

function stoppedChild(child: ActiveChildInfo): ActiveChildInfo {
  return {
    ...child,
    status: STREAM_STATUS.STOPPED,
    startedAt: undefined,
  };
}

function stopMatchingChild(
  child: ActiveChildInfo,
  executionId: string,
): ActiveChildInfo {
  return child.executionId === executionId ? stoppedChild(child) : child;
}

function isDifferentExecution(
  child: ActiveChildInfo,
  executionId: string,
): boolean {
  return child.executionId !== executionId;
}

function harnessMessageEntry(
  id: string,
  text: string,
  role: ConversationEntry['role'] = 'assistant',
): ConversationEntry {
  return {
    id,
    role,
    text,
    finalized: true,
  };
}

function makeEditApprovalRequest() {
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

function makeBashApprovalPayload() {
  return {
    requestId: 'harness-bash-approval',
    command: BASH_APPROVAL_COMMAND,
    allowBypass: true,
    streamId: STREAM_ID,
  };
}

function makeRetryApprovalPayload(): RetryPermission {
  return {
    streamId: STREAM_ID,
    operation: 'Tool-use call',
    errorMessage: 'HTTP 429 Too Many Requests',
    errorDetails: {
      isCredentialExhausted: true,
      isRelayError: true,
      statusCode: 429,
    },
  };
}

function makePlanApprovalPayload() {
  return {
    approvalId: 'harness-plan-approval',
    streamId: STREAM_ID,
    odysseyEnabled: PLAN_APPROVAL_ODYSSEY,
    plan: {
      summary: 'Coordinate a short math proof through CLI chat.',
      steps: [
        {
          title: 'Split the finite and symbolic cases',
          description:
            'Separate the bounded search from the algebraic simplification.',
          files: ['proof.md'],
          status: TODO_STATUS.PENDING,
        },
        {
          title: 'Ask a checker to verify the enumeration',
          description: 'Use a delegated agent before writing the final answer.',
          files: [],
          status: TODO_STATUS.PENDING,
        },
      ],
    },
  };
}

function makeAgentProposalPayload() {
  return {
    proposalId: 'harness-agent-proposal',
    streamId: STREAM_ID,
    agentCategory: AGENT_CATEGORY.TOOL_USE,
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

function applyHarnessApprovalDecision(decision: ApprovalDecision): void {
  if (decision.accepted && decision.bypass === 'bash') {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { ...slice.bypass, bash: true },
    }));
  }
  if (decision.accepted && decision.bypass === 'toolEdit') {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      bypass: { ...slice.bypass, toolEdit: true },
    }));
  }
}

function appendHarnessExternalInquiryDecision(
  decision: ApprovalDecision,
): void {
  appendHarnessUserTranscript(
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

function appendHarnessRetryDecision(decision: ApprovalDecision): void {
  if (decision.accepted && decision.apiMode) {
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      apiMode: decision.apiMode,
    });
    appendHarnessAssistantTranscript(`RETRY-API-MODE ${decision.apiMode}`);
    return;
  }
  appendHarnessAssistantTranscript(
    decision.accepted ? 'RETRY-APPROVED' : 'RETRY-REJECTED',
  );
}

function appendHarnessPlanDecision(decision: ApprovalDecision): void {
  if (decision.planAction === 'approve_and_odyssey') {
    appendHarnessAssistantTranscript('PLAN-ODYSSEY');
    return;
  }
  appendHarnessAssistantTranscript(
    decision.accepted ? 'PLAN-APPROVED' : 'PLAN-REJECTED',
  );
}

cliState.sessionMeta.set({
  agent: 'chat',
  model: 'harness-model',
  cwd: HARNESS_CWD,
  apiMode: HARNESS_API_MODE,
  canDelegate: CAN_DELEGATE,
  teamName: TEAM_NAME,
  version: '0.0.0-harness',
});
cliState.activeStreamId.set(STREAM_ID);
patchStream(STREAM_ID, (slice) => ({
  ...slice,
  status:
    QUEUED_FOLLOW_UPS.length > 0 || (SHOW_TODOS && !SHOW_IDLE_TODOS)
      ? STREAM_STATUS.RUNNING
      : SHOW_TODOS && SHOW_IDLE_TODOS
        ? STREAM_STATUS.WAITING
        : slice.status,
  runStartedAt:
    QUEUED_FOLLOW_UPS.length > 0 || (SHOW_TODOS && !SHOW_IDLE_TODOS)
      ? Date.now() - 42_000
      : slice.runStartedAt,
  entries: SHOW_REJECTED_BASH_TOOL
    ? makeRejectedBashToolEntries()
    : SHOW_LONG_TOOL_OUTPUT
      ? makeLongToolOutputEntries()
      : makeEntries(ENTRY_COUNT),
  queuedFollowUps: QUEUED_FOLLOW_UPS.length,
  queuedFollowUpMessages: QUEUED_FOLLOW_UPS,
}));

if (SHOW_SUBAGENT_FOLLOWUPS) {
  seedSubagentFollowupTranscript();
}

if (SHOW_CHILDREN) {
  const startedAt = Date.now() - 74_000;
  const nestedStartedAt = startedAt + 24_000;
  const nestedStrategyChild = {
    executionId: 'harness-nested-local-checker',
    agentName: 'localChecker',
    childStreamId: 'harness-nested-local-checker-stream',
    status: STREAM_STATUS.RUNNING,
    startedAt: nestedStartedAt,
  };
  const nestedStrategyProcess = {
    executionId: 'harness-nested-proof-audit',
    agentName: 'proof audit',
    toolName: 'bash',
    status: STREAM_STATUS.RUNNING,
    startedAt: Date.now() - 9_000,
  };
  const childStreams = [
    {
      executionId: 'harness-child-strategy',
      agentName: 'strategy',
      childStreamId: 'harness-child-strategy-stream',
      status: STREAM_STATUS.RUNNING,
      startedAt,
    },
    {
      executionId: 'harness-child-lean',
      agentName: 'leanSolver',
      childStreamId: 'harness-child-lean-stream',
      status: STREAM_STATUS.WAITING,
      elapsed: '2m 03s',
    },
    {
      executionId: 'harness-child-review',
      agentName: 'reviewer',
      childStreamId: 'harness-child-review-stream',
      status: STREAM_STATUS.RUNNING,
      startedAt: startedAt + 12_000,
    },
  ].map((child) =>
    child.agentName === FAILED_CHILD_AGENT
      ? {
          ...child,
          status: STREAM_STATUS.ERROR,
          startedAt: undefined,
          elapsed: null,
        }
      : child,
  );
  const activeSubagents = childStreams.filter(
    (child) => child.status !== STREAM_STATUS.ERROR,
  );
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    status: STREAM_STATUS.RUNNING,
    runStartedAt: startedAt,
    activeSubagents,
    childStreams,
    activeProcesses: [
      {
        executionId: 'harness-process-latexmk',
        agentName: 'latex build',
        toolName: 'bash',
        status: STREAM_STATUS.RUNNING,
        startedAt: Date.now() - 19_000,
      },
    ],
    processOutput: new Map([
      [
        'harness-process-latexmk',
        {
          stdout: [
            'latexmk: applying rule pdflatex',
            'chapter1.tex:47: Overfull hbox',
            'main.tex: Proof sketch needs one missing reference',
          ].join('\n'),
          stderr: '',
        },
      ],
    ]),
  }));
  for (const child of childStreams) {
    const streamId = child.childStreamId;
    const addNestedChildren =
      SHOW_NESTED_CHILDREN && child.agentName === 'strategy';
    setParentStream(streamId, STREAM_ID);
    patchStream(streamId, (slice) => ({
      ...slice,
      status: child.status,
      description: `${child.agentName} sub-workflow`,
      activeSubagents: addNestedChildren
        ? [nestedStrategyChild]
        : slice.activeSubagents,
      childStreams: addNestedChildren
        ? [nestedStrategyChild]
        : slice.childStreams,
      activeProcesses: addNestedChildren
        ? [nestedStrategyProcess]
        : slice.activeProcesses,
      processOutput: addNestedChildren
        ? new Map([
            [
              'harness-nested-proof-audit',
              {
                stdout: [
                  'proof-audit: checking nested child result',
                  'nested-checker: verified lemma bound',
                ].join('\n'),
                stderr: '',
              },
            ],
          ])
        : slice.processOutput,
      entries: makeChildEntries(child.agentName, child.executionId),
      runStartedAt:
        child.status === STREAM_STATUS.RUNNING ? child.startedAt : undefined,
    }));
  }
  if (SHOW_NESTED_CHILDREN) {
    setParentStream(
      'harness-nested-local-checker-stream',
      'harness-child-strategy-stream',
    );
    patchStream('harness-nested-local-checker-stream', (slice) => ({
      ...slice,
      status: STREAM_STATUS.RUNNING,
      description: 'localChecker nested proof check',
      entries: makeChildEntries('localChecker', 'nested proof check'),
      runStartedAt: nestedStartedAt,
    }));
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
        status: TODO_STATUS.IN_PROGRESS,
      },
      {
        content: 'Merge subagent conclusions into final answer',
        activeForm: 'Merging subagent conclusions',
        status: TODO_STATUS.PENDING,
      },
    ],
    plan: {
      summary: 'Coordinate a small math proof through nested CLI work.',
      steps: [
        {
          title: 'Route proof obligations',
          description: 'Choose the right specialist for each proof branch.',
          files: [],
          status: TODO_STATUS.COMPLETED,
        },
        {
          title: 'Check formalizable parts',
          description: 'Have a subagent inspect the Lean-style finite case.',
          files: [],
          status: TODO_STATUS.IN_PROGRESS,
        },
      ],
    },
  }));
}

if (SHOW_EDIT_APPROVAL) {
  const showApproval = () =>
    void enqueueApproval(
      {
        kind: 'toolEdit',
        request: makeEditApprovalRequest(),
      },
      { onPresent: () => notify({ kind: 'approvalNeeded' }) },
    ).then(applyHarnessApprovalDecision);

  if (EDIT_APPROVAL_DELAY_MS > 0) {
    setTimeout(showApproval, EDIT_APPROVAL_DELAY_MS);
  } else {
    showApproval();
  }
}

if (SHOW_BASH_APPROVAL) {
  void enqueueApproval(
    {
      kind: 'bash',
      payload: makeBashApprovalPayload(),
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(applyHarnessApprovalDecision);
}

if (SHOW_RETRY_APPROVAL) {
  void enqueueApproval(
    {
      kind: 'retry',
      payload: makeRetryApprovalPayload(),
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(appendHarnessRetryDecision);
}

if (SHOW_EXTERNAL_INQUIRY) {
  void enqueueApproval(
    {
      kind: 'externalInquiry',
      payload: {
        requestId: 'harness-external-inquiry',
        question: EXTERNAL_INQUIRY_QUESTION,
        threadId: EXTERNAL_INQUIRY_THREAD_ID,
        allowBypass: false,
        streamId: STREAM_ID,
      },
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(appendHarnessExternalInquiryDecision);
}

if (SHOW_USER_QUESTION) {
  void enqueueApproval(
    {
      kind: 'userQuestion',
      payload: makeUserQuestionPayload(),
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(applyHarnessApprovalDecision);
}

if (SHOW_PLAN_APPROVAL) {
  void enqueueApproval(
    {
      kind: 'plan',
      payload: makePlanApprovalPayload(),
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(appendHarnessPlanDecision);
}

if (SHOW_AGENT_PROPOSAL) {
  void enqueueApproval(
    {
      kind: 'proposal',
      payload: makeAgentProposalPayload(),
    },
    { onPresent: () => notify({ kind: 'approvalNeeded' }) },
  ).then(applyHarnessApprovalDecision);
}

function markHarnessInterrupted(): void {
  canInterrupt = false;
  const parentSlice = cliState.streams.get().get(STREAM_ID);
  const childStreamIds = new Set(
    [
      ...(parentSlice?.activeSubagents ?? []),
      ...(parentSlice?.childStreams ?? []),
    ]
      .map((child) => child.childStreamId)
      .filter((streamId): streamId is string => streamId !== undefined),
  );
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    status: STREAM_STATUS.STOPPED,
    runStartedAt: undefined,
    activeSubagents: [],
    activeProcesses: [],
    childStreams: slice.childStreams.map(stoppedChild),
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
  for (const streamId of childStreamIds) {
    patchStream(streamId, (slice) => ({
      ...slice,
      status: STREAM_STATUS.STOPPED,
      runStartedAt: undefined,
    }));
  }
}

function appendHarnessAssistantTranscript(text: string): void {
  appendHarnessTranscript('assistant', text);
}

function appendHarnessUserTranscript(text: string): void {
  appendHarnessTranscript('user', text);
}

function appendHarnessTranscript(
  role: ConversationEntry['role'],
  text: string,
): void {
  const streamId = cliState.activeStreamId.get() ?? STREAM_ID;
  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        `harness-local-${Date.now()}-${slice.entries.length}`,
        text,
        role,
      ),
    ],
  }));
}

function harnessActiveChildStreamId(): StreamTabId | undefined {
  const activeStreamId = cliState.activeStreamId.get();
  if (!activeStreamId) return undefined;
  return cliState.parentStream.get().has(activeStreamId)
    ? activeStreamId
    : undefined;
}

function harnessRejectsFocusedChildSubmit(): boolean {
  const childStreamId = harnessActiveChildStreamId();
  if (!childStreamId) return false;
  const status = effectiveStreamStatus(childStreamId);
  return status !== undefined && !isInFlightStatus(status);
}

function findRegisteredSlashCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return listSlashCommands().find(
    (command) =>
      command.name.toLowerCase() === lower ||
      command.aliases?.some((alias) => alias.toLowerCase() === lower) === true,
  );
}

function formatHarnessSlashHelp(): string {
  return listSlashCommands()
    .map((command) => `/${command.name} - ${command.description}`)
    .join('\n');
}

function parseHarnessApprovalPolicy(
  input: string,
): CliApprovalPolicy | undefined {
  const normalized = input.trim().toLowerCase();
  if ((CLI_APPROVAL_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as CliApprovalPolicy;
  }
  switch (normalized) {
    case 'default':
    case 'interactive':
    case 'on':
      return 'ask';
    case 'off':
    case 'deny':
      return 'never';
    case 'auto':
    case 'full':
    case 'danger':
      return 'yolo';
    default:
      return undefined;
  }
}

function setHarnessApprovalPolicy(policy: CliApprovalPolicy): void {
  harnessApprovalPolicy = policy;
  appendHarnessAssistantTranscript(
    `Approval mode set to ${formatApprovalPolicyForCli(policy)}.`,
  );
}

function getHarnessModelSwitchDisabledReason(
  model: string,
): string | undefined {
  return DISABLED_MODEL_SWITCHES.has(model)
    ? DISABLED_MODEL_SWITCH_REASON
    : undefined;
}

function openHarnessSlashForm(
  command: SlashCommand,
  remainder: string,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  cliState.activeForm.set({
    commandName: command.name,
    escapeAction: command.formEscapeAction,
    render: (close, availableRows) => (
      <Form
        availableRows={availableRows}
        remainder={remainder.trimStart()}
        onDone={() => close()}
      />
    ),
  });
  return true;
}

function openHarnessApprovalPolicyForm(remainder: string): boolean {
  const command = findRegisteredSlashCommand('approval');
  return command ? openHarnessSlashForm(command, remainder) : false;
}

function applyHarnessApprovalPolicySelection(
  input: string,
  usage: string,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    if (openHarnessApprovalPolicyForm(input)) return;
  }

  const policy = parseHarnessApprovalPolicy(normalized);
  if (!policy) {
    appendHarnessAssistantTranscript(usage);
    return;
  }

  setHarnessApprovalPolicy(policy);
}

function markHarnessExecutionStopped(executionId: string): void {
  const parentSlice = cliState.streams.get().get(STREAM_ID);
  if (!parentSlice) return;

  const executionRows = [
    ...parentSlice.activeSubagents,
    ...parentSlice.activeProcesses,
    ...parentSlice.childStreams,
  ];
  const executionRow = executionRows.find(
    (child) => child.executionId === executionId,
  );
  if (!executionRow) return;

  const messageId = `harness-killed-${executionId}-${Date.now()}`;
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    activeSubagents: slice.activeSubagents.filter((child) =>
      isDifferentExecution(child, executionId),
    ),
    activeProcesses: slice.activeProcesses.filter((child) =>
      isDifferentExecution(child, executionId),
    ),
    childStreams: slice.childStreams.map((child) =>
      stopMatchingChild(child, executionId),
    ),
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
    status: STREAM_STATUS.STOPPED,
    runStartedAt: undefined,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        `${messageId}-${executionRow.childStreamId}`,
        'Harness kill requested for this sub-workflow.',
      ),
    ],
  }));
}

function handleHarnessSubmit(line: string): void {
  if (handleHarnessSlashCommand(line)) return;
  if (harnessRejectsFocusedChildSubmit()) {
    appendHarnessAssistantTranscript(
      'The selected subagent is no longer accepting follow-ups.',
    );
    return;
  }
  appendHarnessAssistantTranscript(`Harness received: ${line}`);
}

function appendHarnessStatus(): void {
  const meta = cliState.sessionMeta.get();
  const streamId = cliState.activeStreamId.get() ?? STREAM_ID;
  const slice = cliState.streams.get().get(streamId);
  appendHarnessAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent,
      model: meta.model,
      teamName: meta.teamName,
      api: meta.apiMode,
      approval: formatApprovalPolicyForCli(harnessApprovalPolicy),
      approvalBypasses: slice?.bypass,
      status: slice?.status ?? 'not started',
      queuedFollowUpMessages:
        streamId === undefined ? [] : ToolUseFollowUpQueue.getAll(streamId),
    }),
  );
}

function handleHarnessSlashCommand(line: string): boolean {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const commandName = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  switch (commandName) {
    case 'help':
      appendHarnessAssistantTranscript(formatHarnessSlashHelp());
      return true;
    case 'status':
      appendHarnessStatus();
      return true;
    case 'approval':
      applyHarnessApprovalPolicySelection(rest, HARNESS_APPROVAL_USAGE);
      return true;
    case 'yolo':
      applyHarnessApprovalPolicySelection(rest || 'yolo', HARNESS_YOLO_USAGE);
      return true;
    default: {
      const command = findRegisteredSlashCommand(commandName);
      if (!command) {
        appendHarnessAssistantTranscript(`Unknown command: /${parsed.name}`);
        return true;
      }
      if (openHarnessSlashForm(command, rest)) return true;
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
  getApprovalPolicy: () => harnessApprovalPolicy,
  onApprovalPolicySelect: setHarnessApprovalPolicy,
  onModelSelect: (model) => {
    cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), model });
    appendHarnessAssistantTranscript(
      `Harness model selected. Future turns: ${model}.`,
    );
  },
  onApiModeSelect: (apiMode) => {
    cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), apiMode });
    appendHarnessAssistantTranscript(`API mode set to ${apiMode}.`);
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
  onError: (error) => {
    appendHarnessAssistantTranscript(
      `Slash command failed: ${toErrorMessage(error)}`,
    );
  },
});
cliState.rootRunStartAvailable.set(CAN_SELECT_AGENT);

const inkRef: { current?: ReturnType<typeof render> } = {};
function repaintHarnessTranscriptViewport(
  change: TranscriptViewportChange,
): void {
  inkRef.current?.repaint(transcriptViewportRepaintOptions(change));
}

function handleHarnessCtrlC(): void {
  if (canInterrupt) {
    markHarnessInterrupted();
    return;
  }
  void exitHarness(0);
}

const ink = render(
  <App
    onSubmit={handleHarnessSubmit}
    onKillExecution={markHarnessExecutionStopped}
    canInterruptActiveRun={() => canInterrupt}
    canStopActiveRun={() => canInterrupt}
    colorEnabled={HARNESS_COLOR_ENABLED}
    onInterruptActive={markHarnessInterrupted}
    onTranscriptViewportChange={repaintHarnessTranscriptViewport}
    onCtrlC={handleHarnessCtrlC}
  />,
  {
    stdout: HARNESS_STDOUT,
    stderr: process.stderr,
    stdin: process.stdin,
    exitOnCtrlC: false,
  },
);
inkRef.current = ink;

let harnessExiting = false;
async function exitHarness(exitCode: number): Promise<void> {
  if (harnessExiting) return;
  harnessExiting = true;
  ink.unmount();
  try {
    await tryPlatform()?.lifecycle.runShutdown();
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', handleHarnessCtrlC);
