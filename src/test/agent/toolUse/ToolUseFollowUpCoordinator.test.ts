// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import * as ExecuteAgentModule from '@agent/runtime/executeAgent';
import * as ToolUseAgentRegistry from '@agent/toolUse/ToolUseAgentRegistry';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';
import type {
  ExecutionId,
  StreamTabId,
} from '@agent/types/IdentifierTypes';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';

// Local imports - coordinator
import {
  resumeFromSnapshot,
  sendFollowUp,
} from '@agent/toolUse/ToolUseFollowUpCoordinator';

describe('ToolUseFollowUpCoordinator', () => {
  const streamId = 'stream-1' as StreamTabId;
  const executionId = 'exec-1' as ExecutionId;
  const snapshot: ToolUseSessionSnapshot = {
    version: 1,
    executionId,
    streamId,
    agentName: 'test-agent',
    model: 'model',
    session: { agentType: AgentType.ToolUse, agentCategory: AgentCategory.ToolUse },
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

  const taskState = {
    agentConfig: {
      model: 'model',
      agent: 'test-agent',
      instruction: '',
      useMultipleOutputs: false,
      session: {
        agentType: AgentType.ToolUse,
        agentCategory: AgentCategory.ToolUse,
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
    },
  };

  let provider: any;

  let warningMessages: string[];

  const originalGetInstance = ProgressViewProvider.getInstance;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalIsPersistenceEnabled = ToolUseSessionManager.isPersistenceEnabled;
  const originalGetSnapshot = ToolUseSessionManager.getSnapshotForStream;
  const originalConsumeSnapshot = ToolUseSessionManager.consumeSnapshotForStream;
  const originalSetResuming = ToolUseSessionManager.setResumingSession;
  const originalClearResuming = ToolUseSessionManager.clearResumingSession;
  const originalDrainQueued = ToolUseSessionManager.drainQueuedFollowUps;
  const originalEnqueueFollowUp = ToolUseSessionManager.enqueueFollowUpWhileResuming;
  const originalIsResuming = ToolUseSessionManager.isResumingSession;
  const originalPrepareAgentInstance = ExecuteAgentModule.prepareAgentInstance;
  const originalExecuteAgentWithLogging = ExecuteAgentModule.executeAgentWithLogging;
  const originalGetToolUseAgent = ToolUseAgentRegistry.getToolUseAgent;

  beforeEach(() => {
    provider = {
      state: {
        getTaskState: (stream: string) => (stream === streamId ? taskState : undefined),
      },
      eventHandler: {
        getStreamStatus: () => STATUS.WAITING,
        setStreamStatus: () => {},
      },
    };

    warningMessages = [];

    (ProgressViewProvider as typeof ProgressViewProvider & {
      getInstance: typeof ProgressViewProvider.getInstance;
    }).getInstance = () => provider as unknown as ProgressViewProvider;

    (vscode.window as any).showWarningMessage = async (message: string) => {
      warningMessages.push(message);
      return undefined;
    };

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).isPersistenceEnabled = () => true;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).getSnapshotForStream = () => snapshot;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).consumeSnapshotForStream = () => undefined;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).setResumingSession = () => {};

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).clearResumingSession = () => {};

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).drainQueuedFollowUps = () => [];

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).enqueueFollowUpWhileResuming = () => true;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).isResumingSession = () => false;

    (ExecuteAgentModule as typeof ExecuteAgentModule & {
      prepareAgentInstance: typeof ExecuteAgentModule.prepareAgentInstance;
      executeAgentWithLogging: typeof ExecuteAgentModule.executeAgentWithLogging;
    }).prepareAgentInstance = async () =>
      ({
        agent: {
          resumeFromSnapshot: () => {},
          appendFollowUp: () => {},
        } as unknown as BaseToolUseAgent,
        agentType: AgentType.ToolUse,
      }) as any;

    (ExecuteAgentModule as typeof ExecuteAgentModule & {
      prepareAgentInstance: typeof ExecuteAgentModule.prepareAgentInstance;
      executeAgentWithLogging: typeof ExecuteAgentModule.executeAgentWithLogging;
    }).executeAgentWithLogging = async (_agentName, factory) => {
      await factory();
    };

    (ToolUseAgentRegistry as typeof ToolUseAgentRegistry & {
      getToolUseAgent: typeof ToolUseAgentRegistry.getToolUseAgent;
    }).getToolUseAgent = () => undefined;
  });

  afterEach(() => {
    (ProgressViewProvider as typeof ProgressViewProvider & {
      getInstance: typeof ProgressViewProvider.getInstance;
    }).getInstance = originalGetInstance;

    (vscode.window as any).showWarningMessage = originalShowWarningMessage;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).isPersistenceEnabled = originalIsPersistenceEnabled;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).getSnapshotForStream = originalGetSnapshot;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).consumeSnapshotForStream = originalConsumeSnapshot;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).setResumingSession = originalSetResuming;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).clearResumingSession = originalClearResuming;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).drainQueuedFollowUps = originalDrainQueued;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).enqueueFollowUpWhileResuming = originalEnqueueFollowUp;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isPersistenceEnabled: typeof ToolUseSessionManager.isPersistenceEnabled;
      getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
    }).isResumingSession = originalIsResuming;

    (ExecuteAgentModule as typeof ExecuteAgentModule & {
      prepareAgentInstance: typeof ExecuteAgentModule.prepareAgentInstance;
      executeAgentWithLogging: typeof ExecuteAgentModule.executeAgentWithLogging;
    }).prepareAgentInstance = originalPrepareAgentInstance;

    (ExecuteAgentModule as typeof ExecuteAgentModule & {
      prepareAgentInstance: typeof ExecuteAgentModule.prepareAgentInstance;
      executeAgentWithLogging: typeof ExecuteAgentModule.executeAgentWithLogging;
    }).executeAgentWithLogging = originalExecuteAgentWithLogging;

    (ToolUseAgentRegistry as typeof ToolUseAgentRegistry & {
      getToolUseAgent: typeof ToolUseAgentRegistry.getToolUseAgent;
    }).getToolUseAgent = originalGetToolUseAgent;
  });

  it('successfully resumes and consumes the snapshot', async () => {
    const consumed: StreamTabId[] = [];
    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
    }).consumeSnapshotForStream = (stream: StreamTabId) => {
      consumed.push(stream);
      return undefined;
    };

    const result = await resumeFromSnapshot(snapshot);
    assert.deepStrictEqual(result, { success: true });
    assert.deepStrictEqual(consumed, [streamId]);
    assert.strictEqual(warningMessages.length, 0);
  });

  it('reports failures and warns about lost follow-ups', async () => {
    const lostFollowUps = ['first', 'second'];
    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
    }).drainQueuedFollowUps = () => lostFollowUps;

    (ExecuteAgentModule as typeof ExecuteAgentModule & {
      executeAgentWithLogging: typeof ExecuteAgentModule.executeAgentWithLogging;
    }).executeAgentWithLogging = async () => {
      throw new Error('boom');
    };

    const result = await resumeFromSnapshot(snapshot);
    assert.deepStrictEqual(result, {
      success: false,
      lostFollowUps: lostFollowUps.length,
    });
    assert.strictEqual(warningMessages.length, 1);
    assert.ok(
      warningMessages[0].includes('boom'),
      'warning should include failure reason',
    );
    assert.ok(
      warningMessages[0].includes('2 queued follow-ups were lost'),
      'warning should include lost follow-up count',
    );
  });

  it('queues follow-ups when a resume is already in progress', async () => {
    const queued: Array<{ stream: StreamTabId; followUp: string }> = [];

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
    }).isResumingSession = () => true;

    (ToolUseSessionManager as typeof ToolUseSessionManager & {
      isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
    }).enqueueFollowUpWhileResuming = (stream, followUp) => {
      queued.push({ stream, followUp });
      return true;
    };

    await sendFollowUp(streamId, 'deferred');

    assert.deepStrictEqual(queued, [
      { stream: streamId, followUp: 'deferred' },
    ]);
  });

  it('appends to an active agent without resuming', async () => {
    const received: string[] = [];
    const agent: BaseToolUseAgent = {
      resumeFromSnapshot: () => {},
      appendFollowUp: (text: string) => {
        received.push(text);
      },
    } as unknown as BaseToolUseAgent;

    (ToolUseAgentRegistry as typeof ToolUseAgentRegistry & {
      getToolUseAgent: typeof ToolUseAgentRegistry.getToolUseAgent;
    }).getToolUseAgent = () => agent;

    await sendFollowUp(streamId, 'direct');

    assert.deepStrictEqual(received, ['direct']);
  });
});
