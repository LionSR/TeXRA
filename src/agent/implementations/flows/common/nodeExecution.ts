// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';

/**
 * Discriminated union result type for node exec methods that return a value.
 * Use inline try/catch in exec() and return { result } on success or { error } on failure.
 */
export type NodeExecResult<T> =
  | { result: T; error?: undefined }
  | { error: unknown; result?: undefined };

/**
 * Discriminated union result type for node exec methods that return void.
 * Use inline try/catch in exec() and return {} on success or { error } on failure.
 */
export type NodeExecVoidResult = { error?: undefined } | { error: unknown };

export interface FinalizeNodeContext<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object = object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}
