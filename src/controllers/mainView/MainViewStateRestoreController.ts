// Local imports - agent registry
import { resolveAgentKey } from '@agent/index';

// Local imports - task state
import {
  isToolUseTaskState,
  isWorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';

// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';

/** Convert a TaskState payload into a full main view state snapshot. */
export function buildMainViewState(
  taskState: TaskState,
): MainViewPersistedState {
  const { agentConfig } = taskState;
  const isToolUse = isToolUseTaskState(taskState);
  const isWorkflow = isWorkflowTaskState(taskState);
  const activeFiles = isWorkflow ? taskState.activeFiles : undefined;
  const toolConfig = agentConfig.toolConfig ?? {};

  // Resolve agent name to full key (e.g., "criticize" -> "builtIn:criticize").
  // This ensures the frontend receives the exact key used in dropdown options.
  // Pass isToolUse to prefer builtInToolUse source for tool-use sessions,
  // preventing workflow agents from shadowing tool-use agents with same name.
  const resolvedAgent = resolveAgentKey(agentConfig.agent, isToolUse);

  // Build partial state from agentConfig and toolConfig, then parse with schema
  // to apply prefault defaults for any missing fields.
  // Note: UIFileFieldsSchema uses catch('') for nullable fields from AgentConfig.
  return MainViewPersistedStateSchema.parse({
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? undefined : resolvedAgent,
    toolUseAgent: isToolUse ? resolvedAgent : undefined,
    model: agentConfig.model,
    instruction: agentConfig.instruction,
    editedFile: agentConfig.editedFile,
    inputFiles: agentConfig.inputFiles,
    contextFiles: agentConfig.contextFiles,
    mediaFiles: agentConfig.mediaFiles,
    outputFiles: agentConfig.outputFiles,
    inputFilesVisible: activeFiles?.input,
    contextFilesVisible: activeFiles?.context,
    mediaFilesVisible: activeFiles?.media,
    outputFilesVisible: activeFiles?.output,
    outputFilesActive: activeFiles?.output,
    autoExtractFigure: toolConfig.autoExtractFigure,
    autoExtractTikzFigure: toolConfig.autoExtractTikzFigure,
    autoCompileInputPdf: toolConfig.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount,
  });
}
