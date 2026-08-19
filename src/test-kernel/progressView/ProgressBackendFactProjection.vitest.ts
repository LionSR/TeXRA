/**
 * Fact projection and view sync: how run and session facts become stream
 * metadata, badges, and outbound messages, and how two sessions stay isolated
 * while projecting the same stream ids.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { buildStreamInfos } from '@controllers/session/streamInfoUtils';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import { setOutputChannelFactory } from '@logger/logUtils';
import {
  AgentCategory,
  type ActiveChildInfo,
  type CompileFailure,
  type InquiryThreadUpdatedEvent,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type OutputFileInfo,
  type Plan,
  type ProgressViewOutboundMessage,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import {
  createIsolatedRecordingBackend,
  createPersistentRecordingBackend,
  createRecordingBackend,
  emitActiveStream,
  emitRunConfig,
  emitRunEvent,
  emitStreamDescription,
  toolUseConfig,
} from './progressBackendHarness';

/** The metadata patch a stream received, narrowed to its message arm. */
function metadataPatchFor(
  messages: ProgressViewOutboundMessage[],
  streamName: string,
): Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA }
> {
  const patch = messages.find(
    (message) =>
      message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
      message.streamInfo.name === streamName,
  );
  if (patch?.command !== PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA) {
    throw new Error(`Expected a metadata patch for ${streamName}`);
  }
  return patch;
}

/** The full-view sync message, narrowed to its message arm. */
function fullSyncFrom(
  messages: ProgressViewOutboundMessage[],
): Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS }
> {
  const fullSync = messages.find(
    (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
  );
  if (fullSync?.command !== PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS) {
    throw new Error('Expected a full stream metadata sync');
  }
  return fullSync;
}

/** True when a full-view sync was recorded among the outbound messages. */
function hasFullSync(messages: ProgressViewOutboundMessage[]): boolean {
  return messages.some(
    (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
  );
}

/** An isolated recording backend already wired to its session events. */
function createListeningBackend(): ReturnType<
  typeof createIsolatedRecordingBackend
> {
  const target = createIsolatedRecordingBackend();
  target.backend.setupEventListeners();
  return target;
}

/** Backfill history tabs so later patches must not degrade into full syncs. */
function seedHistoryStreams(
  backend: ReturnType<typeof createRecordingBackend>['backend'],
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    backend.state.streamLogs.ensureStream(`history-${i}`);
  }
}

/** The paper.tex workspace output file shared by the session-fact tests. */
function paperOutputFile(): OutputFileInfo {
  return {
    source: 'paper.tex',
    location: {
      kind: 'workspace',
      absolutePath: '/workspace/paper.tex',
      relativePath: 'paper.tex',
    },
    round: 1,
    lineage: null,
    diff: null,
  };
}

describe('ProgressBackend', () => {
  it('sends the full metadata set once for full-view sync', () => {
    const { backend, messages } = createRecordingBackend();

    seedHistoryStreams(backend, 20);

    backend.renderer.sendStreamMetadata(
      backend.presentation.activeStream,
      backend.presentation.activeStream,
    );

    expect(
      messages.filter(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      ),
    ).toHaveLength(0);

    expect(fullSyncFrom(messages).streams).toHaveLength(20);
  });

  it('registers a suppressed interaction stream without switching to it', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;

    emitActiveStream(target, {
      streamId: 'root',
      agentCategory: AgentCategory.Workflow,
    });
    await vi.waitFor(() =>
      expect(backend.presentation.activeStream).toBe('root'),
    );
    messages.length = 0;

    emitActiveStream(target, {
      streamId: 'hidden-approval',
      agentCategory: AgentCategory.ToolUse,
      suppressViewSwitch: true,
    });

    await vi.waitFor(() =>
      expect(
        backend.state.streamLogs.has('hidden-approval' as StreamTabId),
      ).toBe(true),
    );
    expect(backend.presentation.activeStream).toBe('root');
    expect(messages).toContainEqual(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        activeStream: undefined,
        streamInfo: expect.objectContaining({ name: 'hidden-approval' }),
      }),
    );
  });

  it('projects a workflow-script phase onto a non-active run stream', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;
    const run = 'workflow-run' as StreamTabId;

    emitActiveStream(target, {
      streamId: 'root',
      agentCategory: AgentCategory.ToolUse,
    });
    await vi.waitFor(() =>
      expect(backend.presentation.activeStream).toBe('root'),
    );
    emitActiveStream(target, {
      streamId: run,
      agentCategory: AgentCategory.Workflow,
      suppressViewSwitch: true,
    });
    await vi.waitFor(() =>
      expect(backend.state.getStreamState(run)).toBeDefined(),
    );
    messages.length = 0;

    emitRunEvent(target, run, {
      type: 'stage.start',
      id: 'phase-2',
      label: 'Reduce',
      kind: 'phase',
      index: 1,
      total: 3,
    });

    // The parent's viewport reads this row, so the push must reach a stream
    // that is not the active one.
    expect(backend.presentation.activeStream).toBe('root');
    await vi.waitFor(() =>
      expect(backend.state.getStreamState(run)).toMatchObject({
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      }),
    );
    expect(metadataPatchFor(messages, run).streamState).toMatchObject({
      stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
    });
  });

  it('patches one stream for subagent registration and run-start metadata', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;

    seedHistoryStreams(backend, 20);

    emitActiveStream(target, {
      streamId: 'root',
      agentCategory: AgentCategory.Workflow,
    });
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        ),
      ).toBe(true),
    );
    messages.length = 0;

    emitActiveStream(target, {
      streamId: 'child',
      agentCategory: AgentCategory.ToolUse,
      suppressViewSwitch: true,
    });
    await vi.waitFor(() =>
      expect(
        messages.find(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
            message.streamInfo.name === 'child',
        ),
      ).toBeDefined(),
    );
    expect(hasFullSync(messages)).toBe(false);
    messages.length = 0;

    emitRunEvent(target, 'child' as StreamTabId, {
      type: 'run.start',
      streamId: 'child' as StreamTabId,
      executionId: 'c41111' as ExecutionId,
      identity: { kind: 'agent', agent: 'search' },
    });
    emitRunConfig(
      target,
      'child' as StreamTabId,
      'c41111' as ExecutionId,
      toolUseConfig('search', 'deepseekproT'),
    );

    await vi.waitFor(() =>
      expect(
        messages.findLast(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        ),
      ).toMatchObject({
        streamInfo: {
          name: 'child',
          label: 'search',
          identity: { kind: 'agent', agent: 'search' },
          model: 'deepseekproT',
          executionId: 'c41111',
        },
      }),
    );
    expect(hasFullSync(messages)).toBe(false);

    // The run.start patch precedes the run.config one; compare the full sync
    // against the final (config-carrying) patch.
    const patch = metadataPatchFor([...messages].reverse(), 'child');
    messages.length = 0;

    backend.renderer.sendStreamMetadata(
      backend.presentation.activeStream,
      backend.presentation.activeStream,
    );
    const fullSync = fullSyncFrom(messages);

    expect(fullSync.streams.find((stream) => stream.name === 'child')).toEqual(
      patch.streamInfo,
    );
    expect(fullSync.streamStates?.child).toEqual(patch.streamState);
  });

  it('scopes direct session events to each backend session', async () => {
    const first = createListeningBackend();
    const second = createListeningBackend();
    const firstStream = 'session:first' as StreamTabId;
    const secondStream = 'session:second' as StreamTabId;

    emitActiveStream(first, {
      streamId: firstStream,
      agentCategory: AgentCategory.Workflow,
    });

    await vi.waitFor(() =>
      expect(first.backend.presentation.activeStream).toBe(firstStream),
    );
    expect(second.backend.presentation.activeStream).not.toBe(firstStream);
    expect(JSON.stringify(second.messages)).not.toContain(firstStream);

    emitActiveStream(second, {
      streamId: secondStream,
      agentCategory: AgentCategory.ToolUse,
    });

    await vi.waitFor(() =>
      expect(second.backend.presentation.activeStream).toBe(secondStream),
    );
    expect(first.backend.presentation.activeStream).toBe(firstStream);
    expect(JSON.stringify(first.messages)).not.toContain(secondStream);
  });

  it('isolates same-stream run facts across simultaneous backend sessions', async () => {
    const first = createListeningBackend();
    const second = createListeningBackend();
    const streamId = 'window:shared-stream-id' as StreamTabId;
    const firstTodo: TodoItem = {
      content: 'from first window',
      status: 'pending',
      activeForm: 'Writing from first window',
    };
    const secondTodo: TodoItem = {
      content: 'from second window',
      status: 'completed',
      activeForm: 'Writing from second window',
    };
    const firstOutput: OutputFileInfo = {
      source: 'first.tex',
      location: {
        kind: 'workspace',
        absolutePath: '/workspace/first.pdf',
        relativePath: 'first.pdf',
      },
      round: 1,
      lineage: null,
      diff: null,
    };

    await first.backend.state.snapshots.load([]);
    await second.backend.state.snapshots.load([]);

    emitRunEvent(first, streamId, {
      type: 'updateTodos',
      streamId,
      todos: [firstTodo],
    });
    emitRunEvent(first, streamId, {
      type: 'addOutputFiles',
      streamId,
      filesByRound: { 1: [firstOutput] },
    });

    expect(first.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual([
      firstTodo,
    ]);
    expect(first.backend.state.snapshots.getOutputFiles(streamId)).toEqual({
      1: [firstOutput],
    });
    expect(second.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual(
      [],
    );
    expect(second.backend.state.snapshots.getOutputFiles(streamId)).toEqual({});
    expect(JSON.stringify(second.messages)).not.toContain('from first window');
    expect(JSON.stringify(second.messages)).not.toContain('first.pdf');

    emitRunEvent(second, streamId, {
      type: 'updateTodos',
      streamId,
      todos: [secondTodo],
    });

    expect(first.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual([
      firstTodo,
    ]);
    expect(second.backend.state.snapshots.getWorkPlan(streamId).todos).toEqual([
      secondTodo,
    ]);
    expect(JSON.stringify(first.messages)).not.toContain('from second window');
  });

  it('isolates simultaneous window sessions across view state, status, snapshots, and transcripts', async () => {
    const first = createListeningBackend();
    const second = createListeningBackend();
    const firstStream = 'window:first' as StreamTabId;
    const secondStream = 'window:second' as StreamTabId;
    const firstExecution = 'f41111' as ExecutionId;
    const secondExecution = 'f42222' as ExecutionId;

    await first.backend.state.snapshots.load([]);
    await second.backend.state.snapshots.load([]);

    emitActiveStream(first, {
      streamId: firstStream,
      agentCategory: AgentCategory.ToolUse,
    });
    emitActiveStream(second, {
      streamId: secondStream,
      agentCategory: AgentCategory.Workflow,
    });

    emitRunConfig(
      first,
      firstStream,
      firstExecution,
      toolUseConfig('search', 'deepseekproT'),
    );
    emitRunConfig(
      second,
      secondStream,
      secondExecution,
      toolUseConfig('revise', 'gpt-4o'),
    );
    first.session.status.transition(
      firstStream,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );
    second.session.status.transition(
      secondStream,
      STREAM_PHASE.RUNNING,
      'lifecycle',
    );
    second.session.status.transitionToWaiting(secondStream, 'wait');
    emitStreamDescription(first, {
      streamId: firstStream,
      description: 'first window run',
    });
    emitStreamDescription(second, {
      streamId: secondStream,
      description: 'second window run',
    });
    appendTranscriptEntry(first.backend.state.streamLogs, firstStream, {
      id: 'first-window-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_700_000_000_001,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });
    appendTranscriptEntry(second.backend.state.streamLogs, secondStream, {
      id: 'second-window-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_700_000_000_002,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'second transcript entry',
    });

    await vi.waitFor(() =>
      expect(first.backend.presentation.activeStream).toBe(firstStream),
    );
    await vi.waitFor(() =>
      expect(second.backend.presentation.activeStream).toBe(secondStream),
    );

    expect(first.backend.state.streamStatus.get(firstStream)).toBe(
      STREAM_PHASE.RUNNING,
    );
    expect(first.backend.state.streamStatus.get(secondStream)).toBeUndefined();
    expect(second.backend.state.streamStatus.get(secondStream)).toBe(
      STREAM_PHASE.WAITING,
    );
    expect(second.backend.state.streamStatus.get(firstStream)).toBeUndefined();

    expect(
      first.backend.state.snapshots.getRunMetadata(firstStream),
    ).toMatchObject({
      description: 'first window run',
      executionId: firstExecution,
    });
    expect(
      first.backend.state.snapshots.getRunMetadata(secondStream),
    ).toMatchObject({ description: undefined, executionId: undefined });
    expect(
      second.backend.state.snapshots.getRunMetadata(secondStream),
    ).toMatchObject({
      description: 'second window run',
      executionId: secondExecution,
    });
    expect(
      second.backend.state.snapshots.getRunMetadata(firstStream),
    ).toMatchObject({ description: undefined, executionId: undefined });

    expect(first.backend.state.streamLogs.get(firstStream)?.size).toBe(1);
    expect(first.backend.state.streamLogs.get(secondStream)).toBeUndefined();
    expect(second.backend.state.streamLogs.get(secondStream)?.size).toBe(1);
    expect(second.backend.state.streamLogs.get(firstStream)).toBeUndefined();
    expect(JSON.stringify(first.messages)).not.toContain(secondStream);
    expect(JSON.stringify(second.messages)).not.toContain(firstStream);
  });

  it('applies session run facts through the fact-native handler', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;
    const streamId = 'session:output-files' as StreamTabId;
    const storageKey = 'run:session-usage' as StorageKey;
    const outputFile = paperOutputFile();
    const compileFailure: CompileFailure = {
      round: 1,
      displayName: 'paper.tex',
      output: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.pdf',
        relativePath: 'paper.pdf',
      },
      log: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.log',
        relativePath: 'paper.log',
      },
      logRelativePath: 'paper.log',
    };
    const todos: TodoItem[] = [
      {
        content: 'Preserve session fact handling',
        status: 'pending',
        activeForm: 'Preserving session fact handling',
      },
    ];
    const plan: Plan = {
      objective: 'Route session facts directly through ProgressBackend.',
    };
    const expectedUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
    };

    await backend.state.snapshots.load([]);
    emitActiveStream(target, {
      streamId,
      agentCategory: AgentCategory.Workflow,
    });
    await vi.waitFor(() =>
      expect(backend.presentation.activeStream).toBe(streamId),
    );
    messages.length = 0;

    emitRunEvent(target, streamId, {
      type: 'addOutputFiles',
      streamId,
      filesByRound: { 1: [outputFile] },
    });
    emitRunEvent(target, streamId, {
      type: 'updateMissingOutputs',
      streamId,
      filesByRound: { 1: ['paper.pdf'] },
    });
    emitRunEvent(target, streamId, {
      type: 'updateCompileFailures',
      streamId,
      filesByRound: { 1: [compileFailure] },
    });
    emitRunEvent(target, streamId, {
      type: 'updateTodos',
      streamId,
      todos,
    });
    emitRunEvent(target, streamId, {
      type: 'updatePlan',
      streamId,
      plan,
    });
    emitRunEvent(target, streamId, {
      type: 'usage',
      payload: {
        streamId,
        storageKey,
        usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
      },
      recordTranscript: false,
    });
    emitRunEvent(target, streamId, {
      type: 'goalPaused',
      streamId,
    });

    expect(
      messages.filter(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
      ),
    ).toEqual([
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
        stream: streamId,
        rounds: { 1: [outputFile] },
      },
    ]);
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
      stream: streamId,
      rounds: { 1: ['paper.pdf'] },
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
      stream: streamId,
      rounds: { 1: [compileFailure] },
      reset: true,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      stream: streamId,
      todos,
    });
    expect(messages).toContainEqual({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN,
      stream: streamId,
      plan,
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE,
        stream: streamId,
        runId: storageKey,
        usage: expectedUsage,
      }),
    );
    expect(backend.state.snapshots.getOutputFiles(streamId)).toEqual({
      1: [outputFile],
    });
    expect(backend.state.snapshots.getMissingOutputs(streamId)).toEqual({
      1: ['paper.pdf'],
    });
    expect(backend.state.snapshots.getCompileFailures(streamId)).toEqual({
      1: [compileFailure],
    });
    expect(backend.state.snapshots.getWorkPlan(streamId)).toMatchObject({
      todos,
      plan,
    });
    expect(backend.state.snapshots.getRunUsage(streamId)).toEqual(
      new Map([[storageKey, expectedUsage]]),
    );
  });

  it('drops malformed updateTodos/updatePlan run facts instead of forwarding them unchecked (#7562)', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;
    const streamId = 'session:malformed-todos-plan' as StreamTabId;

    await backend.state.snapshots.load([]);
    emitActiveStream(target, {
      streamId,
      agentCategory: AgentCategory.Workflow,
    });
    messages.length = 0;

    emitRunEvent(target, streamId, {
      type: 'domain',
      key: 'runFact.updateTodos',
      data: { streamId, todos: 'not-an-array' },
    });
    emitRunEvent(target, streamId, {
      type: 'domain',
      key: 'runFact.updatePlan',
      data: { streamId, plan: { steps: ['legacy shape'] } },
    });

    expect(messages).not.toContainEqual(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_TODOS,
      }),
    );
    expect(messages).not.toContainEqual(
      expect.objectContaining({ command: PROGRESS_VIEW_COMMANDS.UPDATE_PLAN }),
    );
  });

  it('no-ops session output-file run facts after dispose', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;
    const streamId = 'session:output-files-after-dispose' as StreamTabId;
    const outputFile = paperOutputFile();

    await backend.state.snapshots.load([]);
    emitActiveStream(target, {
      streamId,
      agentCategory: AgentCategory.Workflow,
    });
    messages.length = 0;
    backend.dispose();

    emitRunEvent(target, streamId, {
      type: 'addOutputFiles',
      streamId,
      filesByRound: { 1: [outputFile] },
    });

    expect(messages).not.toContainEqual(
      expect.objectContaining({ command: PROGRESS_VIEW_COMMANDS.UPDATE_FILES }),
    );
    // The presentation no-ops, but the sidecar store is session-owned, so it
    // keeps recording: disposing one window/webview must not stop the runtime
    // persisting an in-flight run's outputs. The desktop already behaved this
    // way (its `stateOwnership: 'session'` backend never detached the store);
    // the extension now matches it.
    expect(backend.state.snapshots.getOutputFiles(streamId)).toEqual({
      1: [outputFile],
    });
  });

  it('handles session facts directly', async () => {
    const target = createListeningBackend();
    const { backend, messages } = target;
    const parentStreamId = 'session:parent' as StreamTabId;
    const childStreamId = 'session:child' as StreamTabId;
    const child: ActiveChildInfo = {
      executionId: 'exec:child' as ExecutionId,
      childStreamId,
      agentName: 'orchestrator',
      identity: { kind: 'agent' as const, agent: 'orchestrator' },
      status: 'running',
      startedAt: 1,
    };
    const inquiryThread = {
      threadId: 'ei_123456789abc',
      parentStreamId,
      status: 'open',
      lastQuestionPreview: 'Can you check this estimate?',
      lastActivityIso: '2026-07-06T12:00:00.000Z',
      turnCount: 1,
      resumeOutcome: null,
    } satisfies InquiryThreadUpdatedEvent;

    await backend.state.snapshots.load([]);
    emitActiveStream(target, {
      streamId: parentStreamId,
      agentCategory: AgentCategory.ToolUse,
    });
    target.session.events.emit({
      scope: 'session',
      event: {
        type: 'status',
        streamId: parentStreamId,
        phase: STREAM_PHASE.RUNNING,
        cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      },
    });
    const followUpLease = target.session.followUps.claimLive(
      parentStreamId,
      'flow',
    )!;
    target.session.followUps.queue(followUpLease).enqueue({
      text: 'continue with the local calculation',
    });
    emitRunEvent(target, parentStreamId, {
      type: 'updateMissingOutputs',
      streamId: parentStreamId,
      filesByRound: { 0: ['missing-output.tex'] },
    });

    await vi.waitFor(() =>
      expect(backend.presentation.activeStream).toBe(parentStreamId),
    );
    messages.length = 0;

    emitRunEvent(target, parentStreamId, {
      type: 'stage.start',
      id: 'round-2',
      label: 'round 2',
      kind: 'round',
      index: 2,
      total: 4,
    });

    emitRunEvent(target, parentStreamId, {
      type: 'child.activity',
      parentStreamId,
      items: [child],
    });

    target.session.events.emit({
      scope: 'session',
      event: {
        type: 'setParentStream',
        payload: {
          childStreamId,
          parentStreamId,
        },
      },
    });

    target.session.events.emit({
      scope: 'session',
      event: {
        type: 'updateQueuedFollowUps',
        payload: { streamId: parentStreamId },
      },
    });

    target.session.events.emit({
      scope: 'session',
      event: {
        type: 'clearMissingOutputs',
        payload: { streamId: parentStreamId },
      },
    });

    target.session.events.emit({
      scope: 'session',
      event: {
        type: 'inquiryThreadUpdated',
        payload: inquiryThread,
      },
    });

    expect(backend.state.getStreamState(parentStreamId)).toMatchObject({
      stage: { kind: 'round', index: 2, total: 4 },
      subagents: [child],
    });
    expect(backend.state.snapshots.getMissingOutputs(parentStreamId)).toEqual(
      {},
    );
    expect(
      messages.some(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
      ),
    ).toBe(true);
  });

  it('keeps the selection when an unknown stream reaches running', async () => {
    const { backend, messages } = createRecordingBackend();

    backend.state.streamLogs.ensureStream('tool-stream');
    backend.state.updateStreamMetadata('tool-stream', {
      agentCategory: AgentCategory.ToolUse,
    });
    backend.state.getOrCreateStreamState('tool-stream', AgentCategory.ToolUse);
    backend.presentation.select('tool-stream');

    await backend.applyStreamStatus('unknown-stream', STREAM_PHASE.RUNNING);

    const patch = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
        message.streamInfo.name === 'unknown-stream',
    );
    expect(backend.presentation.activeStream).toBe('tool-stream');
    expect(patch).toMatchObject({
      activeStream: undefined,
      streamInfo: {
        name: 'unknown-stream',
        // Identity has not resolved, so no category is fabricated.
        agentCategory: undefined,
      },
    });
  });

  it('clears retained finished children when an existing stream re-enters running', async () => {
    const { backend, messages } = createRecordingBackend();
    const stream = 'tool-stream' as StreamTabId;

    await backend.state.snapshots.load([]);
    backend.state.streamLogs.ensureStream(stream);
    // Simulate persistence receiving run.config before progress state sees
    // the RUNNING transition. The transition boundary must refresh the
    // durable category before replacing stale execution state.
    snapshotFacts(backend.state.snapshots).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      'abc123' as ExecutionId,
    );
    backend.state.getOrCreateStreamState(stream, AgentCategory.Workflow);
    backend.state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 7 },
      stage: { kind: 'round', index: 2 },
      subagents: [
        {
          childStreamId: 'child-stream',
          executionId: 'finished-child',
          agentName: 'reviewer',
          identity: { kind: 'agent' as const, agent: 'reviewer' },
          finishedAt: 1,
        },
      ],
    }));

    await backend.applyStreamStatus(
      stream,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.COMPLETED,
    );

    expect(
      messages.some(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      ),
    ).toBe(false);

    const patch = metadataPatchFor(messages, stream);

    expect(patch.streamState).toMatchObject({
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
      conversationProgress: { toolCallCount: 0 },
      stage: null,
      subagents: [],
    });
    expect(JSON.parse(JSON.stringify(patch)).streamState.stage).toBeNull();
  });

  it('keeps resident background entries during an in-flight status update', async () => {
    const { backend } = createRecordingBackend();
    const stream = 'background-stream' as StreamTabId;
    const releaseSpy = vi.spyOn(backend.state.streamLogs, 'requestEviction');

    backend.state.streamLogs.ensureStream(stream);
    backend.state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.ToolUse,
    });
    backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

    await backend.applyStreamStatus(
      stream,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.RUNNING,
    );

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(backend.state.streamLogs.get(stream)).toBeDefined();
  });

  it('preserves logHead on status updates that evict unfocused streams', async () => {
    const { backend, messages } = await createPersistentRecordingBackend();
    const focused = 'focused-stream' as StreamTabId;
    const background = 'background-stream' as StreamTabId;

    try {
      backend.state.streamLogs.ensureStream(focused);
      backend.presentation.select(focused);
      backend.state.streamLogs.ensureStream(background);
      backend.state.updateStreamMetadata(background, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(background, AgentCategory.ToolUse);
      appendTranscriptEntry(backend.state.streamLogs, background, {
        id: 'seed-1',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'seed',
      });
      appendTranscriptEntry(backend.state.streamLogs, background, {
        id: 'seed-2',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 200,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'seed-2',
      });
      // Durability must drain first; dirty streams only queue release.
      await backend.state.flush();
      const expectedHead = backend.state.streamLogs.get(background)?.head;
      expect(expectedHead).toBeGreaterThan(0);

      messages.length = 0;
      await backend.applyStreamStatus(
        background,
        STREAM_PHASE.WAITING,
        STREAM_PHASE.RUNNING,
      );

      expect(backend.state.streamLogs.get(background)).toBeUndefined();
      const statusMessage = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS &&
          message.stream === background,
      );
      expect(statusMessage).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
        stream: background,
        status: STREAM_PHASE.WAITING,
        logHead: expectedHead,
        lastTimestamp: 200,
      });
    } finally {
      await backend.state.clearAll();
    }
  });

  it('drops buffered conversation progress when an existing stream re-enters running', async () => {
    vi.useFakeTimers();
    const { backend, messages } = createRecordingBackend();
    backend.setupEventListeners();
    const stream = 'tool-stream' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      backend.state.streamLogs.ensureStream(stream);
      backend.presentation.select(stream);
      snapshotFacts(backend.state.snapshots).setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        'abc123' as ExecutionId,
      );
      backend.state.updateStreamMetadata(stream, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

      backend.applyRunFact(stream, {
        type: 'conversation.progress',
        progress: { toolCallCount: 7 },
      });

      await backend.applyStreamStatus(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_PHASE.COMPLETED,
      );

      await vi.advanceTimersByTimeAsync(501);

      const patch = messages.find(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
          message.streamInfo.name === stream,
      );
      expect(patch).toMatchObject({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        streamState: {
          conversationProgress: { toolCallCount: 0 },
        },
      });
      expect(
        messages.some(
          (message) =>
            message.command ===
              PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS &&
            message.stream === stream &&
            message.progress.toolCallCount === 7,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a rejecting async fact handler through the SessionFacts channel', async () => {
    // The observable contract of the dispatch wrapper returning handler
    // promises to `withEventErrorHandling`: a post-await rejection reaches the
    // SessionFacts error log instead of escaping as an unhandled rejection. A
    // block-bodied handler that discarded its promise would leave this line
    // unwritten (and the run would flag an unhandled rejection instead).
    const lines: string[] = [];
    setOutputChannelFactory(() => ({
      appendLine: (line: string) => {
        lines.push(line);
      },
    }));
    try {
      const { backend } = createRecordingBackend();
      const stream = 'tool-stream' as StreamTabId;
      const failure = new Error('status application exploded');
      vi.spyOn(
        SessionFactApplier.prototype,
        'setStreamStatus',
      ).mockRejectedValue(failure);

      backend.applySessionFact({
        type: 'status',
        streamId: stream,
        phase: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
      });

      await vi.waitFor(() => {
        expect(
          lines.some(
            (line) =>
              line.startsWith('ERROR') &&
              line.includes('[SessionFacts] failed to handle status fact'),
          ),
        ).toBe(true);
      });
    } finally {
      setOutputChannelFactory(null);
    }
  });

  it('keeps snapshot metadata canonical across rendering and sync content', () => {
    const { backend, messages } = createRecordingBackend();
    const stream = 'search@deepseek#de5711c' as StreamTabId;
    const executionId = 'de5711c' as ExecutionId;

    backend.state.streamLogs.ensureStream(stream);
    // Provisional patches only ever carry agentCategory/isRemote in
    // production (see SessionFactApplier.handleSetActiveStream). Identity
    // comes from the immutable descriptor; input/model details come from
    // RunConfig, mirrored into the stream summary and overlaid at read time
    // by getStreamMetadata (#9947) — no refresh step exists anymore.
    backend.state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
      isRemote: true,
    });
    snapshotFacts(backend.state.snapshots).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    // A late provisional event cannot replace snapshot authority.
    backend.state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });

    expect(backend.state.getStreamMetadata(stream)).toMatchObject({
      agentCategory: AgentCategory.ToolUse,
      isRemote: true,
      executionId,
      config: expect.objectContaining({ model: 'deepseekproT' }),
    });
    // run.config alone never synthesizes identity; the tab stays pending
    // until run.start (or a durable ExecutionMeta.identity) supplies it.
    expect(backend.state.getStreamMetadata(stream).identity).toBeUndefined();

    const infos = buildStreamInfos(backend.state);
    expect(infos.map((info) => info.name)).toContain(stream);
    expect(infos.find((info) => info.name === stream)).toMatchObject({
      // Pending: labelled by the id's prefix, never the whole handle.
      label: 'search@deepseek',
      agentCategory: AgentCategory.ToolUse,
      isRemote: true,
      executionId,
    });

    backend.renderer.syncStreamContent(stream);
    const sync = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    );
    expect(sync).toMatchObject({
      stream,
      action: 'render',
      category: AgentCategory.ToolUse,
    });
  });

  it('models a workflow-script container from the extension event subscription', async () => {
    const target = createListeningBackend();
    const { backend } = target;
    const stream = 'workflow-script#f10a11' as StreamTabId;
    const executionId = 'f10a11' as ExecutionId;
    backend.state.streamLogs.ensureStream(stream);
    emitRunEvent(target, stream, {
      type: 'run.start',
      streamId: stream,
      executionId,
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
      },
    });
    emitRunConfig(
      target,
      stream,
      executionId,
      AgentConfigSchema.parse({
        agent: 'generic',
        model: 'gpt-5.6-sol',
        agentCategory: AgentCategory.Workflow,
        instruction: "Workflow script 'repo-cleanup-readonly-pilot-2026-07-24'",
      }),
    );

    await vi.waitFor(() =>
      expect(backend.state.getStreamMetadata(stream).identity).toEqual({
        kind: 'multiAgentWorkflow',
        workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
      }),
    );
    const workflowInfos = buildStreamInfos(backend.state);
    expect(workflowInfos).toContainEqual(
      expect.objectContaining({
        name: stream,
        label: 'repo-cleanup-readonly-pilot-2026-07-24',
        identity: {
          kind: 'multiAgentWorkflow',
          workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        },
        agentCategory: AgentCategory.Workflow,
      }),
    );
    const workflowScript = workflowInfos.find((info) => info.name === stream);
    expect(workflowScript?.model).toBeUndefined();
  });

  it('keeps metadata reads stable until an owning input changes', () => {
    const { backend } = createRecordingBackend();
    const stream = 'stable-metadata-stream' as StreamTabId;
    const executionId = 'e5ab1e' as ExecutionId;

    backend.state.streamLogs.ensureStream(stream);
    const initial = backend.state.getStreamMetadata(stream);
    expect(backend.state.getStreamMetadata(stream)).toBe(initial);

    backend.state.updateStreamMetadata(stream, { isRemote: true });
    const patched = backend.state.getStreamMetadata(stream);
    expect(patched).not.toBe(initial);
    expect(patched.isRemote).toBe(true);
    expect(backend.state.getStreamMetadata(stream)).toBe(patched);

    snapshotFacts(backend.state.snapshots).setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    const summarized = backend.state.getStreamMetadata(stream);
    expect(summarized).not.toBe(patched);
    expect(summarized.config?.model).toBe('deepseekproT');
    expect(backend.state.getStreamMetadata(stream)).toBe(summarized);

    appendTranscriptEntry(backend.state.streamLogs, stream, {
      id: 'first-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });
    const dated = backend.state.getStreamMetadata(stream);
    expect(dated).not.toBe(summarized);
    expect(dated.creationTimestamp).toBe(100);
    expect(backend.state.getStreamMetadata(stream)).toBe(dated);
  });

  it('promotes the transcript first timestamp into canonical metadata', () => {
    const { backend } = createRecordingBackend();
    const stream = 'timestamp-stream' as StreamTabId;
    const before = Date.now();

    backend.state.streamLogs.ensureStream(stream);
    // No transcript entry yet, so the tab is dated provisionally from when
    // this session first saw it.
    const provisional =
      backend.state.getStreamMetadata(stream).creationTimestamp;
    expect(provisional).toBeGreaterThanOrEqual(before);

    appendTranscriptEntry(backend.state.streamLogs, stream, {
      id: 'first-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });

    expect(backend.state.getStreamMetadata(stream).creationTimestamp).toBe(100);
    expect(
      buildStreamInfos(backend.state).find(
        (streamInfo) => streamInfo.name === stream,
      ),
    ).toMatchObject({ name: stream, creationTimestamp: 100 });
  });

  it('omits a provisionally removed stream from the selectable rail', () => {
    const { backend } = createRecordingBackend();
    const retained = 'retained-stream' as StreamTabId;
    const removing = 'removing-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(retained);
    backend.state.streamLogs.ensureStream(removing);
    backend.state.beginStreamRemoval(removing);

    // The durable transcript stays resident until the guarded deletion
    // commits, but the removal barrier is already the live membership
    // authority for every stream-tab projection.
    expect(backend.state.streamLogs.has(removing)).toBe(true);
    expect(backend.state.selectableStreamNames()).toContain(retained);
    expect(backend.state.selectableStreamNames()).not.toContain(removing);
    expect(
      buildStreamInfos(backend.state).map((stream) => stream.name),
    ).not.toContain(removing);
  });

  it('keeps a dated tab dated after its transcript is released', () => {
    const { backend } = createRecordingBackend();
    const stream = 'evicted-timestamp-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(stream);
    appendTranscriptEntry(backend.state.streamLogs, stream, {
      id: 'first-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });
    expect(backend.state.getStreamMetadata(stream).creationTimestamp).toBe(100);

    vi.spyOn(backend.state.streamLogs, 'getTimestampRange').mockReturnValue({
      first: undefined,
      last: undefined,
    });

    expect(backend.state.getStreamMetadata(stream).creationTimestamp).toBe(100);
  });
});
