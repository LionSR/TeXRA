import type {
  MainViewExecuteFiles,
  MainViewExecuteMessage,
} from '../schemas/mainView/executeMessage';
import type {
  CheckboxValues,
  LaunchTarget,
  MultiFiles,
  SessionType,
  SingleFiles,
} from '../schemas/mainView/state';

export interface MainViewExecutionFormState {
  readonly sessionType: SessionType;
  readonly workflowAgent: string;
  readonly toolUseAgent: string;
  readonly model: string;
  readonly instruction: string;
  readonly singleFiles: SingleFiles;
  readonly multiFiles: MultiFiles;
  readonly checkboxValues: CheckboxValues;
  /**
   * Launch intent for the run. Team runs carry team identity only — hosts
   * resolve the roster from `teamId` at the execution boundary.
   */
  readonly session?: {
    readonly launchTarget: LaunchTarget;
    readonly teamId?: string | undefined;
  };
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
    session: state.session,
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
