// Phase 4 state + focus-cycle smoke.

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { createRunTrace } from '@logger';
import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';

import {
  cliState,
  patchStream,
  removeStream,
  resetCliState,
  setParentStream,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import {
  allocateMiddleRows,
  allocateSidePanelRows,
  appEscapeInterruptActive,
  appFocusShortcutsActive,
} from '../../../packages/cli/src/chat/tui/App';
import {
  nextFocusBack,
  nextFocusForward,
} from '../../../packages/cli/src/chat/tui/state/focusCycle';
import {
  stripOrchestratorFollowup,
  syncStreamLog,
} from '../../../packages/cli/src/chat/tui/state/subscribeStreamLog';
import { wrapRuntimeHost } from '../../../packages/cli/src/chat/tui/state/subscribeRuntimeHost';
import {
  COMPLETED_PROCESS_TAIL_LINES,
  buildCompletedProcessTranscript,
  completedProcessDisplayLines,
  isCompletedProcessError,
} from '../../../packages/cli/src/chat/tui/state/completedProcessTranscript';
import {
  estimateTranscriptEntryRows,
  selectPendingEntriesForViewport,
  splitTranscriptEntries,
} from '../../../packages/cli/src/chat/tui/panes/ConversationPane';
import { renderAnsiMarkdown } from '../../../packages/cli/src/chat/tui/render/ansiMarkdown';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStartRootRun,
  chatTuiActiveChildFollowUpTarget,
  clearTuiSessionRunState,
} from '../../../packages/cli/src/chat/tui/runChatTui';
import { CliExitCode } from '../../../packages/cli/src/runtime/exitCodes';
import {
  appendAssistantTranscriptIfMissing,
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  CLI_LOCAL_STREAM_ID,
  moveLocalTranscriptToStream,
} from '../../../packages/cli/src/chat/tui/state/transcript';
import type { CliRuntimeHost } from '../../../packages/cli/src/runtime/runtimeHost';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;

afterEach(() => {
  resetCliState();
});

describe('cliState Phase 4 fields', () => {
  it('initialises every new slice with empty subagent/process/todo/plan/bypass defaults', () => {
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    const slice = cliState.streams.get().get(root);
    expect(slice).toBeDefined();
    expect(slice?.activeSubagents).toEqual([]);
    expect(slice?.activeProcesses).toEqual([]);
    expect(slice?.todos).toEqual([]);
    expect(slice?.plan).toBeNull();
    expect(slice?.processOutput.size).toBe(0);
    expect(slice?.bypass).toEqual({ toolEdit: false, superYolo: false });
  });

  it('prunes parent edges when a stream is removed', () => {
    setParentStream(child1, root);
    setParentStream(child2, root);
    expect(cliState.parentStream.get().get(child1)).toBe(root);
    expect(cliState.parentStream.get().get(child2)).toBe(root);

    // Removing a child drops its own edge but leaves siblings intact.
    patchStream(child1, (s) => ({ ...s, status: 'running' }));
    removeStream(child1);
    expect(cliState.parentStream.get().has(child1)).toBe(false);
    expect(cliState.parentStream.get().get(child2)).toBe(root);

    // Removing the parent prunes every edge that pointed at it.
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    removeStream(root);
    expect(cliState.parentStream.get().has(child2)).toBe(false);
  });

  it('treats a null-parent update as child promotion to top-level', () => {
    setParentStream(child1, root);
    expect(cliState.parentStream.get().get(child1)).toBe(root);

    setParentStream(child1, null);

    expect(cliState.parentStream.get().has(child1)).toBe(false);
  });
});

describe('CLI TUI row allocation', () => {
  it('keeps foreground approval and form surfaces inside the middle row budget', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(1);
    expect(layout.foregroundRows).toBe(16);
  });

  it('uses the whole middle region for the transcript without foreground UI', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(17);
    expect(layout.foregroundRows).toBe(0);
  });

  it('reserves rows for reverse-search input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: true,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(12);
    expect(layout.foregroundRows).toBe(0);
  });

  it('returns former header rows to the transcript when slash palette is open', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: true,
    });

    expect(layout.transcriptRows).toBe(4);
    expect(layout.foregroundRows).toBe(0);
  });

  it('bounds side panels to the available middle row budget', () => {
    expect(
      allocateSidePanelRows({
        hasSubagentPanel: true,
        hasTodosPlanPanel: true,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 6, todosPlanRows: 7 });

    expect(
      allocateSidePanelRows({
        hasSubagentPanel: false,
        hasTodosPlanPanel: true,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 0, todosPlanRows: 13 });

    expect(
      allocateSidePanelRows({
        hasSubagentPanel: true,
        hasTodosPlanPanel: true,
        rows: 1,
      }),
    ).toEqual({ subagentRows: 1, todosPlanRows: 0 });
  });

  it('lets input overlays own focus shortcuts', () => {
    expect(
      appFocusShortcutsActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
      }),
    ).toBe(true);
    expect(
      appFocusShortcutsActive({
        inputDisabled: false,
        reverseSearchOpen: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appFocusShortcutsActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        slashPaletteOpen: true,
      }),
    ).toBe(false);
  });

  it('only lets Escape interrupt when no foreground input owns it', () => {
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(true);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: false,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: true,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: true,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: true,
      }),
    ).toBe(false);
  });

  it('only reports a chat run interruptible after stream resolution', () => {
    const runPromise = Promise.resolve();

    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise,
        streamId: undefined,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise: undefined,
        streamId: root,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: true,
        runPromise,
        streamId: root,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise,
        streamId: root,
      }),
    ).toBe(true);
  });

  it('allows a fresh root run after a terminal chat failure', () => {
    const runPromise = Promise.resolve();

    expect(
      chatTuiCanStartRootRun({
        runCompleted: false,
        runPromise: undefined,
      }),
    ).toBe(true);
    expect(
      chatTuiCanStartRootRun({
        runCompleted: false,
        runPromise,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStartRootRun({
        runCompleted: true,
        runPromise,
      }),
    ).toBe(true);
  });

  it('selects the focused child stream as a follow-up target', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    setParentStream(child1, root);

    cliState.activeStreamId.set(root);
    expect(chatTuiActiveChildFollowUpTarget()).toBeUndefined();

    cliState.activeStreamId.set(child1);
    expect(chatTuiActiveChildFollowUpTarget()).toBe(child1);
  });

  it('clears stale resume ids when clearing chat session run state', () => {
    const session = {
      streamId: root,
      executionId: 'old-execution',
      runPromise: Promise.resolve(),
      runExitCode: CliExitCode.Interrupted,
      runCompleted: true,
      stopRequested: true,
    };

    clearTuiSessionRunState(session);

    expect(session).toMatchObject({
      streamId: undefined,
      executionId: undefined,
      runPromise: undefined,
      runExitCode: 0,
      runCompleted: false,
      stopRequested: false,
    });
  });
});

describe('CLI transcript state', () => {
  it('renders orchestrator follow-ups without protocol tags', () => {
    expect(
      stripOrchestratorFollowup(
        '<orchestrator-followup>\nPlease inspect the file.\n</orchestrator-followup>',
      ),
    ).toBe('Please inspect the file.');
    expect(stripOrchestratorFollowup('ordinary user text')).toBe(
      'ordinary user text',
    );
  });

  it('mirrors error log entries into the transcript', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.error('Model request failed', {
        messageType: MESSAGE_TYPES.ERROR,
      });

      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        role: 'error',
        text: 'Model request failed',
        finalized: true,
      });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  // Regression: a sync tick that fires after `finalizeAssistantTranscriptEntries`
  // must not roll the entry back to `finalized: false`. Cursor Bugbot flagged
  // this when `entriesEqual` started comparing `finalized` — without this
  // guard, the de-finalized entry would land in neither bucket of
  // `splitTranscriptEntries` once status flipped to WAITING and silently
  // disappear from the transcript.
  it('preserves the finalized flag through a post-finalize sync tick', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('streaming assistant chunk', {
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      });
      syncStreamLog(root);

      // Stream-level finalize promotes the deferred-finalization entries.
      patchStream(root, (slice) => ({
        ...slice,
        entries: slice.entries.map((entry) =>
          entry.role === 'assistant' ? { ...entry, finalized: true } : entry,
        ),
      }));

      // A second sync after finalize must not regress the flag.
      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        role: 'assistant',
        finalized: true,
      });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('adds a final assistant response only when the stream log did not render it', () => {
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');

    const entries = cliState.streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'The answer is 2.',
      finalized: true,
    });
  });

  it('keeps repeated final responses from distinct turns visible', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'Done.', 'final:first');

      logger.info('second prompt', {
        messageType: MESSAGE_TYPES.USER_MESSAGE,
      });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'Done.', 'final:second');

      logger.info('third prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries.map((entry) => entry.text)).toEqual([
        'first prompt',
        'Done.',
        'second prompt',
        'Done.',
        'third prompt',
      ]);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('does not duplicate a final response already present in the stream log', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('Done.', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'Done.', 'final:first');

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries.map((entry) => entry.text)).toEqual(['Done.']);
      expect(entries[0]?.synthetic).toBeUndefined();
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('keeps repeated local slash-command responses visible', () => {
    cliState.activeStreamId.set(root);

    appendLocalAssistantTranscript('Available commands: /help');
    appendLocalAssistantTranscript('Available commands: /help');

    const entries = cliState.streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Available commands: /help',
      'Available commands: /help',
    ]);
  });

  it('can append local assistant output to an explicit stream', () => {
    cliState.activeStreamId.set(root);

    appendLocalAssistantTranscript('Child stream note.', child1);

    expect(cliState.streams.get().get(root)?.entries ?? []).toEqual([]);
    expect(
      cliState.streams
        .get()
        .get(child1)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['Child stream note.']);
  });

  it('adds local runtime errors to the transcript', () => {
    cliState.activeStreamId.set(root);

    appendLocalErrorTranscript('Model claude-opus-4-7 not found');

    const entries = cliState.streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'error',
      text: 'Model claude-opus-4-7 not found',
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
    });
  });

  it('flushes pending model-response chunks before transcript sync', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
      stream.append('A short final answer.');

      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries.map((entry) => entry.text)).toEqual([
        'A short final answer.',
      ]);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('finalizes a delayed first model-response sync after the stream is idle', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('A delayed final answer.', {
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      });
      patchStream(root, (slice) => ({
        ...slice,
        status: STREAM_STATUS.WAITING,
      }));

      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        role: 'assistant',
        text: 'A delayed final answer.',
        finalized: true,
      });
      const split = splitTranscriptEntries(entries, STREAM_STATUS.WAITING);
      expect(split.finalized.map((entry) => entry.id)).toEqual([
        entries[0]?.id,
      ]);
      expect(split.pending).toEqual([]);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('keeps repeated local slash-command responses after stream-log syncs', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);
      cliState.activeStreamId.set(root);

      appendLocalAssistantTranscript('Available commands: /help');
      logger.info('partial response', {
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      });
      syncStreamLog(root);

      appendLocalAssistantTranscript('Available commands: /help');
      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(
        entries
          .filter((entry) => entry.syntheticKind === 'local')
          .map((entry) => entry.text),
      ).toEqual(['Available commands: /help', 'Available commands: /help']);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('keeps a model response live when local output follows it', () => {
    const { finalized, pending } = splitTranscriptEntries(
      [
        {
          id: 'model-response',
          role: 'assistant',
          text: 'partial',
          finalized: false,
        },
        {
          id: 'local-help',
          role: 'assistant',
          text: 'Available commands: /help',
          finalized: true,
          synthetic: true,
          syntheticKind: 'local',
          syntheticAfterSeq: 1,
        },
      ],
      STREAM_STATUS.RUNNING,
    );

    expect(pending.map((entry) => entry.id)).toEqual(['model-response']);
    expect(finalized.map((entry) => entry.id)).toEqual(['local-help']);
  });

  it('estimates finalized assistant rows from rendered markdown', () => {
    const text = ['A paragraph.', '', '- abcdef ghijkl mnopqr'].join('\n');
    const width = 10;
    const renderedRows = renderAnsiMarkdown(text, { width }).split('\n').length;
    const entry = {
      id: 'assistant-markdown',
      role: 'assistant',
      text,
      finalized: true,
    } as const;

    expect(estimateTranscriptEntryRows(entry, width)).toBe(renderedRows + 1);
  });

  it('keeps pending transcript rows within their viewport budget', () => {
    const pending = [
      {
        id: 'assistant',
        role: 'assistant',
        text: 'streaming reply',
        finalized: false,
      },
      {
        id: 'tool',
        role: 'tool',
        text: '',
        finalized: false,
        toolUse: {
          parsed: {},
          toolName: 'Bash',
          errorText: '',
          outputText: 'one\ntwo\nthree',
          userInstructionText: '',
          input: { command: 'ls' },
          isError: false,
          isUserFeedback: false,
          headerSummary: '',
          status: 'completed',
        },
      },
    ] as const;

    const selected = selectPendingEntriesForViewport(pending, 3, 80);

    expect(selected.entries.map((entry) => entry.id)).toEqual(['tool']);
    expect(selected.hiddenCount).toBe(1);
    expect(selected.rowLimits.get('tool')).toBe(3);
    expect(selected.usedRows).toBe(3);
  });

  it('lets live output fill the viewport instead of reserving a history marker row', () => {
    const pending = [
      {
        id: 'assistant',
        role: 'assistant',
        text: 'streaming reply '.repeat(300),
        finalized: false,
      },
    ] as const;

    const selected = selectPendingEntriesForViewport(pending, 13, 80);

    expect(selected.usedRows).toBe(13);
    expect(selected.entries.map((entry) => entry.id)).toEqual(['assistant']);
  });

  it('moves pre-session local slash-command output onto the resolved stream', () => {
    appendLocalAssistantTranscript('Available commands: /help');

    expect(
      cliState.streams.get().get(CLI_LOCAL_STREAM_ID)?.entries,
    ).toHaveLength(1);

    moveLocalTranscriptToStream(root);

    expect(cliState.streams.get().has(CLI_LOCAL_STREAM_ID)).toBe(false);
    expect(cliState.activeStreamId.get()).toBe(root);
    expect(
      cliState.streams
        .get()
        .get(root)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['Available commands: /help']);
  });

  it('preserves synthetic final responses across later log syncs', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('1+1', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');

      logger.info('next prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries.map((entry) => entry.text)).toEqual([
        '1+1',
        'The answer is 2.',
        'next prompt',
      ]);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('orders multiple synthetic responses relative to their stream-log anchors', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace(root).trace;
      logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'first answer', 'final-1');

      logger.info('second prompt', {
        messageType: MESSAGE_TYPES.USER_MESSAGE,
      });
      syncStreamLog(root);
      appendAssistantTranscriptIfMissing(root, 'second answer', 'final-2');

      logger.info('third prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
      syncStreamLog(root);

      const entries = cliState.streams.get().get(root)?.entries ?? [];
      expect(entries.map((entry) => entry.text)).toEqual([
        'first prompt',
        'first answer',
        'second prompt',
        'second answer',
        'third prompt',
      ]);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});

describe('subscribeRuntimeHost.updateActiveProcesses', () => {
  function makeHost(): CliRuntimeHost {
    return {
      emit: () => {},
      close: async () => {},
    } as unknown as CliRuntimeHost;
  }

  it('registers suppressed child streams without switching away from the parent page', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    cliState.activeStreamId.set(root);

    wrapped.emit('setActiveStream', {
      streamId: child1,
      suppressViewSwitch: true,
    });

    expect(cliState.activeStreamId.get()).toBe(root);
    expect(cliState.streams.get().has(child1)).toBe(true);
  });

  it('persists a bounded completed-process transcript before pruning processOutput', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    const lines = Array.from(
      { length: COMPLETED_PROCESS_TAIL_LINES + 2 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    // Seed: two live processes with tail output.
    wrapped.emit('updateActiveProcesses', {
      parentStreamId: root,
      processes: [
        {
          executionId: 'exec-a',
          agentName: 'latexmk',
          toolName: 'bash',
          status: 'exit 1',
          elapsed: '2s',
        },
        { executionId: 'exec-b', agentName: 'bash' },
      ],
    });
    wrapped.emit('updateProcessOutput', {
      parentStreamId: root,
      executionId: 'exec-a',
      stdout: lines,
      stderr: 'stderr tail',
    });
    wrapped.emit('updateProcessOutput', {
      parentStreamId: root,
      executionId: 'exec-b',
      stdout: 'B',
      stderr: '',
    });
    expect(cliState.streams.get().get(root)?.processOutput.size).toBe(2);

    // exec-a finishes: its output buffer must be dropped on the next
    // active-processes update, after a durable transcript entry is added.
    wrapped.emit('updateActiveProcesses', {
      parentStreamId: root,
      processes: [{ executionId: 'exec-b', agentName: 'bash' }],
    });
    const slice = cliState.streams.get().get(root);
    const out = cliState.streams.get().get(root)?.processOutput;
    expect(out?.size).toBe(1);
    expect(out?.has('exec-a')).toBe(false);
    expect(out?.has('exec-b')).toBe(true);

    const processEntries =
      slice?.entries.filter((entry) => entry.role === 'process') ?? [];
    expect(processEntries).toHaveLength(1);
    expect(processEntries[0]).toMatchObject({
      role: 'process',
      finalized: true,
      synthetic: true,
      syntheticKind: 'process',
      process: {
        executionId: 'exec-a',
        title: 'latexmk',
        status: 'exit 1',
        elapsed: '2s',
        isError: true,
      },
    });
    expect(processEntries[0]?.process?.tailLines).toHaveLength(
      COMPLETED_PROCESS_TAIL_LINES,
    );
    expect(processEntries[0]?.process?.tailLines.at(0)).toBe('line 4');
    expect(processEntries[0]?.process?.tailLines.at(-1)).toBe('stderr tail');

    const split = splitTranscriptEntries(
      slice?.entries ?? [],
      STREAM_STATUS.WAITING,
    );
    expect(split.finalized).toContain(processEntries[0]);
    expect(split.pending).not.toContain(processEntries[0]);
  });

  it('formats completed-process transcript rows for terminal rendering', () => {
    const process = buildCompletedProcessTranscript(
      {
        executionId: 'exec-a',
        agentName: 'latexmk',
        status: 'exit 2',
        elapsed: '5s',
      },
      {
        stdout: 'Compiling\n',
        stderr: 'fatal error\n',
      },
    );

    expect(completedProcessDisplayLines(process)).toMatchInlineSnapshot(`
      [
        "latexmk · exit 2 · 5s · error",
        "⎿ Compiling",
        "  fatal error",
      ]
    `);
  });

  it('classifies completed process error statuses', () => {
    expect(isCompletedProcessError('running')).toBe(false);
    expect(isCompletedProcessError('exit 0')).toBe(false);
    expect(isCompletedProcessError('exit 1')).toBe(true);
    expect(isCompletedProcessError('exited with code 2')).toBe(true);
    expect(isCompletedProcessError('failed')).toBe(true);
  });

  it('does not keep a stale running status after a process leaves the active list', () => {
    const process = buildCompletedProcessTranscript(
      {
        executionId: 'exec-a',
        agentName: 'bash',
        status: 'running',
      },
      undefined,
    );

    expect(process.status).toBe('completed');
    expect(process.isError).toBe(false);
  });
});

describe('focusCycle', () => {
  it('Ctrl-A cycles through siblings then wraps back to the parent', () => {
    cliState.activeStreamId.set(root);
    setParentStream(child1, root);
    setParentStream(child2, root);
    patchStream(root, (s) => ({
      ...s,
      activeSubagents: [
        { executionId: 'e1', agentName: 'a', childStreamId: child1 },
      ],
      activeProcesses: [
        { executionId: 'e2', agentName: 'b', childStreamId: child2 },
      ],
    }));
    // root → first descendant.
    expect(nextFocusForward()).toBe(child1);
    // child1 → next sibling resolved through the parent's descendant list.
    cliState.activeStreamId.set(child1);
    expect(nextFocusForward()).toBe(child2);
    // child2 (last sibling) → wrap back to parent.
    cliState.activeStreamId.set(child2);
    expect(nextFocusForward()).toBe(root);
  });

  it('Ctrl-A can still focus an inactive child stream with retained history', () => {
    cliState.activeStreamId.set(root);
    setParentStream(child1, root);
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));

    expect(nextFocusForward()).toBe(child1);
  });

  it('Ctrl-B returns to the parent and bottoms out at root', () => {
    setParentStream(child1, root);
    cliState.activeStreamId.set(child1);
    expect(nextFocusBack()).toBe(root);
    cliState.activeStreamId.set(root);
    expect(nextFocusBack()).toBeUndefined();
  });
});
