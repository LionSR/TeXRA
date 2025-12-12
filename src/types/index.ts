/**
 * @shared/ - Shared type definitions for the TeXRA codebase.
 *
 * This is the foundation layer that all other layers can safely import from.
 * It contains ONLY:
 * - TypeScript types and interfaces
 * - Zod schemas (for runtime validation)
 * - Enums (runtime values, but stateless)
 * - Pure utility functions for type derivation
 *
 * It does NOT contain:
 * - Implementations (classes, factory functions with logic)
 * - Singletons or stateful services
 * - UI or VS Code API dependencies
 *
 * DEPENDENCY RULE: @shared/ has NO imports from other src/ modules
 * except for 'zod' (third-party).
 */

// Identifiers - StreamTabId, ExecutionId, StorageKey
export {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
  ExecutionIdentitySchema,
  type StreamTabId,
  type ExecutionId,
  type StorageKey,
  type ExecutionIdentity,
} from './identifiers';

// Agent types - AgentType, AgentCategory
export {
  AgentType,
  AgentCategory,
  AgentSessionDescriptorSchema,
  deriveAgentCategory,
  resolveAgentSessionDescriptor,
  type AgentSessionDescriptor,
} from './agent';

// Usage types - TokenUsageStats
export {
  TokenUsageStatsSchema,
  ExtendedTokenUsageStatsSchema,
  StreamUsageMessageSchema,
  type TokenUsageStats,
  type ExtendedTokenUsageStats,
  type StreamUsageMessage,
} from './usage';

// Status types - StreamStatus, TaskGroupStatus
export {
  STREAM_STATUS,
  StreamStatusSchema,
  TaskGroupStatusSchema,
  type StreamStatus,
  type TaskGroupStatus,
} from './status';

// Tool types - ITool, IToolRegistry, ToolResult
export {
  LineChangesSchema,
  FileReferenceSchema,
  ToolFileAttachmentSchema,
  EditRecordSchema,
  ToolResultSchema,
  ToolDefinitionSchema,
  type LineChanges,
  type FileReference,
  type ToolFileAttachment,
  type EditRecord,
  type ToolResult,
  type ToolDefinition,
  type ITool,
  type IToolRegistry,
  type DiagnosticsPayload,
  type ErrorDiagnostics,
} from './tools';

// Callback interfaces - for dependency injection
export {
  type ISecretProvider,
  type IAgentUICallbacks,
  type IAgentDirectories,
  type IAgentExecutionContext,
} from './callbacks';
