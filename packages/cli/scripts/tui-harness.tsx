// Test harness: seed cliState with synthetic finalized entries, render <App />
// to the real terminal. Used to verify the ConversationPane viewport without
// needing API access. Exits on Ctrl-C.

import { render } from 'ink';
import React from 'react';

import { App } from '../src/chat/tui/App';
import {
  cliState,
  patchStream,
  type ConversationEntry,
} from '../src/chat/tui/state/cliState';

const STREAM_ID = 'harness-stream-1';
const ENTRY_COUNT = Number(process.env.HARNESS_ENTRIES ?? '15');

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

cliState.sessionMeta.set({
  agent: 'chat',
  model: 'harness-model',
  cwd: process.cwd(),
  apiMode: 'personal',
  canDelegate: false,
  version: '0.0.0-harness',
});
cliState.activeStreamId.set(STREAM_ID);
patchStream(STREAM_ID, (slice) => ({
  ...slice,
  status: undefined,
  entries: makeEntries(ENTRY_COUNT),
}));

const ink = render(
  <App
    onSubmit={() => undefined}
    onKillExecution={() => undefined}
    canInterruptActiveRun={() => false}
    onInterruptActive={() => undefined}
  />,
  {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  },
);

process.on('SIGINT', () => {
  ink.unmount();
  process.exit(0);
});
