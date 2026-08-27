import { type ByCategory } from '../schemas/agent';
import type { MainViewExecuteMessage } from '../schemas/mainView/executeMessage';
import type {
  CheckboxValues,
  LaunchTarget,
  MultiFiles,
  SessionType,
} from '../schemas/mainView/state';

export interface MainViewExecutionFormState {
  readonly sessionType: SessionType;
  readonly agent: ByCategory<string>;
  readonly model: string;
  readonly instruction: string;
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

export function buildMainViewExecuteMessage(
  state: MainViewExecutionFormState,
): MainViewExecuteMessage {
  // SessionType and AgentCategory share one value set (SessionTypeSchema
  // aliases AgentCategorySchema), so no vocabulary conversion is needed here.
  const { inputFiles, contextFiles, mediaFiles } = state.multiFiles;
  return {
    agent: state.agent[state.sessionType],
    model: state.model,
    instruction: state.instruction,
    agentCategory: state.sessionType,
    files: {
      inputFiles,
      contextFiles,
      mediaFiles,
    },
    session: state.session,
    toolConfig: state.checkboxValues,
  };
}
