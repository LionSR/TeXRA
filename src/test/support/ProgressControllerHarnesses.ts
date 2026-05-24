// Local imports - agent
import {
  ProgressStreamLifecycleController,
  type ProgressStreamLifecycleHost,
  type ProgressStreamLifecycleState,
} from '@controllers/progressView/ProgressStreamLifecycleController';
import {
  ProgressWorkflowActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '@controllers/progressView/ProgressWorkflowActionsController';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionRequest } from '@agent/core/executionRequests';

import type { TaskState, WorkflowTaskState } from '@agent/core/TaskState';

// Local imports - shared
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';

// Local imports - controllers

export class ControllerCallRecorder<T = unknown> {
  readonly calls = new Map<string, T[]>();

  record(name: string, payload: T): void {
    this.calls.set(name, [...(this.calls.get(name) ?? []), payload]);
  }
}

export interface ProgressStreamLifecycleHarnessOptions {
  streams?: StreamTabId[];
  activeStream?: StreamTabId | '';
  taskStateStreams?: StreamTabId[];
  inFlightStreams?: StreamTabId[];
  visibleStreams?: StreamTabId[];
}

export interface ProgressStreamLifecycleHarness {
  controller: ProgressStreamLifecycleController;
  recorder: ControllerCallRecorder<StreamTabId>;
  syncCalls: Array<{ forceRebuild: boolean }>;
  state: ProgressStreamLifecycleState;
  activeStream(): StreamTabId | '';
  streams(): StreamTabId[];
}

export function createProgressStreamLifecycleHarness(
  options: ProgressStreamLifecycleHarnessOptions = {},
): ProgressStreamLifecycleHarness {
  let streams = [...(options.streams ?? ['stream-a', 'stream-b'])];
  let activeStream = options.activeStream ?? streams[0] ?? '';
  const taskStateStreams = new Set(options.taskStateStreams ?? []);
  const inFlightStreams = new Set(options.inFlightStreams ?? []);
  const recorder = new ControllerCallRecorder<StreamTabId>();
  const syncCalls: Array<{ forceRebuild: boolean }> = [];
  const state: ProgressStreamLifecycleState = {
    getActiveStream: () => activeStream,
    setActiveStream: (stream) => {
      activeStream = stream;
    },
    hasStream: (stream) => streams.includes(stream),
    hasTaskState: (stream) => taskStateStreams.has(stream),
    getStreamIds: () => streams,
    pickValidActiveStream: (availableStreams) => availableStreams[0] ?? '',
    clearStream: async (stream) => {
      streams = streams.filter((candidate) => candidate !== stream);
      if (activeStream === stream) {
        activeStream = streams[0] ?? '';
      }
    },
    clearAll: async () => {
      streams = [];
      activeStream = '';
    },
  };
  const host: ProgressStreamLifecycleHost = {
    getVisibleStreamIds: () =>
      options.visibleStreams ?? streams.filter((stream) => stream !== 'hidden'),
    isStreamInFlight: (stream) => inFlightStreams.has(stream),
    stopStream: async (stream, stopOptions = {}) => {
      if (stopOptions.clearRetryRequest === true) {
        recorder.record('clearRetry', stream);
      }
      recorder.record('stop', stream);
    },
    cleanupDeletedStream: (stream) => {
      recorder.record('cleanupApprovals', stream);
      recorder.record('clearRetry', stream);
      recorder.record('releaseFollowUp', stream);
      recorder.record('clearBackups', stream);
      recorder.record('clearWebview', stream);
    },
    cleanupDeletedStreams: (streams) => {
      recorder.record('cleanupAllApprovals', 'all');
      for (const stream of streams) {
        recorder.record('clearRetry', stream);
        recorder.record('releaseFollowUp', stream);
      }
      recorder.record('clearBackups', 'all');
      recorder.record('clearAllWebview', 'all');
    },
    deleteRenderedStream: (stream) => recorder.record('deleteWebview', stream),
    rebuildRenderedStreams: (options) => syncCalls.push(options),
    activateStream: async (stream) =>
      recorder.record('setActiveStream', stream),
  };

  return {
    controller: new ProgressStreamLifecycleController({
      state,
      host,
    }),
    recorder,
    syncCalls,
    state,
    activeStream: () => activeStream,
    streams: () => streams,
  };
}

export function createAgentConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini31p',
    inputFile: 'input.tex',
    outputFiles: ['declared.tex'],
    agentCategory: AgentCategory.Workflow,
    ...overrides,
  });
}

export function createWorkflowTaskState(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
  activeFiles: Partial<WorkflowTaskState['activeFiles']> = {},
): WorkflowTaskState {
  return {
    agentConfig: createAgentConfig({
      ...overrides,
      agentCategory: AgentCategory.Workflow,
    }) as AgentConfig & { agentCategory: typeof AgentCategory.Workflow },
    activeFiles: {
      input: true,
      context: false,
      media: false,
      output: true,
      ...activeFiles,
    },
  };
}

type WorkspaceLocationOverrides = {
  kind?: 'workspace';
  absolutePath?: string;
  relativePath?: string;
};

type RunStorageLocationOverrides = {
  kind: 'runStorage';
  absolutePath?: string;
  relativePath?: string;
  executionId?: string;
};

type ExternalLocationOverrides = {
  kind: 'external';
  absolutePath?: string;
};

type OutputFileLocationOverrides =
  | WorkspaceLocationOverrides
  | RunStorageLocationOverrides
  | ExternalLocationOverrides;

export type OutputFileHarnessOptions = Partial<
  Omit<OutputFileInfo, 'location'>
> & {
  location?: OutputFileLocationOverrides;
};

function createOutputFileLocation(
  overrides: OutputFileLocationOverrides = {},
): OutputFileInfo['location'] {
  if (overrides.kind === 'external') {
    return {
      kind: 'external',
      absolutePath: overrides.absolutePath ?? '/external/generated.tex',
    };
  }

  if (overrides.kind === 'runStorage') {
    return {
      kind: 'runStorage',
      absolutePath: overrides.absolutePath ?? '/tmp/exec/answer.tex',
      relativePath: overrides.relativePath ?? 'answer.tex',
      executionId: overrides.executionId ?? 'exec-old',
    };
  }

  return {
    kind: 'workspace',
    absolutePath: overrides.absolutePath ?? '/workspace/generated.tex',
    relativePath: overrides.relativePath ?? 'generated.tex',
  };
}

export function createOutputFile(
  overrides: OutputFileHarnessOptions = {},
): OutputFileInfo {
  const { location, ...outputOverrides } = overrides;
  return {
    source: 'input.tex',
    location: createOutputFileLocation(location),
    round: 1,
    lineage: null,
    diff: null,
    ...outputOverrides,
  };
}

export interface ProgressWorkflowActionsHarnessOptions {
  taskStates?: Map<StreamTabId, TaskState>;
  executionIds?: Map<StreamTabId, string>;
  outputs?: Map<StreamTabId, Map<number, OutputFileInfo[]>>;
  knownWorkspaceOutputs?: Map<StreamTabId, Set<string>>;
}

export interface ProgressWorkflowActionsHarness {
  controller: ProgressWorkflowActionsController;
  executed: ExecutionRequest[];
  diffs: WorkflowDiffRequest[];
  fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }>;
}

export function createProgressWorkflowActionsHarness(
  options: ProgressWorkflowActionsHarnessOptions = {},
): ProgressWorkflowActionsHarness {
  const executed: ExecutionRequest[] = [];
  const diffs: WorkflowDiffRequest[] = [];
  const fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }> = [];

  return {
    controller: new ProgressWorkflowActionsController({
      state: {
        getTaskState: (stream) => options.taskStates?.get(stream),
        getExecutionId: (stream) => options.executionIds?.get(stream),
        getOutputFiles: (stream) => new Map(options.outputs?.get(stream) ?? []),
        getKnownWorkspaceOutputPaths: (stream) =>
          new Set(options.knownWorkspaceOutputs?.get(stream) ?? []),
      },
      executeAgent: async (request) => {
        executed.push(request);
      },
      runDiff: async (request) => {
        diffs.push(request);
      },
      runFileOperation: async (operation, request) => {
        fileOperations.push({ operation, request });
      },
    }),
    executed,
    diffs,
    fileOperations,
  };
}
