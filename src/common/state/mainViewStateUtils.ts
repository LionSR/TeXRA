// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';

// Local imports - task state
import {
  isToolUseTaskState,
  isWorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';

/** Convert a TaskState payload into a full main view state snapshot. */
export function buildMainViewState(
  taskState: TaskState,
): MainViewPersistedState {
  const { agentConfig } = taskState;
  const isToolUse = isToolUseTaskState(taskState);
  const isWorkflow = isWorkflowTaskState(taskState);
  const activeFiles = isWorkflow ? taskState.activeFiles : undefined;
  const toolConfig = agentConfig.toolConfig ?? {};

  // Build partial state from agentConfig and toolConfig, then parse with schema
  // to apply prefault defaults for any missing fields.
  // Note: UIFileFieldsSchema uses catch('') for nullable fields from AgentConfig.
  return MainViewPersistedStateSchema.parse({
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? undefined : agentConfig.agent,
    toolUseAgent: isToolUse ? agentConfig.agent : undefined,
    model: agentConfig.model,
    instruction: agentConfig.instruction,
    inputFile: agentConfig.inputFile,
    referenceFile: agentConfig.referenceFile,
    auxiliaryFile: agentConfig.auxiliaryFile,
    mediaFile: agentConfig.mediaFile,
    editedFile: agentConfig.editedFile,
    inputFiles: agentConfig.inputFiles,
    referenceFiles: agentConfig.referenceFiles,
    auxiliaryFiles: agentConfig.auxiliaryFiles,
    mediaFiles: agentConfig.mediaFiles,
    outputFiles: agentConfig.outputFiles,
    inputFilesVisible: activeFiles?.input,
    referenceFilesVisible: activeFiles?.reference,
    auxiliaryFilesVisible: activeFiles?.auxiliary,
    mediaFilesVisible: activeFiles?.media,
    outputFilesVisible: activeFiles?.output,
    outputFilesActive: activeFiles?.output,
    autoExtractFigure: toolConfig.autoExtractFigure,
    autoExtractTikzFigure: toolConfig.autoExtractTikzFigure,
    autoCompileInputPdf: toolConfig.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount,
    attachDiagnostics: toolConfig.attachDiagnostics,
    agent: agentConfig.agent,
    isToolUseAgent: isToolUse,
  });
}
