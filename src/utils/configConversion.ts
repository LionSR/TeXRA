// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import { AgentConfig } from '../agent/AgentConfig';
import { TaskState } from '../logger/TaskState';
import { ToolConfig } from '../agent/ToolConfig';

import {
  FILE_TYPES,
  SINGLE_FILE_FIELDS,
  MULTIPLE_FILE_FIELDS,
  ACTIVE_FLAGS,
  AUTO_EXTRACT_FIELDS,
  TOOL_CONFIG_FIELDS,
} from './constants';

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

  // Add single file selections with defaults
  SINGLE_FILE_FIELDS.forEach((field) => {
    if (field !== 'outputFile') {
      // outputFile isn't part of the schema
      (taskState as any)[field] = (config as any)[field] || '';
    }
  });

  // Add multiple file selections with defaults
  MULTIPLE_FILE_FIELDS.forEach((field) => {
    (taskState as any)[field] = (config as any)[field] || [];
  });

  // Set active flags based on array content
  ACTIVE_FLAGS.forEach((flag) => {
    const filesField = flag.replace('Active', '');
    (taskState as any)[flag] =
      Array.isArray((config as any)[filesField]) &&
      (config as any)[filesField].length > 0;
  });

  // Add auto extract settings
  AUTO_EXTRACT_FIELDS.forEach((field) => {
    (taskState as any)[field] = config.toolConfig?.[field] || false;
  });

  // Add tool config settings
  TOOL_CONFIG_FIELDS.forEach((field) => {
    (taskState as any)[field] = config.toolConfig?.[field] || false;
  });

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

  // Add single file selections with defaults
  SINGLE_FILE_FIELDS.forEach((field) => {
    if (field !== 'outputFile') {
      // outputFile isn't part of the schema
      (taskState as any)[field] = obj[field] || '';
    }
  });

  // Add multiple file selections with defaults
  MULTIPLE_FILE_FIELDS.forEach((field) => {
    (taskState as any)[field] = obj[field] || [];
  });

  // Set active flags
  ACTIVE_FLAGS.forEach((flag) => {
    (taskState as any)[flag] = obj[flag] || false;
  });

  // Add auto extract settings - check both direct property and toolConfig
  AUTO_EXTRACT_FIELDS.forEach((field) => {
    (taskState as any)[field] = obj[field] || obj.toolConfig?.[field] || false;
  });

  // Add tool config settings - check both direct property and toolConfig
  TOOL_CONFIG_FIELDS.forEach((field) => {
    (taskState as any)[field] = obj[field] || obj.toolConfig?.[field] || false;
  });

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

  // Add single file selections with null defaults
  SINGLE_FILE_FIELDS.forEach((field) => {
    if (field !== 'outputFile') {
      // outputFile isn't part of the schema
      (agentConfig as any)[field] = (taskState as any)[field] || null;
    }
  });

  // Add multiple file selections, only if active
  MULTIPLE_FILE_FIELDS.forEach((field) => {
    const activeFlag = `${field}Active`;
    (agentConfig as any)[field] =
      (taskState as any)[activeFlag] && (taskState as any)[field]
        ? (taskState as any)[field]
        : null;
  });

  // Special case for outputNameOverride since it needs null rather than empty string
  agentConfig.outputNameOverride = taskState.outputNameOverride || null;

  // Add tool config settings
  const allConfigFields = [...AUTO_EXTRACT_FIELDS, ...TOOL_CONFIG_FIELDS];
  allConfigFields.forEach((field) => {
    (agentConfig.toolConfig as any)[field] = (taskState as any)[field];
  });

  return agentConfig as AgentConfig;
}
