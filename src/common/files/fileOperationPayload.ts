// Local imports - logger state
import type { WorkflowTaskState } from '@logger/TaskState';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - utils
import { isNonEmptyString } from '@utils/core';

export type FileOperation = 'pack' | 'clean';

export interface MainViewFileOperationInput {
  inputFile?: string;
  agent?: string;
  model?: string;
  outputFiles?: string[];
}

export interface ProgressViewFileOperationInput {
  taskState: WorkflowTaskState;
  streamId: StreamTabId;
  generatedPaths: string[];
}

export type FileOperationInput =
  | { kind: 'mainView'; data: MainViewFileOperationInput }
  | { kind: 'progressView'; data: ProgressViewFileOperationInput };

export interface FileOperationPayload {
  inputFile?: string;
  agent?: string;
  model?: string;
  outputFiles: string[];
  useMultipleOutputs: boolean;
  streamId?: StreamTabId;
  skipProgressViewClear?: boolean;
}

export function buildFileOperationPayload(
  input: FileOperationInput,
  _operation: FileOperation,
): FileOperationPayload {
  if (input.kind === 'mainView') {
    const outputFiles = input.data.outputFiles ?? [];
    return {
      inputFile: input.data.inputFile,
      agent: input.data.agent,
      model: input.data.model,
      outputFiles,
      useMultipleOutputs: outputFiles.length > 1,
    };
  }

  const { taskState, streamId, generatedPaths } = input.data;
  const declaredOutputs = taskState.agentConfig.outputFiles ?? [];
  const allFiles = [
    ...(Array.isArray(declaredOutputs) ? declaredOutputs : []),
    ...generatedPaths,
  ].filter(isNonEmptyString);
  const outputFilesArray = [...new Set(allFiles)];

  const useMultipleOutputs =
    taskState.agentConfig.useMultipleOutputs ??
    taskState.activeFiles.output ??
    outputFilesArray.length > 1;

  return {
    streamId,
    agent: taskState.agentConfig.agent,
    model: taskState.agentConfig.model,
    inputFile: taskState.agentConfig.inputFile,
    outputFiles: useMultipleOutputs ? outputFilesArray : [],
    useMultipleOutputs,
    skipProgressViewClear: true,
  };
}
