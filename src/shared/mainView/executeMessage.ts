import type {
  MainViewExecuteFiles,
  MainViewExecuteMessage,
} from '../schemas/mainView/executeMessage';
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

type MainViewMultipleFileSelections = Pick<
  MainViewExecuteFiles,
  | 'inputFiles'
  | 'inputFilesActive'
  | 'contextFiles'
  | 'contextFilesActive'
  | 'mediaFiles'
  | 'mediaFilesActive'
>;

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

/** Output files aren't user-selectable at execute time, so that list is always empty. */
function buildMainViewMultipleFileSelections(
  multiFiles: MultiFiles,
): MainViewMultipleFileSelections {
  return {
    inputFiles: multiFiles.inputFiles,
    inputFilesActive: multiFiles.inputFiles.length > 0,
    contextFiles: multiFiles.contextFiles,
    contextFilesActive: multiFiles.contextFiles.length > 0,
    mediaFiles: multiFiles.mediaFiles,
    mediaFilesActive: multiFiles.mediaFiles.length > 0,
  };
}
