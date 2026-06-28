import { MainViewAgentSelectionController } from '@controllers/mainView/MainViewAgentSelectionController';
import {
  isRuntimeToolUseTaskState,
  isRuntimeWorkflowTaskState,
  type RuntimeTaskState,
} from '@agent/runtime/executionRequests';

// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';

const agentSelectionController = new MainViewAgentSelectionController();

/** Convert a TaskState payload into a full main view state snapshot. */
export function buildMainViewState(
  taskState: RuntimeTaskState,
): MainViewPersistedState {
  const { agentConfig } = taskState;
  const isToolUse = isRuntimeToolUseTaskState(taskState);
  const isWorkflow = isRuntimeWorkflowTaskState(taskState);
  const toolConfig = agentConfig.toolConfig ?? {};

  const selection = agentSelectionController.getCategoryAgentSelection({
    agentIdentifier: agentConfig.agent,
    category: isToolUse ? 'toolUse' : 'workflow',
  });

  // Build partial state from agentConfig and toolConfig, then parse with schema
  // to apply prefault defaults for any missing fields.
  // Note: UIFileFieldsSchema uses catch('') for nullable fields from AgentConfig.
  return MainViewPersistedStateSchema.parse({
    sessionType: selection.sessionType,
    workflowAgent:
      selection.sessionType === 'workflow' ? selection.agentId : undefined,
    toolUseAgent:
      selection.sessionType === 'toolUse' ? selection.agentId : undefined,
    model: agentConfig.model,
    instruction: agentConfig.instruction,
    editedFile: agentConfig.editedFile,
    inputFiles: agentConfig.inputFiles,
    contextFiles: agentConfig.contextFiles,
    mediaFiles: agentConfig.mediaFiles,
    outputFiles: agentConfig.outputFiles,
    outputFilesActive: isWorkflow ? taskState.activeFiles?.output : undefined,
    autoExtractFigure: toolConfig.autoExtractFigure,
    autoExtractTikzFigure: toolConfig.autoExtractTikzFigure,
    autoCompileInputPdf: toolConfig.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount,
  });
}
