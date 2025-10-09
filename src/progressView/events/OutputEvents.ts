// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';

// Local imports - events
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { isWorkflowTaskState } from '@logger/TaskState';

interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
}

export interface OutputEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

type FilesByRound<T> = { [key: number]: T[] };

const updateActiveStreamOutputs = (
  state: ProgressViewState,
  updater: WebviewUpdater,
  stream: string,
  files: FilesByRound<OutputFileInfo> | undefined,
  missing: FilesByRound<string> | undefined,
): void => {
  if (state.activeStream !== stream || !updater.isAvailable()) {
    return;
  }

  updater.updateFiles(stream, files ?? {});
  updater.updateMissingOutputs(stream, missing ?? {});
};

const registerOutputFileListeners = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): vscode.Disposable[] => {
  const addFiles = bus.on('addOutputFiles', ({ stream, filesByRound }) => {
    state.outputFiles.addFiles(stream, filesByRound);
    const files = state.outputFiles.getFiles(stream);
    updateActiveStreamOutputs(state, updater, stream, files, undefined);
  });

  const updateMissing = bus.on(
    'updateMissingOutputs',
    ({ stream, filesByRound }) => {
      state.outputFiles.updateMissingOutputs(stream, filesByRound);
      const missing = state.outputFiles.getMissingOutputs(stream);
      updateActiveStreamOutputs(state, updater, stream, undefined, missing);
    },
  );

  const clearMissing = bus.on('clearMissingOutputs', (stream) => {
    state.outputFiles.clearMissingOutputs(stream);
    updateActiveStreamOutputs(state, updater, stream, undefined, {});
  });

  const clearFiles = bus.on('clearOutputFiles', (stream) => {
    state.outputFiles.clearFiles(stream);
    updateActiveStreamOutputs(state, updater, stream, {}, undefined);
  });

  return [addFiles, updateMissing, clearMissing, clearFiles].map(
    (dispose) => new vscode.Disposable(dispose),
  );
};

const registerClearTaskOutput = (
  bus: ProgressEventBusLike,
  state: ProgressViewState,
): vscode.Disposable => {
  return new vscode.Disposable(
    bus.on('clearTaskOutput', (streamTabId: StreamTabId) => {
      const taskState = state.getTaskState(streamTabId);
      if (!taskState || !isWorkflowTaskState(taskState)) {
        return;
      }

      taskState.agentConfig.outputFiles = [];
      taskState.agentConfig.useMultipleOutputs = false;
      taskState.activeFiles.output = false;
      state.setTaskState(streamTabId, taskState);
    }),
  );
};

export function createOutputEvents(): OutputEventsModule {
  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      const disposables = registerOutputFileListeners(bus, state, updater);
      disposables.push(registerClearTaskOutput(bus, state));
      return disposables;
    },
  };
}
