import { MULTIPLE_DOCUMENT_FILE_TYPES } from '../schemas/fileTypes';
import type { MainViewExecuteMessage } from '../schemas/mainView/executeMessage';
import type {
  CheckboxValues,
  MultiFiles,
  SessionType,
  SingleFiles,
} from '../schemas/mainView/state';

export type { MainViewExecuteMessage };

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
