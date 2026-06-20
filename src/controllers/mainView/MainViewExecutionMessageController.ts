// Third-party imports

// Local imports - agent
import type { AgentConfigInput } from '@agent/core/definition/AgentConfig';

// Local imports - shared schemas
import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type CheckboxValues,
  type MultiFiles,
  type SessionType,
  type SingleFiles,
} from '@shared/schemas';
import type { ToolConfigSchema } from '@shared/schemas/toolConfig';
import type { z } from 'zod';

/**
 * Message shape from the main view for agent execution.
 * ToolConfig fields are sent flat from the UI form.
 */
export type MainViewExecuteMessage = Omit<AgentConfigInput, 'mediaFiles'> & {
  /** UI toggle indicating tool-use vs workflow agent. */
  isToolUseAgent?: boolean;
  /** File used as the base/reference for diff-oriented flows. */
  baseFile?: string;
  /** Media files may contain nulls from UI and are filtered during processing. */
  mediaFiles?: (string | null)[];
  inputFilesActive?: boolean;
  contextFilesActive?: boolean;
  mediaFilesActive?: boolean;
  outputFilesActive?: boolean;
} & z.input<typeof ToolConfigSchema>;

export interface MainViewExecutionFormState {
  readonly sessionType: SessionType;
  readonly workflowAgent: string;
  readonly toolUseAgent: string;
  readonly model: string;
  readonly instruction: string;
  readonly singleFiles: SingleFiles;
  readonly multiFiles: MultiFiles;
  readonly checkboxValues: CheckboxValues;
}

type MainViewMultipleFileSelections = Record<string, string[] | boolean>;

export function buildMainViewExecuteMessage(
  state: MainViewExecutionFormState,
): MainViewExecuteMessage {
  const isToolUseAgent = state.sessionType === 'toolUse';
  return {
    agent: isToolUseAgent ? state.toolUseAgent : state.workflowAgent,
    model: state.model,
    instruction: state.instruction,
    isToolUseAgent,
    editedFile: state.singleFiles.editedFile,
    baseFile: state.singleFiles.baseFile,
    ...buildMainViewMultipleFileSelections(state.multiFiles),
    ...state.checkboxValues,
  };
}

function buildMainViewMultipleFileSelections(
  multiFiles: MultiFiles,
): MainViewMultipleFileSelections {
  const selections: MainViewMultipleFileSelections = {};
  for (const type of MULTIPLE_DOCUMENT_FILE_TYPES) {
    const listId = `${type}Files` as keyof MultiFiles;
    const files = type === 'output' ? [] : (multiFiles[listId] ?? []);
    selections[listId] = files;
    selections[`${listId}Active`] = type !== 'output' && files.length > 0;
  }
  return selections;
}
