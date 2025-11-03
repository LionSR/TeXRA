// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import { DEFAULT_TOOL_CONFIG } from '@agent/core/ToolConfig';
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import * as executeAgentModule from '@agent/runtime/executeAgent';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import { clearToolUseAgents } from '@agent/toolUse/ToolUseAgentRegistry';
import {
  sendFollowUp,
  resumeFromSnapshot,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - progress view
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';

describe('ToolUseFollowUpCoordinator', () => {
  interface TaskState {
    agentConfig: any;
    session: { agentCategory: AgentCategory; agentType: AgentType };
  }

  let warningMessages: string[];
  let statusChanges: { streamId: string; status: string }[];
  let setResumingCalls: StreamTabId[];
  let clearResumingCalls: StreamTabId[];
  let drainCalls: StreamTabId[];
  let drainImplementation: ((streamId: StreamTabId) => string[]) | undefined;
  let consumeCalls: StreamTabId[];
  let consumeImplementation:
    | ((streamId: StreamTabId) => ToolUseSessionSnapshot | undefined)
    | undefined;
  let isResumingState = false;
  let isResumingCalls: StreamTabId[];
  let enqueueCalls: { streamId: StreamTabId; followUp: string }[];
  let enqueueImplementation:
    | ((streamId: StreamTabId, followUp: string) => boolean)
    | undefined;
  let pendingSnapshot:
    | ((streamId: StreamTabId) => ToolUseSessionSnapshot | undefined)
    | undefined;
  let prepareAgentImplementation:
    | ((factory: (init: any) => AgentExecutionContext) => Promise<{
        agent: BaseToolUseAgent;
        agentType: AgentType;
        context?: AgentExecutionContext;
      }>)
    | undefined;
  let executeCalls: {
    agentName: string;
    executionId: string;
    resume: boolean;
  }[];
  let executeImplementation: (() => Promise<void>) | undefined;
  let providerTaskState: TaskState | undefined;

  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalIsPersistenceEnabled =
    ToolUseSessionManager.isPersistenceEnabled;
  const originalSetResuming = ToolUseSessionManager.setResumingSession;
  const originalClearResuming = ToolUseSessionManager.clearResumingSession;
  const originalDrainQueued = ToolUseSessionManager.drainQueuedFollowUps;
  const originalConsumeSnapshot =
    ToolUseSessionManager.consumeSnapshotForStream;
  const originalGetSnapshot = ToolUseSessionManager.getSnapshotForStream;
  const originalIsResuming = ToolUseSessionManager.isResumingSession;
  const originalEnqueue = ToolUseSessionManager.enqueueFollowUpWhileResuming;
  const originalPrepareAgent = executeAgentModule.prepareAgentInstance;
  const originalExecuteAgent = executeAgentModule.executeAgentWithLogging;
  const originalProgressGetInstance = ProgressViewProvider.getInstance;

  beforeEach(() => {
    warningMessages = [];
    statusChanges = [];
    setResumingCalls = [];
    clearResumingCalls = [];
    drainCalls = [];
    drainImplementation = undefined;
    consumeCalls = [];
    consumeImplementation = undefined;
    isResumingState = false;
    isResumingCalls = [];
    enqueueCalls = [];
    enqueueImplementation = undefined;
    pendingSnapshot = undefined;
    prepareAgentImplementation = undefined;
    executeCalls = [];
    executeImplementation = undefined;
    providerTaskState = undefined;

    (vscode.window as any).showWarningMessage = async (message: string) => {
      warningMessages.push(message);
      return undefined;
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      }
    ).isPersistenceEnabled = () => true;

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      }
    ).setResumingSession = (streamId: StreamTabId) => {
      setResumingCalls.push(streamId);
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      }
    ).clearResumingSession = (streamId: StreamTabId) => {
      clearResumingCalls.push(streamId);
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).drainQueuedFollowUps = (streamId: StreamTabId) => {
      drainCalls.push(streamId);
      if (drainImplementation) {
        return drainImplementation(streamId);
      }
      return [];
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      }
    ).consumeSnapshotForStream = (streamId: StreamTabId) => {
      consumeCalls.push(streamId);
      if (consumeImplementation) {
        return consumeImplementation(streamId);
      }
      return undefined;
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      }
    ).getSnapshotForStream = (streamId: StreamTabId) => {
      if (pendingSnapshot) {
        return pendingSnapshot(streamId);
      }
      return undefined;
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).isResumingSession = (streamId: StreamTabId) => {
      isResumingCalls.push(streamId);
      return isResumingState;
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      }
    ).enqueueFollowUpWhileResuming = (
      streamId: StreamTabId,
      followUp: string,
    ) => {
      enqueueCalls.push({ streamId, followUp });
      if (enqueueImplementation) {
        return enqueueImplementation(streamId, followUp);
      }
      return false;
    };

    (
      executeAgentModule as typeof executeAgentModule & {
        prepareAgentInstance: typeof executeAgentModule.prepareAgentInstance;
      }
    ).prepareAgentInstance = (async (params: any) => {
      if (!prepareAgentImplementation) {
        throw new Error('prepareAgentInstance was not stubbed');
      }
      const factory =
        params.contextFactory ??
        ((init: any) => new AgentExecutionContext(init));
      return prepareAgentImplementation(factory);
    }) as typeof executeAgentModule.prepareAgentInstance;

    (
      executeAgentModule as typeof executeAgentModule & {
        executeAgentWithLogging: typeof executeAgentModule.executeAgentWithLogging;
      }
    ).executeAgentWithLogging = (async (
      agentName: string,
      createFn: (
        factory: (init: any) => AgentExecutionContext,
      ) => Promise<{ agent: BaseToolUseAgent }>,
      executionId: string,
      options: { resume?: boolean },
    ) => {
      executeCalls.push({
        agentName,
        executionId,
        resume: Boolean(options.resume),
      });
      await createFn((init) => new AgentExecutionContext(init));
      if (executeImplementation) {
        await executeImplementation();
      }
    }) as typeof executeAgentModule.executeAgentWithLogging;

    (
      ProgressViewProvider as typeof ProgressViewProvider & {
        getInstance: typeof ProgressViewProvider.getInstance;
      }
    ).getInstance = () => {
      if (!providerTaskState) {
        return undefined as unknown as ProgressViewProvider;
      }
      return {
        state: {
          getTaskState: () => providerTaskState,
        },
        eventHandler: {
          getStreamStatus: () => STATUS.WAITING,
          setStreamStatus: (streamId: string, status: string) => {
            statusChanges.push({ streamId, status });
          },
        },
      } as unknown as ProgressViewProvider;
    };
  });

  afterEach(() => {
    clearToolUseAgents();
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      }
    ).isPersistenceEnabled = originalIsPersistenceEnabled;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      }
    ).setResumingSession = originalSetResuming;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      }
    ).clearResumingSession = originalClearResuming;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).drainQueuedFollowUps = originalDrainQueued;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      }
    ).consumeSnapshotForStream = originalConsumeSnapshot;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      }
    ).getSnapshotForStream = originalGetSnapshot;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).isResumingSession = originalIsResuming;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      }
    ).enqueueFollowUpWhileResuming = originalEnqueue;
    (
      executeAgentModule as typeof executeAgentModule & {
        prepareAgentInstance: typeof executeAgentModule.prepareAgentInstance;
      }
    ).prepareAgentInstance = originalPrepareAgent;
    (
      executeAgentModule as typeof executeAgentModule & {
        executeAgentWithLogging: typeof executeAgentModule.executeAgentWithLogging;
      }
    ).executeAgentWithLogging = originalExecuteAgent;
    (
      ProgressViewProvider as typeof ProgressViewProvider & {
        getInstance: typeof ProgressViewProvider.getInstance;
      }
    ).getInstance = originalProgressGetInstance;
  });

  function createSnapshot(streamId: StreamTabId): ToolUseSessionSnapshot {
    return {
      version: 1,
      executionId: 'exec-id',
      streamId,
      agentName: 'demo-agent',
      model: 'demo-model',
      session: {
        agentType: AgentType.ToolUse,
        agentCategory: AgentCategory.ToolUse,
      },
      messages: [],
      toolState: {
        texcountStats: null,
        lastResponse: '',
        accumulatedOutput: '',
        mediaFiles: [],
        thinkingBlocks: [],
        thinkingAdded: false,
      },
      lastUpdated: Date.now(),
    };
  }

  function setProviderTaskState(streamId: StreamTabId): void {
    providerTaskState = {
      agentConfig: {
        agent: 'demo-agent',
        model: 'demo-model',
        instruction: '',
        useMultipleOutputs: false,
        session: {
          agentCategory: AgentCategory.ToolUse,
          agentType: AgentType.ToolUse,
        },
        inputFile: '',
        inputFiles: null,
        referenceFile: null,
        referenceFiles: null,
        auxiliaryFile: null,
        auxiliaryFiles: null,
        mediaFile: null,
        mediaFiles: null,
        outputFiles: null,
        editedFile: null,
        toolConfig: DEFAULT_TOOL_CONFIG,
      },
      session: {
        agentCategory: AgentCategory.ToolUse,
        agentType: AgentType.ToolUse,
      },
    };
  }

  it('resumes a snapshot and flushes queued follow-ups', async () => {
    const streamId = 'stream-success' as StreamTabId;
    const snapshot = createSnapshot(streamId);
    setProviderTaskState(streamId);

    const appended: string[] = [];
    const agent = {
      resumeFromSnapshot: (_snapshot: ToolUseSessionSnapshot) => {
        appended.push('resume-called');
      },
      appendFollowUp: (text: string) => {
        appended.push(text);
      },
    } as unknown as BaseToolUseAgent;

    prepareAgentImplementation = async (factory) => ({
      agent,
      agentType: AgentType.ToolUse,
      context: factory({
        streamId,
        executionId: snapshot.executionId,
      }),
    });

    drainImplementation = () => ['queued-follow-up'];
    executeImplementation = async () => {
      /* noop */
    };

    const result = await resumeFromSnapshot(snapshot, 'initial follow-up');

    assert.deepStrictEqual(result, { success: true });
    assert.deepStrictEqual(setResumingCalls, [streamId]);
    assert.deepStrictEqual(clearResumingCalls, [streamId]);
    assert.deepStrictEqual(drainCalls, [streamId]);
    assert.deepStrictEqual(consumeCalls, [streamId]);
    assert.strictEqual(executeCalls.length, 1);
    assert.deepStrictEqual(executeCalls[0], {
      agentName: 'demo-agent',
      executionId: 'exec-id',
      resume: true,
    });
    assert.deepStrictEqual(statusChanges, [
      { streamId, status: STATUS.RESUMING },
      { streamId, status: STATUS.WAITING },
    ]);
    assert.deepStrictEqual(warningMessages, []);
    assert.deepStrictEqual(appended, [
      'resume-called',
      'initial follow-up',
      'queued-follow-up',
    ]);
  });

  it('surfaces warning messages when resume fails', async () => {
    const streamId = 'stream-failure' as StreamTabId;
    const snapshot = createSnapshot(streamId);
    setProviderTaskState(streamId);

    const agent = {
      resumeFromSnapshot: () => {
        /* noop */
      },
      appendFollowUp: () => {
        /* noop */
      },
    } as unknown as BaseToolUseAgent;

    prepareAgentImplementation = async (factory) => ({
      agent,
      agentType: AgentType.ToolUse,
      context: factory({
        streamId,
        executionId: snapshot.executionId,
      }),
    });

    drainImplementation = () => ['first', 'second'];
    executeImplementation = async () => {
      throw new Error('resume failed');
    };

    const result = await resumeFromSnapshot(snapshot, 'lost follow-up');

    assert.deepStrictEqual(result, { success: false, lostFollowUps: 2 });
    assert.deepStrictEqual(setResumingCalls, [streamId]);
    assert.deepStrictEqual(clearResumingCalls, [streamId]);
    assert.deepStrictEqual(drainCalls, [streamId]);
    assert.deepStrictEqual(consumeCalls, []);
    assert.strictEqual(statusChanges.length, 2);
    assert.deepStrictEqual(statusChanges, [
      { streamId, status: STATUS.RESUMING },
      { streamId, status: STATUS.WAITING },
    ]);
    assert.strictEqual(warningMessages.length, 1);
    assert.ok(
      warningMessages[0].includes('2 queued follow-ups were lost.'),
      'warning message should include lost follow-up count',
    );
  });

  it('queues follow-ups while a resume is in progress', async () => {
    const streamId = 'stream-queued' as StreamTabId;
    isResumingState = true;
    enqueueImplementation = () => true;

    await sendFollowUp(streamId, 'queued follow-up');

    assert.deepStrictEqual(isResumingCalls, [streamId]);
    assert.deepStrictEqual(enqueueCalls, [
      { streamId, followUp: 'queued follow-up' },
    ]);
    assert.deepStrictEqual(drainCalls, []);
    assert.deepStrictEqual(consumeCalls, []);
    assert.deepStrictEqual(setResumingCalls, []);
    assert.deepStrictEqual(statusChanges, []);
    assert.deepStrictEqual(warningMessages, []);
  });
});
