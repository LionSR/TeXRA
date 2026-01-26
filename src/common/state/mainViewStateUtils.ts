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

/**
 * Convert a TaskState payload into a full main view state snapshot.
 */
export function buildMainViewState(
  taskState: TaskState,
): MainViewPersistedState {
  const defaults = MainViewPersistedStateSchema.parse({});
  const { agentConfig } = taskState;
  const isToolUse = isToolUseTaskState(taskState);
  const isWorkflow = isWorkflowTaskState(taskState);
  const activeFiles = isWorkflow ? taskState.activeFiles : undefined;
  const toolConfig = agentConfig.toolConfig ?? {};

  const nextState: MainViewPersistedState = {
    ...defaults,
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? defaults.workflowAgent : agentConfig.agent,
    toolUseAgent: isToolUse ? agentConfig.agent : defaults.toolUseAgent,
    model: agentConfig.model ?? defaults.model,
    instruction: agentConfig.instruction ?? defaults.instruction,
    inputFile: agentConfig.inputFile ?? defaults.inputFile,
    referenceFile: agentConfig.referenceFile ?? defaults.referenceFile,
    auxiliaryFile: agentConfig.auxiliaryFile ?? defaults.auxiliaryFile,
    mediaFile: agentConfig.mediaFile ?? defaults.mediaFile,
    editedFile: agentConfig.editedFile ?? defaults.editedFile,
    inputFiles: agentConfig.inputFiles ?? defaults.inputFiles,
    referenceFiles: agentConfig.referenceFiles ?? defaults.referenceFiles,
    auxiliaryFiles: agentConfig.auxiliaryFiles ?? defaults.auxiliaryFiles,
    mediaFiles: agentConfig.mediaFiles ?? defaults.mediaFiles,
    outputFiles: agentConfig.outputFiles ?? defaults.outputFiles,
    inputFilesVisible: activeFiles?.input ?? defaults.inputFilesVisible,
    referenceFilesVisible:
      activeFiles?.reference ?? defaults.referenceFilesVisible,
    auxiliaryFilesVisible:
      activeFiles?.auxiliary ?? defaults.auxiliaryFilesVisible,
    mediaFilesVisible: activeFiles?.media ?? defaults.mediaFilesVisible,
    outputFilesVisible: activeFiles?.output ?? defaults.outputFilesVisible,
    outputFilesActive: activeFiles?.output ?? defaults.outputFilesActive,
    autoExtractFigure:
      toolConfig.autoExtractFigure ?? defaults.autoExtractFigure,
    autoExtractTikzFigure:
      toolConfig.autoExtractTikzFigure ?? defaults.autoExtractTikzFigure,
    autoCompileInputPdf:
      toolConfig.autoCompileInputPdf ?? defaults.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount ?? defaults.attachTeXCount,
    attachDiagnostics:
      toolConfig.attachDiagnostics ?? defaults.attachDiagnostics,
    agent: agentConfig.agent ?? defaults.agent,
    isToolUseAgent: isToolUse,
  };

  return MainViewPersistedStateSchema.parse(nextState);
}
