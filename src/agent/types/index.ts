/**
 * Agent types barrel export.
 *
 * Consolidates shared type definitions and schemas for agent system.
 */

// Identifier types
export {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
  ExecutionIdentitySchema,
  type StreamTabId,
  type ExecutionId,
  type StorageKey,
  type ExecutionIdentity,
  type StorageKeyManager,
} from './IdentifierTypes';

// Usage types
export {
  TokenUsageStatsSchema,
  ExtendedTokenUsageStatsSchema,
  StreamUsageMessageSchema,
  type TokenUsageStats,
  type ExtendedTokenUsageStats,
  type StreamUsageMessage,
} from './UsageTypes';

// Normalized usage
export {
  UsageProviderSchema,
  NormalizedUsageSchema,
  type UsageProvider,
  type NormalizedUsage,
} from './NormalizedUsage';

// Result types
export {
  ExecResultSchema,
  FileOpStatusSchema,
  FileOpResultSchema,
  type ExecResult,
  type FileOpStatus,
  type FileOpResult,
} from './ResultTypes';

// Diff types
export { DiffStatsSchema, type DiffStats } from './DiffTypes';

// Agent stream types
export { type AgentTypeFilter, isAgentTypeFilter } from './AgentStreamTypes';
