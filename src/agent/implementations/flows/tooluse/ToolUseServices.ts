/**
 * Service interfaces for tool-use flow.
 *
 * Extends BaseFlowContextInit with:
 * - Narrowed setting type (AgentToolUseSetting)
 * - Required getUsageRecorder (narrowed from optional)
 * - Tool-use specific services (toolRegistry, session, etc.)
 *
 * Services are injected via flow.setServices() and accessed via this.services.
 */

import type { AgentToolUseSetting } from '@agent/core/AgentDataclass';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { ToolDefinition } from '@model';
import type {
  BaseFlowContextInit,
  FlowParams,
} from '../common/BaseFlowServices';
import type { IToolUseSession } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';

/** Services for tool-use flow nodes. Extends BaseFlowContextInit with tool-use specific dependencies. */
export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  /** Narrowed from AgentSetting to tool-use specific type */
  readonly setting: AgentToolUseSetting;
  readonly toolRegistry: IToolRegistry;
  readonly session: IToolUseSession;
  readonly resolvedTools: ToolDefinition[];
  /** Resume snapshot for session recovery (null for fresh start). */
  readonly snapshot: ToolUseSessionSnapshot | null;
  /** Narrowed from optional to required for tool-use flows */
  readonly getUsageRecorder: () => RoundFinalizedCallback;
  /** Callback invoked when a queued follow-up message is consumed (clears UI). */
  readonly onFollowUpConsumed?: () => void;
}

/** Flow params type for tool-use flows. Alias for base FlowParams. */
export type { FlowParams as ToolUseFlowParams };
