// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas/mainViewState';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';

// Local imports - logger
import { type TaskState, isWorkflowTaskState } from '@logger/TaskState';

const DEFAULT_MAIN_VIEW_STATE = MainViewPersistedStateSchema.parse({});

/**
 * Build MainView persisted state from a TaskState payload.
 */
export function buildMainViewStateFromTaskState(
  taskState: TaskState,
): MainViewPersistedState {
  const { agentConfig } = taskState;
  const isToolUse = agentConfig.agentCategory === AgentCategory.ToolUse;
  const activeFiles = isWorkflowTaskState(taskState)
    ? taskState.activeFiles
    : {
        input: false,
        reference: false,
        auxiliary: false,
        media: false,
        output: false,
      };
  const toolConfig = agentConfig.toolConfig ?? {};
  const inputFiles = agentConfig.inputFiles ?? [];
  const referenceFiles = agentConfig.referenceFiles ?? [];
  const auxiliaryFiles = agentConfig.auxiliaryFiles ?? [];
  const mediaFiles = agentConfig.mediaFiles ?? [];
  const outputFiles = agentConfig.outputFiles ?? [];
  const hasInputFiles = inputFiles.length > 0;
  const hasReferenceFiles = referenceFiles.length > 0;
  const hasAuxiliaryFiles = auxiliaryFiles.length > 0;
  const hasMediaFiles = mediaFiles.length > 0;
  const hasOutputFiles = outputFiles.length > 0;

  return {
    ...DEFAULT_MAIN_VIEW_STATE,
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? '' : (agentConfig.agent ?? ''),
    toolUseAgent: isToolUse ? (agentConfig.agent ?? '') : '',
    model: agentConfig.model ?? '',
    instruction: agentConfig.instruction ?? '',
    inputFile: agentConfig.inputFile ?? '',
    referenceFile: agentConfig.referenceFile ?? '',
    auxiliaryFile: agentConfig.auxiliaryFile ?? '',
    mediaFile: agentConfig.mediaFile ?? '',
    editedFile: agentConfig.editedFile ?? '',
    inputFiles,
    referenceFiles,
    auxiliaryFiles,
    mediaFiles,
    outputFiles,
    inputFilesVisible: Boolean(activeFiles.input) || hasInputFiles,
    referenceFilesVisible: Boolean(activeFiles.reference) || hasReferenceFiles,
    auxiliaryFilesVisible: Boolean(activeFiles.auxiliary) || hasAuxiliaryFiles,
    mediaFilesVisible: Boolean(activeFiles.media) || hasMediaFiles,
    outputFilesVisible: Boolean(activeFiles.output) || hasOutputFiles,
    outputFilesActive:
      Boolean(activeFiles.output) ||
      Boolean(
        (agentConfig as { useMultipleOutputs?: boolean }).useMultipleOutputs,
      ) ||
      hasOutputFiles,
    autoExtractFigure: Boolean(toolConfig.autoExtractFigure),
    autoExtractTikzFigure: Boolean(toolConfig.autoExtractTikzFigure),
    autoCompileInputPdf: Boolean(toolConfig.autoCompileInputPdf),
    attachTeXCount: Boolean(toolConfig.attachTeXCount),
    attachDiagnostics: Boolean(toolConfig.attachDiagnostics),
    agent: agentConfig.agent ?? '',
    isToolUseAgent: isToolUse,
  };
}
