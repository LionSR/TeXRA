/**
 * Shared state types for reflection flow.
 *
 * ## Schema-First Pattern
 *
 * Schemas are the single source of truth for data structures:
 * - Define schemas first, then derive TypeScript types using z.infer<>
 * - Enables validation during persistence/restoration
 * - Ensures type safety and DRY code
 *
 * ## Following koala-code-reader's Pattern
 *
 * Shared state is a FLAT structure containing ONLY natively serializable data:
 * - Use snapshots instead of class instances
 * - No runtime dependencies (those go in services)
 * - No functions or callbacks
 * - No nested wrappers (state is accessed directly as shared.X, not shared.state.X)
 *
 * This ensures clean serialization via structuredClone() in PersistedFlow.
 *
 * ## Architecture
 *
 * - **shared**: Mutable, natively serializable state (survives structuredClone)
 * - **services**: Runtime dependencies (logger, model handler, runStage, etc.)
 * - **params**: Immutable flow configuration
 */

import { z } from 'zod';

import { RoundOutputSchema } from '@agent/output';
import {
  AgentRunStateSnapshotSchema,
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import {
  CycleFieldsSchema,
  type CycleTransientFields,
} from '@agent/core/flows/ResponseCycleFlow';
import { AgentFileLocationSchema } from '@utils/files';

// ============================================================================
// Schemas (Single Source of Truth)
// ============================================================================

/**
 * Natively serializable context prepared for a round.
 *
 * Following koala-code-reader pattern:
 * - stateRoundSnapshot is a plain JSON snapshot (not class instance)
 * - Nodes reconstruct ConversationRoundState when needed for mutation
 * - This ensures structuredClone() works correctly in PersistedFlow
 */
export const RoundContextSchema = z.object({
  /** Prepared messages for the model */
  messages: z.array(ProviderMessageSchema),
  /** Prefill text for assistant response */
  prefill: z.string(),
  /** Round state snapshot (natively serializable) */
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

/** Derived type from schema */
export type RoundContext = z.infer<typeof RoundContextSchema>;

/**
 * Optional cycle fields for native nesting.
 *
 * These are derived from CycleFieldsSchema but made optional since they're
 * only populated when running a cycle.
 *
 * ## Why certain fields are omitted
 *
 * `endTurn` and `outputLocation` are omitted because they have different
 * semantics at the reflection flow level vs the cycle level:
 *
 * - **endTurn**: At reflection level, tracks whether the agent's turn ended.
 *   At cycle level, tracks whether a single model call ended normally.
 *   Both use boolean, but reflection flow needs it as a required non-optional field.
 *
 * - **outputLocation**: At reflection level, nullable (null before round starts).
 *   At cycle level, must be set before cycle runs (enforced by assertCycleFieldsPopulated).
 *   Keeping the base schema's nullable version avoids type conflicts.
 *
 * The base schema defines these directly; the merge adds the remaining cycle fields.
 */
const OptionalCycleFieldsSchema = CycleFieldsSchema.partial().omit({
  endTurn: true,
  outputLocation: true,
});

/**
 * Shared state for reflection flow (flat structure).
 *
 * This flows through all nodes and gets updated in post() methods.
 * Access fields directly as `shared.currentRound`, not `shared.state.currentRound`.
 *
 * ## Serialization Strategy
 *
 * Following koala-code-reader's pattern, we store **snapshots** for
 * complex state objects instead of class instances:
 * - workspaceSnapshot: AgentWorkspaceSnapshot (not AgentWorkspaceState)
 * - runStateSnapshot: AgentRunStateSnapshot (not AgentRunState)
 * - roundStateSnapshots: ConversationRoundStateSnapshot[] (not class array)
 * - context.stateRoundSnapshot: snapshot, not ConversationRoundState
 *
 * Nodes reconstruct class instances from snapshots when needed, then
 * store snapshots back after mutation. This ensures structuredClone()
 * works without any special handling.
 *
 * ## Native Nesting
 *
 * Includes optional cycle fields (via OptionalCycleFieldsSchema) to enable
 * cycle nodes to run directly on this shared type. See CycleFieldsSchema
 * in ResponseCycleFlow.ts for the single source of truth.
 *
 * ## Round Stage Management
 *
 * Round stages (r0, r1, r2...) are managed by RoundPersistedFlow, not by
 * shared state or services. This keeps round lifecycle as a flow-level
 * concern, invisible to individual nodes.
 */
export const ReflectionFlowStateSchema = z
  .object({
    // Round tracking
    currentRound: z.number(),
    totalRounds: z.number(),

    // Per-round state (natively serializable)
    workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
    context: RoundContextSchema.nullable(),
    outputLocation: AgentFileLocationSchema.nullable(),

    // Accumulated state (natively serializable)
    conversation: z.array(ProviderMessageSchema),
    runStateSnapshot: AgentRunStateSnapshotSchema,

    // Results (natively serializable)
    roundStateSnapshots: z.array(ConversationRoundStateSnapshotSchema),
    roundOutputs: z.array(RoundOutputSchema),

    // Control flags
    continueRounds: z.boolean(),
    endTurn: z.boolean(),

    // Note: lastError is inherited from OptionalCycleFieldsSchema (via BaseCycleFieldsSchema).
    // Used to distinguish failure from cancellation during resume.
  })
  .extend(OptionalCycleFieldsSchema.shape);

/** Derived type from schema (serializable fields only) */
export type ReflectionFlowState = z.infer<typeof ReflectionFlowStateSchema>;

/**
 * Shared context passed through the flow.
 *
 * Combines serializable state (ReflectionFlowState) with transient cycle
 * fields (CycleTransientFields) for native flow nesting.
 *
 * - Serializable fields are persisted by PersistedFlow
 * - Transient fields are cleared between checkpoints
 *
 * CycleTransientFields is imported from ResponseCycleFlow.ts (single source of truth).
 */
export type ReflectionFlowShared = ReflectionFlowState & CycleTransientFields;
