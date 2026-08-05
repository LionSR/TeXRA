import { AgentCategory, type ByCategory } from '../schemas/agent';
import type { MainViewExecuteMessage } from '../schemas/mainView/executeMessage';
import type {
  CheckboxValues,
  LaunchTarget,
  MultiFiles,
  SessionType,
  SingleFiles,
} from '../schemas/mainView/state';

export interface MainViewExecutionFormState {
  readonly sessionType: SessionType;
  readonly agent: ByCategory<string>;
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
    readonly workingDirectory?: string | undefined;
  };
}

/** Output files aren't user-selectable at execute time, so that list is always empty. */
export function buildMainViewExecuteMessage(
  state: MainViewExecutionFormState,
): MainViewExecuteMessage {
  const agentCategory =
    state.sessionType === 'toolUse'
      ? AgentCategory.ToolUse
      : AgentCategory.Workflow;
  const { inputFiles, contextFiles, mediaFiles } = state.multiFiles;
  return {
    agent: state.agent[state.sessionType],
    model: state.model,
    instruction: state.instruction,
    agentCategory,
    files: {
      editedFile: state.singleFiles.editedFile,
      baseFile: state.singleFiles.baseFile,
      inputFiles,
      inputFilesActive: inputFiles.length > 0,
      contextFiles,
      contextFilesActive: contextFiles.length > 0,
      mediaFiles,
      mediaFilesActive: mediaFiles.length > 0,
    },
    session: state.session,
    toolConfig: state.checkboxValues,
  };
}
