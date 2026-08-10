// Third-party imports
import { vi } from 'vitest';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ProgressBackendOptions } from '@controllers/progressView/backend/ProgressBackend';
import {
  ProgressWorkflowActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '@controllers/progressView/ProgressWorkflowActionsController';
import type {
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';

export function createAgentConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini31p',
    inputFiles: ['input.tex'],
    outputFiles: ['declared.tex'],
    agentCategory: AgentCategory.Workflow,
    ...overrides,
  });
}

export function createWorkflowConfig(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): AgentConfig {
  return createAgentConfig({
    ...overrides,
    agentCategory: AgentCategory.Workflow,
  });
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
  runConfigs?: Map<StreamTabId, AgentConfig>;
  executionIds?: Map<StreamTabId, string>;
  outputs?: Map<StreamTabId, RoundIndexed<OutputFileInfo>>;
  knownWorkspaceOutputs?: Map<StreamTabId, Set<string>>;
}

export interface ProgressWorkflowActionsHarness {
  controller: ProgressWorkflowActionsController;
  metadataReads: StreamTabId[];
  diffs: WorkflowDiffRequest[];
  fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }>;
}

export function createProgressWorkflowActionsHarness(
  options: ProgressWorkflowActionsHarnessOptions = {},
): ProgressWorkflowActionsHarness {
  const metadataReads: StreamTabId[] = [];
  const diffs: WorkflowDiffRequest[] = [];
  const fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }> = [];

  return {
    controller: new ProgressWorkflowActionsController({
      state: {
        getRunMetadata: (stream) => {
          metadataReads.push(stream);
          return {
            config: options.runConfigs?.get(stream),
            executionId: options.executionIds?.get(stream),
          };
        },
        getOutputFiles: (stream) => options.outputs?.get(stream) ?? {},
        getKnownWorkspaceOutputPaths: (stream) =>
          new Set(options.knownWorkspaceOutputs?.get(stream) ?? []),
      },
      runDiff: async (request) => {
        diffs.push(request);
      },
      runFileOperation: async (operation, request) => {
        fileOperations.push({ operation, request });
      },
    }),
    metadataReads,
    diffs,
    fileOperations,
  };
}

/** Approval transport a backend can send through, recording retry/proposal UI. */
export function createApprovalOptions(): ProgressBackendOptions['approvals'] {
  return {
    canSend: () => true,
    overrides: {
      retry: { show: vi.fn(), dismiss: vi.fn() },
      proposal: { show: vi.fn(), dismiss: vi.fn() },
    },
  };
}

/** Host lifecycle callbacks as spies, so a suite asserts on what the backend asked its host to do. */
export function createLifecycleOptions(
  overrides: Partial<ProgressBackendOptions['lifecycle']> = {},
): ProgressBackendOptions['lifecycle'] {
  return {
    stopStream: vi.fn(),
    cleanupDeletedStream: vi.fn(),
    cleanupDeletedStreams: vi.fn(),
    rebuildRenderedStreams: vi.fn(),
    activateStream: vi.fn(),
    notifyDeletionRetained: vi.fn(),
    ...overrides,
  };
}
