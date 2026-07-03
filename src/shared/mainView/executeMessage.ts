// Local imports - shared schemas
import { MULTIPLE_DOCUMENT_FILE_TYPES } from '../schemas/fileTypes';
import type { ToolConfigSchema } from '../schemas/toolConfig';
import type {
  CheckboxValues,
  MultiFiles,
  SessionType,
  SingleFiles,
} from '../schemas/mainView/state';

// Third-party imports
import type { z } from 'zod';

/**
 * File-selection fields sent from the main view's file pickers: the
 * multi-file lists (input/context/media/output), their "active" UI toggles,
 * and the single base/edited-file slots used by diff-oriented flows.
 */
export type MainViewExecuteFiles = {
  readonly inputFiles?: string[];
  readonly contextFiles?: string[];
  readonly mediaFiles?: (string | null)[];
  readonly outputFiles?: string[];
  readonly editedFile?: string;
  readonly editedFiles?: string[];
  readonly baseFile?: string;
  readonly inputFilesActive?: boolean;
  readonly contextFilesActive?: boolean;
  readonly mediaFilesActive?: boolean;
  readonly outputFilesActive?: boolean;
};

/** Session/run metadata that rides along with the execution request. */
export type MainViewExecuteSession = {
  readonly workingDirectory?: string | null;
  readonly cliOutputFile?: string | null;
  readonly cliMultiAgentPresetId?: string | null;
};

/**
 * Message shape from the main view for agent execution. File selection,
 * session metadata, and tool config are grouped into their own sub-objects
 * (mirroring how `prepareMainViewExecutionRequest` consumes them) instead of
 * one flat 26-field bag.
 *
 * Keep this aligned with prepareMainViewExecutionRequest. Agent-owned fields
 * such as agentCategory are derived there, not sent by the UI.
 */
export type MainViewExecuteMessage = {
  readonly agent?: string;
  readonly model?: string;
  readonly instruction?: string;
  readonly displayInstruction?: string | null;
  /** UI toggle indicating tool-use vs workflow agent. */
  readonly isToolUseAgent?: boolean;
  readonly memories?: string[];
  readonly files?: MainViewExecuteFiles;
  readonly session?: MainViewExecuteSession;
  readonly toolConfig?: z.input<typeof ToolConfigSchema>;
};

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
    files: {
      editedFile: state.singleFiles.editedFile,
      baseFile: state.singleFiles.baseFile,
      ...buildMainViewMultipleFileSelections(state.multiFiles),
    },
    toolConfig: state.checkboxValues,
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
    selections[`${listId}Active`] = files.length > 0;
  }
  return selections;
}
