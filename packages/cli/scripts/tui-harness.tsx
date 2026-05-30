// Test harness: seed cliState with synthetic finalized entries, render <App />
// to the real terminal. Used to verify the ConversationPane viewport without
// needing API access. Exits on Ctrl-C.

import { render } from 'ink';
import React from 'react';

import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import {
  STREAM_STATUS,
  TODO_STATUS,
  type ActiveChildInfo,
} from '@shared/schemas';

import { App } from '../src/chat/tui/App';
import {
  cliState,
  patchStream,
  setParentStream,
  type ConversationEntry,
} from '../src/chat/tui/state/cliState';
import {
  formatCliSessionStatus,
  readQueuedFollowUpMessagesForStatus,
} from '../src/chat/tui/sessionStatus';
import { enqueueApproval } from '../src/chat/tui/state/approvalQueue';

const STREAM_ID = 'harness-stream-1';
const ENTRY_COUNT = Number(process.env.HARNESS_ENTRIES ?? '15');
const SHOW_EDIT_APPROVAL = process.env.HARNESS_EDIT_APPROVAL === '1';
const CAN_DELEGATE = process.env.HARNESS_CAN_DELEGATE === '1';
const SHOW_CHILDREN = process.env.HARNESS_CHILDREN === '1';
const SHOW_TODOS = process.env.HARNESS_TODOS === '1';
let canInterrupt = process.env.HARNESS_CAN_INTERRUPT === '1';
const EDIT_APPROVAL_DELAY_MS = Number(
  process.env.HARNESS_EDIT_APPROVAL_DELAY_MS ?? '0',
);
const QUEUED_FOLLOW_UPS = parseList(process.env.HARNESS_QUEUED_FOLLOWUPS);
const HARNESS_FOLLOW_UP_QUEUE = ToolUseFollowUpQueue.acquire(STREAM_ID);
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

function makeChildEntries(agent: string, action: string): ConversationEntry[] {
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
      text: `${agent} is checking the ${action} details and preparing a concise result.`,
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

cliState.sessionMeta.set({
  agent: 'chat',
  model: 'harness-model',
  cwd: process.cwd(),
  apiMode: 'personal',
  canDelegate: CAN_DELEGATE,
  version: '0.0.0-harness',
});
cliState.activeStreamId.set(STREAM_ID);
patchStream(STREAM_ID, (slice) => ({
  ...slice,
  status: QUEUED_FOLLOW_UPS.length > 0 ? STREAM_STATUS.RUNNING : slice.status,
  runStartedAt:
    QUEUED_FOLLOW_UPS.length > 0 ? Date.now() - 42_000 : slice.runStartedAt,
  entries: makeEntries(ENTRY_COUNT),
  queuedFollowUps: QUEUED_FOLLOW_UPS.length,
  queuedFollowUpMessages: QUEUED_FOLLOW_UPS,
}));

if (SHOW_CHILDREN) {
  const startedAt = Date.now() - 74_000;
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
    setParentStream(streamId, STREAM_ID);
    patchStream(streamId, (slice) => ({
      ...slice,
      status: child.status,
      description: `${child.agentName} sub-workflow`,
      entries: makeChildEntries(child.agentName, child.executionId),
      runStartedAt:
        child.status === STREAM_STATUS.RUNNING ? child.startedAt : undefined,
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
    void enqueueApproval({
      kind: 'toolEdit',
      request: makeEditApprovalRequest(),
    });

  if (EDIT_APPROVAL_DELAY_MS > 0) {
    setTimeout(showApproval, EDIT_APPROVAL_DELAY_MS);
  } else {
    showApproval();
  }
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
    activeSubagents: slice.activeSubagents.map(stoppedChild),
    activeProcesses: slice.activeProcesses.map(stoppedChild),
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
    activeSubagents: slice.activeSubagents.map((child) =>
      stopMatchingChild(child, executionId),
    ),
    activeProcesses: slice.activeProcesses.map((child) =>
      stopMatchingChild(child, executionId),
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
  if (line.trim() !== '/status') return;

  const meta = cliState.sessionMeta.get();
  const streamId = cliState.activeStreamId.get() ?? STREAM_ID;
  const slice = cliState.streams.get().get(streamId);
  appendHarnessAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent,
      model: meta.model,
      api: meta.apiMode,
      approval: 'ask',
      status: slice?.status ?? 'not started',
      queuedFollowUpMessages: readQueuedFollowUpMessagesForStatus(streamId),
    }),
  );
}

const ink = render(
  <App
    onSubmit={handleHarnessSubmit}
    onKillExecution={markHarnessExecutionStopped}
    canInterruptActiveRun={() => canInterrupt}
    canStopActiveRun={() => canInterrupt}
    onInterruptActive={markHarnessInterrupted}
  />,
  {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    exitOnCtrlC: false,
  },
);

process.on('SIGINT', () => {
  if (canInterrupt) {
    markHarnessInterrupted();
    return;
  }
  ink.unmount();
  process.exit(0);
});
