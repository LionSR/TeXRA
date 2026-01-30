// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

export interface FileOperationPayload {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  useMultipleOutputs: boolean;
  streamId?: StreamTabId;
  skipProgressViewClear?: boolean;
}

interface FileOperationInput {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  useMultipleOutputs?: boolean;
  streamId?: StreamTabId;
  skipProgressViewClear?: boolean;
}

export function buildFileOperationPayload(
  input: FileOperationInput,
): FileOperationPayload {
  const outputFiles = input.outputFiles ?? [];
  const useMultipleOutputs = input.useMultipleOutputs ?? outputFiles.length > 0;

  return {
    agent: input.agent,
    model: input.model,
    inputFile: input.inputFile,
    outputFiles: useMultipleOutputs ? outputFiles : [],
    useMultipleOutputs,
    streamId: input.streamId,
    skipProgressViewClear: input.skipProgressViewClear,
  };
}
