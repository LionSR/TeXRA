// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionRequest } from '@agent/core/executionRequests';

// Local imports - logger
import type { TaskState, WorkflowTaskState } from '@logger/TaskState';

// Local imports - shared
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';

// Local imports - controllers
import {
  ProgressStreamLifecycleController,
  type ProgressStreamLifecycleState,
} from '../../controllers/progressView/ProgressStreamLifecycleController';
import {
  ProgressWorkflowActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '../../controllers/progressView/ProgressWorkflowActionsController';

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
    },
    clearAll: async () => {
      streams = [];
      activeStream = '';
    },
  };

  return {
    controller: new ProgressStreamLifecycleController({
      state,
      isStreamInFlight: (stream) => inFlightStreams.has(stream),
      getVisibleStreamIds: () =>
        options.visibleStreams ??
        streams.filter((stream) => stream !== 'hidden'),
      stopStream: async (stream) => recorder.record('stop', stream),
      clearRetryRequest: (stream) => recorder.record('clearRetry', stream),
      releaseFollowUpQueue: (stream) =>
        recorder.record('releaseFollowUp', stream),
      cleanupApprovalsForStream: (stream) =>
        recorder.record('cleanupApprovals', stream),
      cleanupAllApprovals: () => recorder.record('cleanupAllApprovals', 'all'),
      clearModelOutputBackups: (stream) =>
        recorder.record('clearBackups', stream ?? 'all'),
      clearWebviewStream: (stream) => recorder.record('clearWebview', stream),
      clearAllWebviewStreams: () => recorder.record('clearAllWebview', 'all'),
      deleteWebviewStream: (stream) => recorder.record('deleteWebview', stream),
      syncFullView: (options) => syncCalls.push(options),
      setActiveStream: async (stream) =>
        recorder.record('setActiveStream', stream),
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
    }) as AgentConfig & { agentCategory: AgentCategory.Workflow },
    activeFiles: {
      input: true,
      reference: false,
      auxiliary: false,
      media: false,
      output: true,
      ...activeFiles,
    },
  };
}

export function createOutputFile(
  absolutePath: string,
  relativePath = absolutePath,
): OutputFileInfo {
  return {
    source: 'input.tex',
    location: {
      kind: 'workspace',
      absolutePath,
      relativePath,
    },
    round: 1,
    lineage: null,
    diff: null,
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
