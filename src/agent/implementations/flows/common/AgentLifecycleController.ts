// Local imports - agent types
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { ToolState } from '@agent/core/ToolState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - events & persistence
import { bus } from '@eventBus/ProgressEventBus';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

export interface AgentLifecycleControllerOptions {
  logger: AgentLogger;
  runLabel: string;
  streamId: StreamTabId;
  onRegister?(streamId: StreamTabId): void;
  onUnregister?(streamId: StreamTabId): void;
}

export interface AgentLifecycleHooks {
  start(): Promise<string | undefined>;
  init(runGroupId: string | undefined): Promise<void>;
  initializeClient(): Promise<void>;
  end(status: 'stopped' | 'error'): void | Promise<void>;
  cleanup(): void | Promise<void>;
  requestInterruption(): void;
  isInterruptionRequested(): boolean;
  checkInterruption(): boolean;
  setAbortController(controller: AbortController | null): void;
}

export type AgentRunHookOverrides = Partial<
  Pick<
    AgentLifecycleHooks,
    'start' | 'init' | 'initializeClient' | 'end' | 'cleanup'
  >
>;

export interface ToolUseLifecycleOptions {
  getExecutionId(): ExecutionId | undefined;
  getMessages(): ProviderMessage[];
  getToolState(): ToolState | null;
  getSessionDescriptor(): AgentSessionDescriptor;
  getAgentIdentifier(): { agentName: string; modelName: string };
}

export interface ToolUseLifecycleHooks {
  appendFollowUp(text: string): void;
  hasQueuedFollowUp(): boolean;
  waitForFollowUp(): Promise<string | null>;
  enterWaitingState(): Promise<void>;
  clearPersistedSnapshot(): Promise<void>;
  markRunning(): Promise<void>;
  resumeFromSnapshot(snapshot: ToolUseSessionSnapshot): void;
  consumeResumeSnapshot(): ToolUseSessionSnapshot | null;
  cancelPendingFollowUpWait(): void;
  reset(): void;
}

class ToolUseLifecycle implements ToolUseLifecycleHooks {
  private followUpQueue: string[] = [];
  private followUpResolver: ((value: string | null) => void) | null = null;
  private resumeSnapshot: ToolUseSessionSnapshot | null = null;
  private hasPersistedSnapshot = false;
  private persistenceLock = false;

  constructor(
    private readonly controller: AgentLifecycleController,
    private readonly options: ToolUseLifecycleOptions,
  ) {}

  appendFollowUp(text: string): void {
    if (this.followUpResolver) {
      this.followUpResolver(text);
      this.followUpResolver = null;
    } else {
      this.followUpQueue.push(text);
    }

    if (this.persistenceLock) {
      // Flag to ensure the snapshot is cleaned up on the next cycle
      this.hasPersistedSnapshot = true;
    }
  }

  hasQueuedFollowUp(): boolean {
    return this.followUpQueue.length > 0;
  }

  async waitForFollowUp(): Promise<string | null> {
    if (this.followUpQueue.length > 0) {
      return this.followUpQueue.shift()!;
    }

    if (this.controller.isInterruptionRequested()) {
      return null;
    }

    return new Promise<string | null>((resolve) => {
      this.followUpResolver = resolve;
    });
  }

  async enterWaitingState(): Promise<void> {
    if (this.followUpQueue.length > 0) {
      return;
    }

    const executionId = this.options.getExecutionId();
    const toolState = this.options.getToolState();

    if (
      toolState &&
      executionId &&
      ToolUseSessionManager.isPersistenceEnabled()
    ) {
      this.persistenceLock = true;

      try {
        if (this.followUpQueue.length === 0) {
          const { agentName, modelName } = this.options.getAgentIdentifier();
          await ToolUseSessionManager.saveSnapshot({
            executionId,
            streamId: this.controller.getStreamId(),
            agentName,
            model: modelName,
            session: this.options.getSessionDescriptor(),
            messages: this.options.getMessages(),
            toolState,
          });

          if (this.followUpQueue.length > 0) {
            await ToolUseSessionManager.deleteSnapshot(executionId);
            this.hasPersistedSnapshot = false;
          } else {
            this.hasPersistedSnapshot = true;
          }
        }
      } finally {
        this.persistenceLock = false;
      }
    }

    bus.emit('updateStreamStatus', {
      stream: this.controller.getStreamId(),
      status: 'waiting',
    });
  }

  async clearPersistedSnapshot(): Promise<void> {
    if (!this.hasPersistedSnapshot) {
      return;
    }

    const executionId = this.options.getExecutionId();
    if (!executionId) {
      this.hasPersistedSnapshot = false;
      return;
    }

    try {
      await ToolUseSessionManager.deleteSnapshot(executionId);
    } finally {
      this.hasPersistedSnapshot = false;
    }
  }

  async markRunning(): Promise<void> {
    bus.emit('updateStreamStatus', {
      stream: this.controller.getStreamId(),
      status: 'running',
    });
  }

  resumeFromSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.resumeSnapshot = snapshot;
    this.hasPersistedSnapshot = true;
  }

  consumeResumeSnapshot(): ToolUseSessionSnapshot | null {
    const snapshot = this.resumeSnapshot;
    this.resumeSnapshot = null;
    return snapshot;
  }

  cancelPendingFollowUpWait(): void {
    if (this.followUpResolver) {
      this.followUpResolver(null);
      this.followUpResolver = null;
    }
  }

  reset(): void {
    this.cancelPendingFollowUpWait();
    this.followUpQueue = [];
    this.resumeSnapshot = null;
    this.hasPersistedSnapshot = false;
    this.persistenceLock = false;
  }
}

export class AgentLifecycleController {
  private readonly logger: AgentLogger;
  private readonly runLabel: string;
  private readonly streamId: StreamTabId;
  private readonly register?: (streamId: StreamTabId) => void;
  private readonly unregister?: (streamId: StreamTabId) => void;

  private runGroupId?: string;
  private lastRunGroupId?: string;
  private abortController: AbortController | null = null;
  private interrupted = false;

  private toolUseLifecycle?: ToolUseLifecycle;

  constructor(options: AgentLifecycleControllerOptions) {
    this.logger = options.logger;
    this.runLabel = options.runLabel;
    this.streamId = options.streamId;
    this.register = options.onRegister;
    this.unregister = options.onUnregister;
  }

  public getStreamId(): StreamTabId {
    return this.streamId;
  }

  public getCurrentRunGroupId(): string | undefined {
    return this.runGroupId;
  }

  public getLastRunGroupId(): string | undefined {
    return this.lastRunGroupId;
  }

  public registerRunningAgent(): void {
    this.register?.(this.streamId);
  }

  public configureToolUseLifecycle(
    options: ToolUseLifecycleOptions,
  ): ToolUseLifecycleHooks {
    this.toolUseLifecycle = new ToolUseLifecycle(this, options);
    return this.toolUseLifecycle;
  }

  public getToolUseLifecycle(): ToolUseLifecycleHooks | undefined {
    return this.toolUseLifecycle;
  }

  public createHooks(
    hooks: {
      init(runGroupId: string | undefined): Promise<void>;
      initializeClient(): Promise<void>;
      cleanup?(): Promise<void> | void;
    },
    overrides?: AgentRunHookOverrides,
  ): AgentLifecycleHooks {
    const baseHooks: AgentLifecycleHooks = {
      start: overrides?.start ?? (() => this.startRunGroup()),
      init: overrides?.init ?? hooks.init,
      initializeClient: overrides?.initializeClient ?? hooks.initializeClient,
      end: overrides?.end ?? ((status) => this.endRunGroup(status)),
      cleanup: overrides?.cleanup ?? (() => this.cleanup(hooks.cleanup)),
      requestInterruption: () => this.requestInterruption(),
      isInterruptionRequested: () => this.interrupted,
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (controller) => this.setAbortController(controller),
    };

    return baseHooks;
  }

  public isInterruptionRequested(): boolean {
    return this.interrupted;
  }

  private async startRunGroup(parentGroupId?: string): Promise<string> {
    const groupId = await this.logger.startGroup(
      this.runLabel,
      undefined,
      parentGroupId,
    );
    this.runGroupId = groupId;
    this.lastRunGroupId = groupId;
    this.interrupted = false;
    return groupId;
  }

  private endRunGroup(status: 'stopped' | 'error'): void {
    if (this.runGroupId) {
      this.lastRunGroupId = this.runGroupId;
      this.logger.endGroup(this.runGroupId, status);
      this.runGroupId = undefined;
    }
  }

  private async cleanup(cleanup?: () => Promise<void> | void): Promise<void> {
    try {
      if (cleanup) {
        await cleanup();
      }
    } finally {
      this.toolUseLifecycle?.reset();
      this.abortController = null;
      this.interrupted = false;
      this.unregister?.(this.streamId);
    }
  }

  public checkInterruption(): boolean {
    if (this.interrupted) {
      this.logger.info(
        'Stopping due to user interruption',
        undefined,
        MESSAGE_TYPES.PROGRESS_STATUS,
      );
      return true;
    }
    return false;
  }

  public setAbortController(controller: AbortController | null): void {
    this.abortController = controller;
  }

  public requestInterruption(): void {
    this.interrupted = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.toolUseLifecycle?.cancelPendingFollowUpWait();
  }
}
