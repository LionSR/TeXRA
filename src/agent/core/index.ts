/**
 * Agent core barrel export.
 *
 * NOTE: This barrel is currently unused - all external imports are direct
 * (e.g., '@agent/core/AgentDataclass' instead of '@agent/core').
 *
 * Retained for potential future use and documentation of public API.
 * For most imports, use the specific file path directly.
 */

// Most commonly used - enums and category types
export { AgentCategory, hasEndTag } from './AgentDataclass.js';
export type {
  AgentSetting,
  AgentPrompt,
  AgentWorkflowSetting,
} from './AgentDataclass.js';

// Config types
export type { AgentConfig } from './AgentConfig.js';
export type { ToolConfig } from './ToolConfig.js';

// State classes - commonly instantiated
export { AgentWorkspaceState } from './AgentWorkspaceState.js';
export { ConversationRoundState } from './AgentState.js';
