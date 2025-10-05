// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { TaskState, isWorkflowTaskState } from '@logger/TaskState';
import {
  AgentCategorySchema,
  deriveAgentCategory,
  type AgentCategory,
  type AgentType,
  type AgentSessionMetadata,
} from '@agent/core/AgentDataclass';

import { FILE_TYPES, type FileType } from './constants';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createActiveFilesFromArrays(
  src: Record<string, any>,
): Record<FileType, boolean> {
  const active: Record<FileType, boolean> = {} as Record<FileType, boolean>;
  FILE_TYPES.forEach((type) => {
    const filesField = `${type}Files`;
    const flagField = `${filesField}Active`;
    const useMultipleOutputs = Boolean(
      (src as { useMultipleOutputs?: boolean }).useMultipleOutputs,
    );
    const multipleFlag = type === 'output' && useMultipleOutputs;
    active[type] =
      (Array.isArray(src[filesField]) && src[filesField].length > 0) ||
      !!src[flagField] ||
      multipleFlag;
  });
  return active;
}

/**
 * Converts an AgentConfig object to a TaskState object
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(
  config: AgentConfig,
  metadata?: Partial<AgentSessionMetadata> | AgentType,
): TaskState {
  let providedType: AgentType | undefined;
  let providedCategory: AgentCategory | undefined;

  if (typeof metadata === 'object' && metadata !== null) {
    providedType = metadata.agentType;
    providedCategory = metadata.agentCategory;
  } else if (metadata !== undefined) {
    providedType = metadata;
  }

  const agentType = config.agentType ?? providedType;
  const agentCategory =
    config.agentCategory ??
    providedCategory ??
    deriveAgentCategory(agentType);

  const normalizedConfig: AgentConfig = {
    ...config,
    agentType,
    agentCategory,
  };

  if (agentCategory === 'toolUse') {
    return {
      agentConfig: normalizedConfig,
      agentType,
      agentCategory: 'toolUse',
      toolSessionState: {},
    };
  }

  return {
    agentConfig: normalizedConfig,
    agentType,
    agentCategory: 'workflow',
    activeFiles: createActiveFilesFromArrays(normalizedConfig),
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
  // Check if this is already in the new format with nested agentConfig
  if (obj.agentConfig && typeof obj.agentConfig === 'object') {
    const agentType = obj.agentType as AgentType | undefined;
    const rawCategory =
      obj.agentCategory ??
      (obj as { agentSessionKind?: unknown }).agentSessionKind;
    const categoryResult = AgentCategorySchema.safeParse(rawCategory);
    const agentCategory = categoryResult.success ? categoryResult.data : undefined;
    const metadata =
      agentType !== undefined || agentCategory !== undefined
        ? { agentType, agentCategory }
        : undefined;
    const state = agentConfigToTaskState(
      AgentConfigSchema.parse(obj.agentConfig),
      metadata,
    );

    if (isWorkflowTaskState(state)) {
      state.activeFiles =
        obj.activeFiles || createActiveFilesFromArrays(obj.agentConfig);
    } else if (isObjectRecord(obj.toolSessionState)) {
      state.toolSessionState = { ...obj.toolSessionState };
    }

    return state;
  }

  // Old format: extract UI-specific and tool config fields for backward compatibility
  const {
    activeFiles,
    // Extract tool config fields that might be at top level in old format
    autoExtractFigure,
    autoExtractTikzFigure,
    autoCompileInputPdf,
    attachTeXCount,
    reflect: _legacyReflect,
    ...agentConfigData
  } = obj;

  void _legacyReflect;

  const legacyPrintInputPrompt = Object.prototype.hasOwnProperty.call(
    obj,
    'printInputPrompt',
  )
    ? obj.printInputPrompt
    : undefined;

  const nestedLegacyPrintInputPrompt =
    isObjectRecord(agentConfigData.toolConfig) &&
    Object.prototype.hasOwnProperty.call(
      agentConfigData.toolConfig,
      'printInputPrompt',
    )
      ? (agentConfigData.toolConfig as Record<string, unknown>)[
          'printInputPrompt'
        ]
      : undefined;

  // Build toolConfig from extracted fields (backward compatibility)
  // Ensure toolConfig is an object, handling cases where it might be malformed
  if (
    !agentConfigData.toolConfig ||
    typeof agentConfigData.toolConfig !== 'object'
  ) {
    agentConfigData.toolConfig = {};
  }

  if (
    isObjectRecord(agentConfigData.toolConfig) &&
    Object.prototype.hasOwnProperty.call(agentConfigData.toolConfig, 'reflect')
  ) {
    delete (agentConfigData.toolConfig as Record<string, unknown>).reflect;
  }

  // Merge top-level tool config fields into toolConfig
  // Top-level fields take precedence for backward compatibility
  agentConfigData.toolConfig = {
    ...agentConfigData.toolConfig,
    ...(autoExtractFigure !== undefined && { autoExtractFigure }),
    ...(autoExtractTikzFigure !== undefined && { autoExtractTikzFigure }),
    ...(autoCompileInputPdf !== undefined && { autoCompileInputPdf }),
    ...(attachTeXCount !== undefined && { attachTeXCount }),
  };

  if (
    legacyPrintInputPrompt !== undefined ||
    nestedLegacyPrintInputPrompt !== undefined
  ) {
    console.warn(
      'Ignoring legacy printInputPrompt setting. Enable texra.debug.saveInputPrompt instead.',
    );
    delete (agentConfigData.toolConfig as Record<string, unknown>)[
      'printInputPrompt'
    ];
  }

  // Parse only AgentConfig-compatible fields
  try {
    const normalized = AgentConfigSchema.parse(agentConfigData);
    const agentType = obj.agentType as AgentType | undefined;
    const rawCategory =
      obj.agentCategory ??
      (obj as { agentSessionKind?: unknown }).agentSessionKind;
    const categoryResult = AgentCategorySchema.safeParse(rawCategory);
    const agentCategory = categoryResult.success ? categoryResult.data : undefined;
    const metadata =
      agentType !== undefined || agentCategory !== undefined
        ? { agentType, agentCategory }
        : undefined;
    const taskState = agentConfigToTaskState(normalized, metadata);

    if (isWorkflowTaskState(taskState)) {
      if (activeFiles) {
        taskState.activeFiles = activeFiles;
      }
    } else if (isObjectRecord(obj.toolSessionState)) {
      taskState.toolSessionState = { ...obj.toolSessionState };
    }

    return taskState;
  } catch (error) {
    // If parsing fails, create a minimal valid state
    console.error('Failed to parse task state, using defaults:', error);
    const defaultConfig = AgentConfigSchema.parse({});
    const agentType = obj.agentType as AgentType | undefined;
    const metadata = agentType !== undefined ? { agentType } : undefined;
    const taskState = agentConfigToTaskState(defaultConfig, metadata);

    if (isWorkflowTaskState(taskState) && activeFiles) {
      taskState.activeFiles = activeFiles;
    }

    if (
      !isWorkflowTaskState(taskState) &&
      isObjectRecord(obj.toolSessionState)
    ) {
      taskState.toolSessionState = { ...obj.toolSessionState };
    }

    return taskState;
  }
}
