// Local imports - shared schemas
import { MULTIPLE_DOCUMENT_FILE_TYPES } from '../fileTypes';
import type { ToolConfigSchema } from '../toolConfig';
import type {
  CheckboxValues,
  MultiFiles,
  SessionType,
  SingleFiles,
} from './state';

// Third-party imports
import type { z } from 'zod';

/**
 * Message shape from the main view for agent execution.
 * ToolConfig fields are sent flat from the UI form.
 */
type MainViewExecuteFiles = {
  readonly inputFiles?: string[];
  readonly contextFiles?: string[];
  readonly mediaFiles?: (string | null)[];
  readonly outputFiles?: string[];
  readonly editedFile?: string;
};

export type MainViewExecuteMessage = MainViewExecuteFiles & {
  readonly agent?: string;
  readonly model?: string;
  readonly instruction?: string;
  readonly displayInstruction?: string | null;
  /** UI toggle indicating tool-use vs workflow agent. */
  readonly isToolUseAgent?: boolean;
  /** File used as the base/reference for diff-oriented flows. */
  readonly baseFile?: string;
  readonly inputFilesActive?: boolean;
  readonly contextFilesActive?: boolean;
  readonly mediaFilesActive?: boolean;
  readonly outputFilesActive?: boolean;
  readonly editedFiles?: string[];
  readonly memories?: string[];
  readonly workingDirectory?: string | null;
  readonly cliOutputFile?: string | null;
  readonly cliMultiAgentPresetId?: string | null;
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
