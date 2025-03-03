// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import { AgentConfig } from '../agent/AgentConfig';
import { TaskState } from '../logger/TaskState';

/**
 * Converts an AgentConfig object to a TaskState object
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  return {
    // Basic task info
    agent: config.agent,
    model: config.model,
    instruction: config.instruction || '',

    // File selections
    inputFile: config.inputFile || '',
    referenceFile: config.referenceFile || '',
    auxiliaryFile: config.auxiliaryFile || '',
    figureFile: config.figureFile || '',
    outputNameOverride: config.outputNameOverride || '',

    // Multiple file selections
    multipleInputFiles: config.inputFiles || [],
    multipleReferenceFiles: config.referenceFiles || [],
    multipleAuxiliaryFiles: config.auxiliaryFiles || [],
    multipleFigureFiles: config.figureFiles || [],
    multipleOutputFiles: config.outputFiles || [],

    // Multiple file selection visibility
    multipleInputFilesVisible:
      Array.isArray(config.inputFiles) && config.inputFiles.length > 0,
    multipleReferenceFilesVisible:
      Array.isArray(config.referenceFiles) && config.referenceFiles.length > 0,
    multipleAuxiliaryFilesVisible:
      Array.isArray(config.auxiliaryFiles) && config.auxiliaryFiles.length > 0,
    multipleFigureFilesVisible:
      Array.isArray(config.figureFiles) && config.figureFiles.length > 0,
    multipleOutputFilesVisible:
      Array.isArray(config.outputFiles) && config.outputFiles.length > 0,

    // Auto extract settings
    autoExtractFigure: config.toolConfig?.autoExtractFigure || false,
    autoExtractTikzFigure: config.toolConfig?.autoExtractTikzFigure || false,

    // Tool config settings
    attachTeXCount: config.toolConfig?.attachTeXCount || false,
    usePrefillFromInput: config.toolConfig?.usePrefillFromInput || false,
    printInputPrompt: config.toolConfig?.printInputPrompt || false,
    reflect: config.toolConfig?.reflect || false,

    // Output name override visibility
    outputNameOverrideVisible: !!config.outputNameOverride,
  };
}

/**
 * Converts a generic object to a TaskState object
 * This is useful when receiving serialized data from the UI
 *
 * @param obj The object to convert
 * @returns A TaskState representing the same configuration
 */
export function objectToTaskState(obj: Record<string, any>): TaskState {
  return {
    // Basic task info
    agent: obj.agent || 'correct',
    model: obj.model || '',
    instruction: obj.instruction || '',

    // File selections
    inputFile: obj.inputFile || '',
    referenceFile: obj.referenceFile || '',
    auxiliaryFile: obj.auxiliaryFile || '',
    figureFile: obj.figureFile || '',
    outputNameOverride: obj.outputNameOverride || '',

    // Multiple file selections
    multipleInputFiles: obj.multipleInputFiles || [],
    multipleReferenceFiles: obj.multipleReferenceFiles || [],
    multipleAuxiliaryFiles: obj.multipleAuxiliaryFiles || [],
    multipleFigureFiles: obj.multipleFigureFiles || [],
    multipleOutputFiles: obj.multipleOutputFiles || [],

    // Multiple file selection visibility
    multipleInputFilesVisible: obj.multipleInputFilesVisible || false,
    multipleReferenceFilesVisible: obj.multipleReferenceFilesVisible || false,
    multipleAuxiliaryFilesVisible: obj.multipleAuxiliaryFilesVisible || false,
    multipleFigureFilesVisible: obj.multipleFigureFilesVisible || false,
    multipleOutputFilesVisible: obj.multipleOutputFilesVisible || false,

    // Auto extract settings
    autoExtractFigure:
      obj.autoExtractFigure || obj.toolConfig?.autoExtractFigure || false,
    autoExtractTikzFigure:
      obj.autoExtractTikzFigure ||
      obj.toolConfig?.autoExtractTikzFigure ||
      false,

    // Tool config settings
    attachTeXCount:
      obj.attachTeXCount || obj.toolConfig?.attachTeXCount || false,
    usePrefillFromInput:
      obj.usePrefillFromInput || obj.toolConfig?.usePrefillFromInput || false,
    printInputPrompt:
      obj.printInputPrompt || obj.toolConfig?.printInputPrompt || false,
    reflect: obj.reflect || obj.toolConfig?.reflect || false,

    // Output name override visibility
    outputNameOverrideVisible:
      obj.outputNameOverrideVisible || !!obj.outputNameOverride || false,
  };
}

/**
 * Converts a TaskState object to an AgentConfig object
 *
 * @param taskState The TaskState to convert
 * @returns An AgentConfig representing the same configuration
 */
export function taskStateToAgentConfig(taskState: TaskState): AgentConfig {
  return {
    // Basic task info
    agent: taskState.agent,
    model: taskState.model,
    instruction: taskState.instruction,

    // File selections
    inputFile: taskState.inputFile,
    referenceFile: taskState.referenceFile || null,
    auxiliaryFile: taskState.auxiliaryFile || null,
    figureFile: taskState.figureFile || null,
    outputNameOverride: taskState.outputNameOverride || null,

    // Multiple file selections
    inputFiles: taskState.multipleInputFilesVisible
      ? taskState.multipleInputFiles
      : null,
    referenceFiles: taskState.multipleReferenceFilesVisible
      ? taskState.multipleReferenceFiles
      : null,
    auxiliaryFiles: taskState.multipleAuxiliaryFilesVisible
      ? taskState.multipleAuxiliaryFiles
      : null,
    figureFiles: taskState.multipleFigureFilesVisible
      ? taskState.multipleFigureFiles
      : null,
    outputFiles: taskState.multipleOutputFilesVisible
      ? taskState.multipleOutputFiles
      : null,

    // Edited file (not part of TaskState)
    editedFile: null,

    // Tool configuration
    toolConfig: {
      autoExtractFigure: taskState.autoExtractFigure,
      autoExtractTikzFigure: taskState.autoExtractTikzFigure,
      attachTeXCount: taskState.attachTeXCount,
      usePrefillFromInput: taskState.usePrefillFromInput,
      printInputPrompt: taskState.printInputPrompt,
      reflect: taskState.reflect,
    },
  };
}
