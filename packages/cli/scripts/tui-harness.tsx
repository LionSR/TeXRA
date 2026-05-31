// Test harness: seed cliState with synthetic finalized entries, render <App />
// to the real terminal. Used to verify the ConversationPane viewport without
// needing API access. Exits on Ctrl-C.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { render } from 'ink';
import React from 'react';

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { isInFlightStatus } from '@common/constants/streamStatus';
import { tryPlatform } from '@platform/platform';
import {
  AGENT_CATEGORY,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_STATUS,
  StreamStatusSchema,
  STREAM_LOG_ENTRY_TYPES,
  TODO_STATUS,
  TOOL_USE_STATUS,
  type ActiveChildInfo,
  type NormalizedToolUse,
} from '@shared/schemas';
import { getDefaultStreamLogStore } from '@transcript';

import { App } from '../src/chat/tui/App';
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
import {
  enqueueApproval,
  type ApprovalDecision,
} from '../src/chat/tui/state/approvalQueue';
import { syncStreamLog } from '../src/chat/tui/state/subscribeStreamLog';
import { OrchestrationApp } from '../src/orchestration/runOrchestrationTui';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../src/schemas/cliSettings';
import { initLocalCliPlatform } from '../src/runtime/initPlatform';
import { resolveCliResourcesPath } from '../src/runtime/resourcesPath';
import type { CliOrchestrationItem } from '../src/runtime/orchestration';

const STREAM_ID = 'harness-stream-1';
const HARNESS_APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
const HARNESS_YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';
const HARNESS_BTW_USAGE = 'Usage: /btw <message>';
const HARNESS_BTW_IDLE_MESSAGE =
  'No active run to attach a follow-up to. Send a normal message to start a run.';
const ENTRY_COUNT = Number(process.env.HARNESS_ENTRIES ?? '15');
const SHOW_EDIT_APPROVAL = process.env.HARNESS_EDIT_APPROVAL === '1';
const SHOW_BASH_APPROVAL = process.env.HARNESS_BASH_APPROVAL === '1';
const SHOW_EXTERNAL_INQUIRY = process.env.HARNESS_EXTERNAL_INQUIRY === '1';
const SHOW_PLAN_APPROVAL = process.env.HARNESS_PLAN_APPROVAL === '1';
const SHOW_AGENT_PROPOSAL = process.env.HARNESS_AGENT_PROPOSAL === '1';
const PLAN_APPROVAL_ODYSSEY = process.env.HARNESS_PLAN_APPROVAL_ODYSSEY === '1';
const SHOW_SUBAGENT_FOLLOWUPS = process.env.HARNESS_SUBAGENT_FOLLOWUPS === '1';
const BTW_IDLE = process.env.HARNESS_BTW_IDLE === '1';
const SHOW_LONG_TOOL_OUTPUT = process.env.HARNESS_LONG_TOOL_OUTPUT === '1';
const SHOW_LONG_CHILD_OUTPUT = process.env.HARNESS_LONG_CHILD_OUTPUT === '1';
const SHOW_WIDE_FIRST_CHILD_LINE =
  process.env.HARNESS_WIDE_FIRST_CHILD_LINE === '1';
const SHOW_ORCHESTRATION = process.env.HARNESS_ORCHESTRATION === '1';
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
const SHOW_CHILDREN = process.env.HARNESS_CHILDREN === '1';
const SHOW_NESTED_CHILDREN = process.env.HARNESS_NESTED_CHILDREN === '1';
const SHOW_TODOS = process.env.HARNESS_TODOS === '1';
const SHOW_IDLE_TODOS = process.env.HARNESS_TODOS_IDLE === '1';
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
if (!HARNESS_CWD_INPUT && process.env.HARNESS_KEEP_CWD !== '1') {
  process.once('exit', () => {
    rmSync(HARNESS_CWD, { recursive: true, force: true });
  });
}
for (const followUp of QUEUED_FOLLOW_UPS) {
  HARNESS_FOLLOW_UP_QUEUE.enqueue(followUp);
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('||')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const HARNESS_ORCHESTRATION_ITEMS: readonly CliOrchestrationItem[] = [
  {
    value: { kind: 'chat' },
    label: 'New chat',
    description: 'Start the default tool-use chat',
  },
  {
    value: {
      kind: 'preset',
      preset: 'lean-project',
      presetName: 'Lean Project',
    },
    label: 'Team Lean Project',
    description: 'built-in; workflow:0; tool-use:7',
  },
  {
    value: { kind: 'preset', preset: 'physicist', presetName: 'Physicist' },
    label: 'Team Physicist',
    description: 'built-in; workflow:4; tool-use:9',
  },
  {
    value: {
      kind: 'preset',
      preset: 'mathematician',
      presetName: 'Mathematician',
    },
    label: 'Team Mathematician',
    description: 'built-in; workflow:5; tool-use:7',
  },
  {
    value: {
      kind: 'preset',
      preset: 'computer-scientist',
      presetName: 'Computer Scientist',
    },
    label: 'Team Computer Scientist',
    description: 'built-in; workflow:5; tool-use:8',
  },
  {
    value: { kind: 'help' },
    label: 'Help',
    description: 'Show CLI commands',
  },
];

if (SHOW_ORCHESTRATION) {
  const instance = render(
    <OrchestrationApp
      items={HARNESS_ORCHESTRATION_ITEMS}
      onResolve={() => undefined}
    />,
    {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
    },
  );
  await instance.waitUntilExit();
  process.exit(0);
}

await initLocalCliPlatform({
  apiMode: 'personal',
  cwd: HARNESS_CWD,
  installSignalHandlers: false,
  resourcesPath: resolveCliResourcesPath(),
  storageRoot: path.join(HARNESS_CWD, '.texra-storage'),
  helperModel: 'harness-model',
});

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
        `tool-output-line-${String(index + 1).padStart(2, '0')}${index === 9 ? ' hidden-middle' : ''}`,
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

function harnessMessageEntry(id: string, text: string): ConversationEntry {
  return {
    id,
    role: 'assistant',
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
  apiMode: 'personal',
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
  entries: SHOW_LONG_TOOL_OUTPUT
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
  ];
  patchStream(STREAM_ID, (slice) => ({
    ...slice,
    status: STREAM_STATUS.RUNNING,
    runStartedAt: startedAt,
    activeSubagents: childStreams,
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

if (SHOW_EXTERNAL_INQUIRY) {
  void enqueueApproval(
    {
      kind: 'externalInquiry',
      payload: {
        requestId: 'harness-external-inquiry',
        question: EXTERNAL_INQUIRY_QUESTION,
        threadId: 'ei_123456abcdef',
        allowBypass: false,
        streamId: STREAM_ID,
      },
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
  const streamId = cliState.activeStreamId.get() ?? STREAM_ID;
  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      harnessMessageEntry(
        `harness-local-${Date.now()}-${slice.entries.length}`,
        text,
      ),
    ],
  }));
}

function refreshHarnessFollowUpState(streamId: string): void {
  const messages = ToolUseFollowUpQueue.getAll(streamId);
  patchStream(streamId, (slice) => ({
    ...slice,
    status: messages.length > 0 ? STREAM_STATUS.RUNNING : slice.status,
    runStartedAt:
      messages.length > 0 && slice.runStartedAt == null
        ? Date.now()
        : slice.runStartedAt,
    queuedFollowUps: messages.length,
    queuedFollowUpMessages: messages,
  }));
}

function queueHarnessFollowUp(input: string): void {
  const message = input.trim();
  if (!message) {
    appendHarnessAssistantTranscript(HARNESS_BTW_USAGE);
    return;
  }
  if (BTW_IDLE) {
    appendHarnessAssistantTranscript(HARNESS_BTW_IDLE_MESSAGE);
    return;
  }

  const streamId = cliState.activeStreamId.get() ?? STREAM_ID;
  ToolUseFollowUpQueue.enqueue(streamId, message, { force: true });
  refreshHarnessFollowUpState(streamId);
  appendHarnessAssistantTranscript(`Queued follow-up: ${message}`);
}

function harnessActiveChildStreamId(): string | undefined {
  const activeStreamId = cliState.activeStreamId.get();
  if (!activeStreamId) return undefined;
  return cliState.parentStream.get().has(activeStreamId)
    ? activeStreamId
    : undefined;
}

function harnessStreamStatuses(streamId: string): readonly string[] {
  const streams = cliState.streams.get();
  const parentStreamId = cliState.parentStream.get().get(streamId);
  const childStreamStatus = parentStreamId
    ? streams
        .get(parentStreamId)
        ?.childStreams.find((child) => child.childStreamId === streamId)?.status
    : undefined;
  return [
    childStreamStatus,
    streams.get(streamId)?.status,
    StreamStatusService.get(streamId),
  ].filter((status): status is string => status !== undefined);
}

function harnessRejectsFocusedChildSubmit(): boolean {
  const childStreamId = harnessActiveChildStreamId();
  if (!childStreamId) return false;
  const statuses = harnessStreamStatuses(childStreamId);
  return statuses.some((status) => {
    const parsed = StreamStatusSchema.safeParse(status);
    return !parsed.success || !isInFlightStatus(parsed.data);
  });
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

function openHarnessSlashForm(
  command: SlashCommand,
  remainder: string,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  cliState.activeForm.set({
    commandName: command.name,
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

function formatHarnessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    case 'btw':
      queueHarnessFollowUp(rest);
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
  canSelectAgent: () => false,
  canSelectModel: () => false,
  getApprovalPolicy: () => harnessApprovalPolicy,
  onApprovalPolicySelect: setHarnessApprovalPolicy,
  onApiModeSelect: (apiMode) => {
    cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), apiMode });
    appendHarnessAssistantTranscript(`API mode set to ${apiMode}.`);
  },
  onMemorySelect: (storagePath) => {
    appendHarnessAssistantTranscript(
      `Harness memory selected: ${storagePath}.`,
    );
  },
  onMemoryError: (error) => {
    appendHarnessAssistantTranscript(
      `Memory command failed: ${formatHarnessError(error)}`,
    );
  },
  onResumeSelect: (id) => {
    appendHarnessAssistantTranscript(`Harness resume selected: ${id}.`);
  },
  onResumeError: (error) => {
    appendHarnessAssistantTranscript(
      `Resume command failed: ${formatHarnessError(error)}`,
    );
  },
});

let ink: ReturnType<typeof render>;
function handleHarnessCtrlC(): void {
  if (canInterrupt) {
    markHarnessInterrupted();
    return;
  }
  void exitHarness(0);
}

ink = render(
  <App
    onSubmit={handleHarnessSubmit}
    onKillExecution={markHarnessExecutionStopped}
    canInterruptActiveRun={() => canInterrupt}
    canStopActiveRun={() => canInterrupt}
    onInterruptActive={markHarnessInterrupted}
    onCtrlC={handleHarnessCtrlC}
  />,
  {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    exitOnCtrlC: false,
  },
);

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
