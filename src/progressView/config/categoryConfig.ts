/**
 * Centralized configuration for agent category-specific behavior.
 *
 * This module eliminates scattered conditional checks (e.g., `if (category === 'toolUse')`)
 * throughout the progressView codebase by consolidating all category-dependent behavior
 * into a single lookup table.
 *
 * ## Design Rationale
 *
 * The "task group" abstraction has different semantics per agent category:
 *
 * - **Workflow agents**: Each group is a distinct "run" (user can switch between runs,
 *   only one visible at a time via run selector dropdown)
 *
 * - **ToolUse agents**: Each group is a conversation "turn" (user message → agent
 *   response with tool calls). All turns are always visible as continuous conversation history.
 *
 * Rather than scattering `isToolUse` checks throughout the code, we define the behavioral
 * differences here and look them up via `getCategoryConfig()`.
 */

import { AgentCategory } from '@agent/core/AgentDataclass';

/**
 * Configuration for category-specific UI and behavior differences.
 */
export interface CategoryConfig {
  /** Whether to show the run selector dropdown (workflow: switch runs, toolUse: N/A) */
  readonly showRunSelector: boolean;

  /** Whether to show round headers in the output file list */
  readonly showRoundHeaders: boolean;

  /** Whether to show the instruction panel */
  readonly showInstructionPanel: boolean;

  /** Whether task groups represent switchable runs (vs append-only history) */
  readonly taskGroupsAreSwitchable: boolean;

  /** Whether resume functionality is available */
  readonly supportsResume: boolean;

  /** Whether file fields are relevant for this category */
  readonly hasFileFields: boolean;
}

/**
 * Workflow agent configuration.
 * - Runs are discrete and switchable via the run selector
 * - Round headers provide meaningful context
 * - Instruction panel shows the current run's instruction
 * - File fields are relevant for document processing
 */
const WORKFLOW_CONFIG: CategoryConfig = {
  showRunSelector: true,
  showRoundHeaders: true,
  showInstructionPanel: true,
  taskGroupsAreSwitchable: true,
  supportsResume: true,
  hasFileFields: true,
};

/**
 * ToolUse agent configuration.
 * - Conversation turns are append-only (all visible)
 * - Round headers are not meaningful in conversation context
 * - Instruction panel is not used (conversation is self-documenting)
 * - File fields are not relevant for interactive sessions
 */
const TOOL_USE_CONFIG: CategoryConfig = {
  showRunSelector: false,
  showRoundHeaders: false,
  showInstructionPanel: false,
  taskGroupsAreSwitchable: false,
  supportsResume: false,
  hasFileFields: false,
};

/**
 * Category configuration lookup table.
 * Indexed by AgentCategory enum values for direct access.
 */
const CATEGORY_CONFIGS: Record<AgentCategory, CategoryConfig> = {
  [AgentCategory.Workflow]: WORKFLOW_CONFIG,
  [AgentCategory.ToolUse]: TOOL_USE_CONFIG,
};

/**
 * Get the configuration for an agent category.
 *
 * @param category - The agent category (from AgentCategory enum or string literal)
 * @returns The category-specific configuration
 *
 * @example
 * ```typescript
 * const config = getCategoryConfig(AgentCategory.ToolUse);
 * if (config.showInstructionPanel) {
 *   dom.instructionPanel.show(instruction);
 * }
 * ```
 */
export function getCategoryConfig(category: AgentCategory): CategoryConfig {
  return CATEGORY_CONFIGS[category];
}

/**
 * Check if a category is workflow.
 * Convenience function for cases where a simple boolean is clearer.
 */
export function isWorkflowCategory(category: AgentCategory): boolean {
  return category === AgentCategory.Workflow;
}

/**
 * Check if a category is toolUse.
 * Convenience function for cases where a simple boolean is clearer.
 */
export function isToolUseCategory(category: AgentCategory): boolean {
  return category === AgentCategory.ToolUse;
}
