import type { StageHandle } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { RUN_OUTCOME, type StreamTabId } from '@shared/schemas';
import type { RunTrace } from '@transcript';

const logger = createChannelTrace('AgentLaunchResources');

type DisposableModelHandler = {
  dispose(): void;
};

/** Owns partially assembled launch resources until the runtime accepts them. */
export class AgentLaunchResources {
  private modelHandler?: DisposableModelHandler;
  private runTrace?: RunTrace;
  private parentStage?: StageHandle;
  private activated?: { streamId: StreamTabId; runTrace: RunTrace };

  ownModelHandler<T extends DisposableModelHandler>(modelHandler: T): T {
    this.modelHandler = modelHandler;
    return modelHandler;
  }

  ownRunTrace(rawRunTrace: RunTrace, attach: () => () => void): RunTrace {
    const attachment: { detach?: () => void } = {};
    const runTrace: RunTrace = {
      trace: rawRunTrace.trace,
      handleStatus: rawRunTrace.handleStatus,
      dispose: () => {
        try {
          attachment.detach?.();
        } finally {
          rawRunTrace.dispose();
        }
      },
    };
    this.runTrace = runTrace;
    attachment.detach = attach();
    return runTrace;
  }

  ownParentStage(parentStage: StageHandle): StageHandle {
    this.parentStage = parentStage;
    return parentStage;
  }

  markActivated(streamId: StreamTabId, runTrace: RunTrace): void {
    this.activated = { streamId, runTrace };
  }

  transfer(): void {
    this.clear();
  }

  fail(
    compensate: (
      activated: { streamId: StreamTabId; runTrace: RunTrace } | undefined,
    ) => void,
  ): void {
    const { modelHandler, runTrace, parentStage, activated } = this;
    this.clear();

    this.runCleanup(runTrace, 'end failed launch stage', () => {
      parentStage?.end(RUN_OUTCOME.FAILED);
    });
    this.runCleanup(runTrace, 'dispose failed launch model handler', () => {
      modelHandler?.dispose();
    });
    this.runCleanup(runTrace, 'compensate failed launch activation', () => {
      compensate(activated);
    });
    this.runCleanup(undefined, 'dispose failed launch trace', () => {
      runTrace?.dispose();
    });
  }

  private clear(): void {
    this.modelHandler = undefined;
    this.runTrace = undefined;
    this.parentStage = undefined;
    this.activated = undefined;
  }

  private runCleanup(
    runTrace: RunTrace | undefined,
    operation: string,
    cleanup: () => void,
  ): void {
    try {
      cleanup();
    } catch (error) {
      (runTrace?.trace ?? logger).warn(`Failed to ${operation}`, {
        data: { error },
      });
    }
  }
}
