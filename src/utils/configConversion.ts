// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import { AgentConfig } from '../agent/AgentConfig';
import { TaskState } from '../logger/TaskState';
import { ToolConfig } from '../agent/ToolConfig';

import {
  SINGLE_FILE_FIELDS,
  MULTIPLE_FILE_FIELDS,
  ACTIVE_FLAGS,
  AUTO_EXTRACT_FIELDS,
  TOOL_CONFIG_FIELDS,
} from './constants';

function copyFields(
  dest: Record<string, any>,
  src: Record<string, any>,
  fields: readonly string[],
  defaultValue: any,
  { skipOutputFile = false } = {},
) {
  fields.forEach((field) => {
    if (skipOutputFile && field === 'outputFile') {
      return;
    }
    dest[field] = src[field] ?? defaultValue;
  });
}

function copyToolFlags(
  dest: Record<string, any>,
  src: Record<string, any>,
  defaultValue: any,
) {
  [...AUTO_EXTRACT_FIELDS, ...TOOL_CONFIG_FIELDS].forEach((field) => {
    dest[field] = src[field] ?? src.toolConfig?.[field] ?? defaultValue;
  });
}

function setActiveFlagsFromArrays(
  dest: Record<string, any>,
  src: Record<string, any>,
) {
  ACTIVE_FLAGS.forEach((flag) => {
    const filesField = flag.replace('Active', '');
    dest[flag] = Array.isArray(src[filesField]) && src[filesField].length > 0;
  });
}

function copyActiveFileLists(
  dest: Record<string, any>,
  src: Record<string, any>,
) {
  MULTIPLE_FILE_FIELDS.forEach((field) => {
    const activeFlag = `${field}Active`;
    dest[field] = src[activeFlag] && src[field] ? src[field] : null;
  });
}

/**
 * Converts an AgentConfig object to a TaskState object
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  // Initialize with required properties
  const taskState: Partial<TaskState> = {
    // Basic task info
    agent: config.agent,
    model: config.model,
    instruction: config.instruction || '',

    // Output name override visibility
    outputNameOverride: config.outputNameOverride || '',
    outputNameOverrideVisible: !!config.outputNameOverride,
  };

  // Add single and multi-file selections
  copyFields(taskState, config, SINGLE_FILE_FIELDS, '', {
    skipOutputFile: true,
  });
  copyFields(taskState, config, MULTIPLE_FILE_FIELDS, []);

  // Set active flags based on array content
  setActiveFlagsFromArrays(taskState, config);

  // Add tool config settings
  copyToolFlags(taskState, config, false);

  return taskState as TaskState;
}

/**
 * Converts a generic object to a TaskState object
 * This is useful when receiving serialized data from the UI
 *
 * @param obj The object to convert
 * @returns A TaskState representing the same configuration
 */
export function objectToTaskState(obj: Record<string, any>): TaskState {
  // Initialize with required properties
  const taskState: Partial<TaskState> = {
    // Basic task info
    agent: obj.agent || 'correct',
    model: obj.model || '',
    instruction: obj.instruction || '',

    // Output name override visibility
    outputNameOverride: obj.outputNameOverride || '',
    outputNameOverrideVisible:
      obj.outputNameOverrideVisible || !!obj.outputNameOverride || false,
  };

  // Add single and multi-file selections
  copyFields(taskState, obj, SINGLE_FILE_FIELDS, '', { skipOutputFile: true });
  copyFields(taskState, obj, MULTIPLE_FILE_FIELDS, []);

  // Set active flags
  copyFields(taskState, obj, ACTIVE_FLAGS, false);

  // Add tool config settings - check both direct property and toolConfig
  copyToolFlags(taskState, obj, false);

  return taskState as TaskState;
}

/**
 * Converts a TaskState object to an AgentConfig object
 *
 * @param taskState The TaskState to convert
 * @returns An AgentConfig representing the same configuration
 */
export function taskStateToAgentConfig(taskState: TaskState): AgentConfig {
  // Initialize with partial config
  const agentConfig: Partial<AgentConfig> = {
    // Basic task info
    agent: taskState.agent,
    model: taskState.model,
    instruction: taskState.instruction,

    // Edited file (not part of TaskState)
    editedFile: null,

    // Initialize tool config
    toolConfig: {} as ToolConfig,
  };

  // Add single and multi-file selections
  copyFields(agentConfig, taskState, SINGLE_FILE_FIELDS, null, {
    skipOutputFile: true,
  });
  copyActiveFileLists(agentConfig, taskState);

  // Special case for outputNameOverride since it needs null rather than empty string
  agentConfig.outputNameOverride = taskState.outputNameOverride || null;

  // Add tool config settings
  const allConfigFields = [...AUTO_EXTRACT_FIELDS, ...TOOL_CONFIG_FIELDS];
  allConfigFields.forEach((field) => {
    (agentConfig.toolConfig as any)[field] = (taskState as any)[field];
  });

  return agentConfig as AgentConfig;
}
