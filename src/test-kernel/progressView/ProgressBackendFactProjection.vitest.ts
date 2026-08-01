/**
 * Fact projection and view sync: how run and session facts become stream
 * metadata, badges, and outbound messages, and how two sessions stay isolated
 * while projecting the same stream ids.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { buildStreamInfos } from '@controllers/progressView/backend/streamInfoUtils';
import {
  AgentCategory,
  type ActiveChildInfo,
  buildRunDescriptor,
  type CompileFailure,
  type InquiryThreadUpdatedEvent,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type ExecutionId,
  type FileLocation,
  type OutputFileInfo,
  type Plan,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';

import {
  createIsolatedRecordingBackend,
  createRecordingBackend,
  emitActiveStream,
  emitRunConfig,
  emitRunEvent,
  emitStreamDescription,
  toolUseConfig,
  track,
} from './progressBackendHarness';

describe('ProgressBackend', () => {
  it('sends the full metadata set once for full-view sync', () => {
    const { backend, messages } = createRecordingBackend();

    for (let i = 0; i < 20; i += 1) {
      backend.state.streamLogs.ensureStream(`history-${i}`);
    }

    backend.webviewUpdater.sendStreamMetadata(
      backend.state,
      backend.factApplier.getAllStreamStates(),
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

    const fullSync = messages.find(
      (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    );
    if (fullSync?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS) {
      expect(fullSync.streams).toHaveLength(20);
    } else {
      throw new Error('Expected full stream metadata sync');
    }
  });

  it('registers a suppressed interaction stream without switching to it', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    backend.setupEventListeners();

    emitActiveStream(target, {
      streamId: 'root',
      agentCategory: AgentCategory.Workflow,
    });
    await vi.waitFor(() => expect(backend.state.activeStream).toBe('root'));
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
    expect(backend.state.activeStream).toBe('root');
    expect(messages).toContainEqual(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        activeStream: undefined,
        streamInfo: expect.objectContaining({ name: 'hidden-approval' }),
      }),
    );
  });

  it('projects a workflow-script phase onto a non-active run stream', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    backend.setupEventListeners();
    const run = 'workflow-run' as StreamTabId;

    emitActiveStream(target, {
      streamId: 'root',
      agentCategory: AgentCategory.ToolUse,
    });
    await vi.waitFor(() => expect(backend.state.activeStream).toBe('root'));
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
    expect(backend.state.activeStream).toBe('root');
    await vi.waitFor(() =>
      expect(backend.state.getStreamState(run)).toMatchObject({
        phaseStage: { label: 'Reduce', index: 1, total: 3 },
      }),
    );
    const patch = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
        message.streamInfo.name === run,
    );
    if (patch?.command !== PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA) {
      throw new Error('Expected a metadata patch for the run stream');
    }
    expect(patch.streamState).toMatchObject({
      phaseStage: { label: 'Reduce', index: 1, total: 3 },
      roundStage: null,
    });
  });

  it('patches one stream for subagent registration and run-start metadata', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend, messages } = target;
    backend.setupEventListeners();

    for (let i = 0; i < 20; i += 1) {
      backend.state.streamLogs.ensureStream(`history-${i}`);
    }

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
    expect(
      messages.some(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ),
    ).toBe(false);
    messages.length = 0;

    emitRunConfig(
      target,
      'child' as StreamTabId,
      'c41111' as ExecutionId,
      toolUseConfig('search', 'deepseekproT'),
    );

    await vi.waitFor(() =>
      expect(
        messages.find(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        ),
      ).toMatchObject({
        streamInfo: {
          name: 'child',
          label: 'search',
          agent: 'search',
          model: 'deepseekproT',
          executionId: 'c41111',
        },
      }),
    );
    expect(
      messages.some(
        (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      ),
    ).toBe(false);

    const patch = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
    );
    messages.length = 0;

    backend.webviewUpdater.sendStreamMetadata(
      backend.state,
      backend.factApplier.getAllStreamStates(),
    );
    const fullSync = messages.find(
      (message) => message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    );

    if (
      patch?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
      fullSync?.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS
    ) {
      expect(
        fullSync.streams.find((stream) => stream.name === 'child'),
      ).toEqual(patch.streamInfo);
      expect(fullSync.streamStates?.child).toEqual(patch.streamState);
    } else {
      throw new Error('Expected patch and full sync messages');
    }
  });

  it('scopes direct session events to each backend session', async () => {
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    first.backend.setupEventListeners();
    second.backend.setupEventListeners();
    const firstStream = 'session:first' as StreamTabId;
    const secondStream = 'session:second' as StreamTabId;

    emitActiveStream(first, {
      streamId: firstStream,
      agentCategory: AgentCategory.Workflow,
    });

    await vi.waitFor(() =>
      expect(first.backend.state.activeStream).toBe(firstStream),
    );
    expect(second.backend.state.activeStream).not.toBe(firstStream);
    expect(JSON.stringify(second.messages)).not.toContain(firstStream);

    emitActiveStream(second, {
      streamId: secondStream,
      agentCategory: AgentCategory.ToolUse,
    });

    await vi.waitFor(() =>
      expect(second.backend.state.activeStream).toBe(secondStream),
    );
    expect(first.backend.state.activeStream).toBe(firstStream);
    expect(JSON.stringify(first.messages)).not.toContain(secondStream);
  });

  it('isolates same-stream run facts across simultaneous backend sessions', async () => {
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    first.backend.setupEventListeners();
    second.backend.setupEventListeners();
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
    const first = createIsolatedRecordingBackend();
    const second = createIsolatedRecordingBackend();
    first.backend.setupEventListeners();
    second.backend.setupEventListeners();
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
    first.backend.state.streamLogs.append(firstStream, {
      id: 'first-window-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_700_000_000_001,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });
    second.backend.state.streamLogs.append(secondStream, {
      id: 'second-window-log',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1_700_000_000_002,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'second transcript entry',
    });

    await vi.waitFor(() =>
      expect(first.backend.state.activeStream).toBe(firstStream),
    );
    await vi.waitFor(() =>
      expect(second.backend.state.activeStream).toBe(secondStream),
    );

    expect(first.backend.state.streamStatus.get(firstStream)).toBe(
      STREAM_PHASE.RUNNING,
    );
    expect(first.backend.state.streamStatus.get(secondStream)).toBeUndefined();
    expect(second.backend.state.streamStatus.get(secondStream)).toBe(
      STREAM_PHASE.WAITING,
    );
    expect(second.backend.state.streamStatus.get(firstStream)).toBeUndefined();

    expect(first.backend.state.snapshots.getExecutionId(firstStream)).toBe(
      firstExecution,
    );
    expect(
      first.backend.state.snapshots.getExecutionId(secondStream),
    ).toBeUndefined();
    expect(second.backend.state.snapshots.getExecutionId(secondStream)).toBe(
      secondExecution,
    );
    expect(
      second.backend.state.snapshots.getExecutionId(firstStream),
    ).toBeUndefined();
    expect(first.backend.state.snapshots.getDescription(firstStream)).toBe(
      'first window run',
    );
    expect(
      first.backend.state.snapshots.getDescription(secondStream),
    ).toBeUndefined();
    expect(second.backend.state.snapshots.getDescription(secondStream)).toBe(
      'second window run',
    );
    expect(
      second.backend.state.snapshots.getDescription(firstStream),
    ).toBeUndefined();

    expect(first.backend.state.streamLogs.get(firstStream)?.size).toBe(1);
    expect(first.backend.state.streamLogs.get(secondStream)).toBeUndefined();
    expect(second.backend.state.streamLogs.get(secondStream)?.size).toBe(1);
    expect(second.backend.state.streamLogs.get(firstStream)).toBeUndefined();
    expect(JSON.stringify(first.messages)).not.toContain(secondStream);
    expect(JSON.stringify(second.messages)).not.toContain(firstStream);
  });

  it('applies session run facts through the fact-native handler', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    backend.setupEventListeners();
    const handleRunFact = vi.spyOn(backend.factApplier, 'handleRunFact');
    const updateFiles = vi.spyOn(backend.webviewUpdater, 'updateFiles');
    const updateMissingOutputs = vi.spyOn(
      backend.webviewUpdater,
      'updateMissingOutputs',
    );
    const updateCompileFailures = vi.spyOn(
      backend.webviewUpdater,
      'updateCompileFailures',
    );
    const updateRunUsage = vi.spyOn(backend.webviewUpdater, 'updateRunUsage');
    const updateTodos = vi.spyOn(backend.webviewUpdater, 'updateTodos');
    const updatePlan = vi.spyOn(backend.webviewUpdater, 'updatePlan');
    const streamId = 'session:output-files' as StreamTabId;
    const storageKey = 'run:session-usage' as StorageKey;
    const location: FileLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/paper.tex',
      relativePath: 'paper.tex',
    };
    const outputFile: OutputFileInfo = {
      source: 'paper.tex',
      location,
      round: 1,
      lineage: null,
      diff: null,
    };
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

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      handleRunFact.mockClear();
      updateFiles.mockClear();
      updateMissingOutputs.mockClear();
      updateCompileFailures.mockClear();
      updateRunUsage.mockClear();
      updateTodos.mockClear();
      updatePlan.mockClear();

      emitRunEvent({ session }, streamId, {
        type: 'addOutputFiles',
        streamId,
        filesByRound: { 1: [outputFile] },
      });
      emitRunEvent({ session }, streamId, {
        type: 'updateMissingOutputs',
        streamId,
        filesByRound: { 1: ['paper.pdf'] },
      });
      emitRunEvent({ session }, streamId, {
        type: 'updateCompileFailures',
        streamId,
        filesByRound: { 1: [compileFailure] },
      });
      emitRunEvent({ session }, streamId, {
        type: 'updateTodos',
        streamId,
        todos,
      });
      emitRunEvent({ session }, streamId, {
        type: 'updatePlan',
        streamId,
        plan,
      });
      emitRunEvent({ session }, streamId, {
        type: 'usage',
        payload: {
          streamId,
          storageKey,
          usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
        },
        recordTranscript: false,
      });
      emitRunEvent({ session }, streamId, {
        type: 'goalPaused',
        streamId,
      });

      expect(handleRunFact).toHaveBeenCalledTimes(7);
      expect(updateFiles).toHaveBeenCalledTimes(1);
      expect(updateFiles).toHaveBeenCalledWith(streamId, {
        rounds: { 1: [outputFile] },
      });
      expect(updateMissingOutputs).toHaveBeenCalledWith(streamId, {
        rounds: { 1: ['paper.pdf'] },
      });
      expect(updateCompileFailures).toHaveBeenCalledWith(streamId, {
        rounds: { 1: [compileFailure] },
        reset: true,
      });
      expect(updateTodos).toHaveBeenCalledWith(streamId, todos);
      expect(updatePlan).toHaveBeenCalledWith(streamId, plan);
      await vi.waitFor(() =>
        expect(updateRunUsage).toHaveBeenCalledWith(streamId, storageKey, {
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
          cacheReadInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheCreationInputTokens: 0,
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
        new Map([
          [
            storageKey,
            {
              inputTokens: 10,
              outputTokens: 5,
              cost: 0.01,
              cacheReadInputTokens: 0,
              cacheMissInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          ],
        ]),
      );
    } finally {
      await backend.state.clearAll();
    }
  });

  it('drops malformed updateTodos/updatePlan run facts instead of forwarding them unchecked (#7562)', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    backend.setupEventListeners();
    const updateTodos = vi.spyOn(backend.webviewUpdater, 'updateTodos');
    const updatePlan = vi.spyOn(backend.webviewUpdater, 'updatePlan');
    const streamId = 'session:malformed-todos-plan' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      updateTodos.mockClear();
      updatePlan.mockClear();

      emitRunEvent({ session }, streamId, {
        type: 'domain',
        key: 'runFact.updateTodos',
        data: { streamId, todos: 'not-an-array' },
      });
      emitRunEvent({ session }, streamId, {
        type: 'domain',
        key: 'runFact.updatePlan',
        data: { streamId, plan: { steps: ['legacy shape'] } },
      });

      expect(updateTodos).not.toHaveBeenCalled();
      expect(updatePlan).not.toHaveBeenCalled();
    } finally {
      await backend.state.clearAll();
    }
  });

  it('no-ops session output-file run facts after dispose', async () => {
    const { backend, session } = createIsolatedRecordingBackend();
    backend.setupEventListeners();
    const handleRunFact = vi.spyOn(backend.factApplier, 'handleRunFact');
    const updateFiles = vi.spyOn(backend.webviewUpdater, 'updateFiles');
    const streamId = 'session:output-files-after-dispose' as StreamTabId;
    const location: FileLocation = {
      kind: 'workspace',
      absolutePath: '/workspace/paper.tex',
      relativePath: 'paper.tex',
    };
    const outputFile: OutputFileInfo = {
      source: 'paper.tex',
      location,
      round: 1,
      lineage: null,
      diff: null,
    };

    try {
      await backend.state.snapshots.load([]);
      emitActiveStream(
        { session },
        {
          streamId,
          agentCategory: AgentCategory.Workflow,
        },
      );
      handleRunFact.mockClear();
      updateFiles.mockClear();
      backend.dispose();

      emitRunEvent({ session }, streamId, {
        type: 'addOutputFiles',
        streamId,
        filesByRound: { 1: [outputFile] },
      });

      expect(handleRunFact).not.toHaveBeenCalled();
      expect(updateFiles).not.toHaveBeenCalled();
      // The presentation no-ops, but the sidecar store is session-owned, so it
      // keeps recording: disposing one window/webview must not stop the runtime
      // persisting an in-flight run's outputs. The desktop already behaved this
      // way (its `stateOwnership: 'session'` backend never detached the store);
      // the extension now matches it.
      expect(backend.state.snapshots.getOutputFiles(streamId)).toEqual({
        1: [outputFile],
      });
    } finally {
      await backend.state.clearAll();
    }
  });

  it('handles session facts directly', async () => {
    const target = createIsolatedRecordingBackend();
    target.backend.setupEventListeners();
    const parentStreamId = 'session:parent' as StreamTabId;
    const childStreamId = 'session:child' as StreamTabId;
    const executionId = 'exec:direct-session' as ExecutionId;
    const child: ActiveChildInfo = {
      kind: 'subagent',
      executionId: 'exec:child' as ExecutionId,
      childStreamId,
      agentName: 'orchestrator',
      status: 'running',
      startedAt: 1,
      elapsed: null,
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

    try {
      await target.backend.state.snapshots.load([]);
      emitActiveStream(target, {
        streamId: parentStreamId,
        agentCategory: AgentCategory.ToolUse,
      });
      emitRunEvent(target, parentStreamId, {
        type: 'status',
        streamId: parentStreamId,
        phase: STREAM_PHASE.RUNNING,
        cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
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
        expect(target.backend.state.activeStream).toBe(parentStreamId),
      );
      target.messages.length = 0;

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

      expect(target.backend.state.getStreamState(parentStreamId)).toMatchObject(
        {
          roundStage: { index: 2, total: 4 },
          subagents: [child],
        },
      );
      expect(
        target.backend.state.snapshots.getMissingOutputs(parentStreamId),
      ).toEqual({});
      expect(
        target.messages.some(
          (message) =>
            message.command === PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD,
        ),
      ).toBe(true);
    } finally {
      await target.backend.state.clearAll();
    }
  });

  it('keeps the selection when an unknown stream reaches running', async () => {
    const { backend, messages } = createRecordingBackend();

    backend.state.streamLogs.ensureStream('tool-stream');
    backend.state.updateStreamMetadata('tool-stream', {
      agentCategory: AgentCategory.ToolUse,
    });
    backend.state.getOrCreateStreamState('tool-stream', AgentCategory.ToolUse);
    backend.state.switchActiveStream('tool-stream');

    await backend.factApplier.setStreamStatus(
      'unknown-stream',
      STREAM_PHASE.RUNNING,
    );

    const patch = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
        message.streamInfo.name === 'unknown-stream',
    );
    expect(backend.state.activeStream).toBe('tool-stream');
    expect(patch).toMatchObject({
      activeStream: undefined,
      streamInfo: {
        name: 'unknown-stream',
        agentCategory: AgentCategory.Workflow,
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
    backend.state.snapshots.setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      'abc123' as ExecutionId,
    );
    backend.state.getOrCreateStreamState(stream, AgentCategory.Workflow);
    backend.state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 7 },
      roundStage: { index: 2 },
      subagents: [
        {
          kind: 'subagent',
          childStreamId: 'child-stream',
          executionId: 'finished-child',
          agentName: 'reviewer',
          finishedAt: 1,
        },
      ],
    }));

    await backend.factApplier.setStreamStatus(
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

    const patch = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA &&
        message.streamInfo.name === stream,
    );
    if (patch?.command !== PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA) {
      throw new Error('Expected existing stream metadata patch');
    }

    expect(patch.streamState).toMatchObject({
      kind: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
      conversationProgress: { toolCallCount: 0 },
      roundStage: null,
      subagents: [],
    });
    expect(JSON.parse(JSON.stringify(patch)).streamState.roundStage).toBeNull();
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

    await backend.factApplier.setStreamStatus(
      stream,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.RUNNING,
    );

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(backend.state.streamLogs.get(stream)).toBeDefined();
  });

  it('drops buffered conversation progress when an existing stream re-enters running', async () => {
    vi.useFakeTimers();
    const { backend, messages } = createRecordingBackend();
    backend.setupEventListeners();
    const stream = 'tool-stream' as StreamTabId;

    try {
      await backend.state.snapshots.load([]);
      backend.state.streamLogs.ensureStream(stream);
      backend.state.switchActiveStream(stream);
      backend.state.snapshots.setRunConfig(
        stream,
        toolUseConfig('search', 'deepseekproT'),
        'abc123' as ExecutionId,
      );
      backend.state.updateStreamMetadata(stream, {
        agentCategory: AgentCategory.ToolUse,
      });
      backend.state.getOrCreateStreamState(stream, AgentCategory.ToolUse);

      backend.factApplier.handleRunFact(stream, {
        type: 'conversation.progress',
        progress: { toolCallCount: 7 },
      });

      await backend.factApplier.setStreamStatus(
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

  it('propagates async fact-handler promises to the error wrapper', async () => {
    const { backend } = createRecordingBackend();
    const stream = 'tool-stream' as StreamTabId;

    // A tracking thenable: `withEventErrorHandling` does
    // `Promise.resolve(result).catch(...)`, which adopts (calls `.then` on) the
    // handler's result only when the dispatch wrapper actually RETURNED it. A
    // block-bodied handler that discarded the promise would hand
    // `withEventErrorHandling` `undefined`, leaving this untouched — and a
    // post-await rejection would then escape logging as an unhandled rejection.
    // `setStreamStatus` now has exactly one caller — the session-fact
    // canonical `status` path — since `StreamStatusMachine` publishes every
    // transition on that rail and the run-fact arm is gone.
    let adopted = 0;
    const tracking: PromiseLike<void> = {
      then(onFulfilled, onRejected) {
        adopted += 1;
        return Promise.resolve().then(onFulfilled, onRejected);
      },
    };
    vi.spyOn(backend.factApplier, 'setStreamStatus').mockReturnValue(
      tracking as Promise<void>,
    );

    backend.factApplier.handleSessionFact({
      type: 'status',
      streamId: stream,
      phase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });

    // Thenable adoption runs on a microtask; flush before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(adopted).toBe(1);
  });

  it('keeps task-state metadata canonical across rendering and sync content', () => {
    const { backend, messages } = createRecordingBackend();
    const stream = 'search@deepseek#de5711c' as StreamTabId;
    const executionId = 'de5711c' as ExecutionId;

    backend.state.streamLogs.ensureStream(stream);
    // Provisional patches only ever carry agentCategory/isRemote in
    // production (see ProgressFactApplier.handleSetActiveStream). Identity
    // comes from the immutable descriptor; input/model details come from
    // RunConfig and are assembled atomically by applySnapshotMetadata.
    backend.state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
      isRemote: true,
    });
    backend.state.snapshots.setRunConfig(
      stream,
      toolUseConfig('search', 'deepseekproT'),
      executionId,
    );
    backend.state.refreshStreamMetadataFromSnapshot(stream);
    // A late provisional event cannot replace task-state authority.
    backend.state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });

    expect(backend.state.getStreamMetadata(stream)).toMatchObject({
      agentCategory: AgentCategory.ToolUse,
      isRemote: true,
      executionId,
      run: expect.objectContaining({
        kind: 'agent',
        agent: 'search',
        model: 'deepseekproT',
      }),
    });

    const infos = buildStreamInfos(backend.state);
    expect(infos.map((info) => info.name)).toContain(stream);
    expect(infos.find((info) => info.name === stream)).toMatchObject({
      agent: 'search',
      agentCategory: AgentCategory.ToolUse,
      model: 'deepseekproT',
      isRemote: true,
      executionId,
    });

    backend.factApplier.syncStreamContent(stream);
    const sync = messages.find(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    );
    expect(sync).toMatchObject({
      stream,
      action: 'render',
      kind: AgentCategory.ToolUse,
    });
  });

  it('models a workflow-script container from the extension event subscription', async () => {
    const target = createIsolatedRecordingBackend();
    const { backend } = target;
    backend.setupEventListeners();
    const stream = 'workflow-script#f10a11' as StreamTabId;
    const executionId = 'f10a11' as ExecutionId;
    const descriptor = buildRunDescriptor({
      streamId: stream,
      executionId,
      agent: 'repo-cleanup-readonly-pilot-2026-07-24',
      category: AgentCategory.Workflow,
      kind: 'workflowScript',
    });

    backend.state.streamLogs.ensureStream(stream);
    emitRunEvent(target, stream, { type: 'run.start', descriptor });
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
      expect(backend.state.getStreamMetadata(stream).run).toEqual({
        kind: 'workflowScript',
        workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        instruction: "Workflow script 'repo-cleanup-readonly-pilot-2026-07-24'",
      }),
    );
    const workflowInfos = buildStreamInfos(backend.state);
    expect(workflowInfos).toContainEqual(
      expect.objectContaining({
        name: stream,
        label: 'repo-cleanup-readonly-pilot-2026-07-24',
        kind: 'workflowScript',
        workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        agentCategory: AgentCategory.Workflow,
      }),
    );
    const workflowScript = workflowInfos.find((info) => info.name === stream);
    expect(workflowScript).not.toHaveProperty('agent');
    expect(workflowScript).not.toHaveProperty('model');
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

    backend.state.streamLogs.append(stream, {
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

  it('keeps a dated tab dated after its transcript is released', () => {
    const { backend } = createRecordingBackend();
    const stream = 'evicted-timestamp-stream' as StreamTabId;

    backend.state.streamLogs.ensureStream(stream);
    backend.state.streamLogs.append(stream, {
      id: 'first-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'first transcript entry',
    });
    expect(backend.state.getStreamMetadata(stream).creationTimestamp).toBe(100);

    vi.spyOn(backend.state.streamLogs, 'getFirstTimestamp').mockReturnValue(
      undefined,
    );

    expect(backend.state.getStreamMetadata(stream).creationTimestamp).toBe(100);
  });
});
