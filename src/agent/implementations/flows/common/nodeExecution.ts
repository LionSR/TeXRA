// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
import type { AgentLifecycle } from './AgentLifecycle';

export type NodeExecResult<T> =
  | { result: T; error?: undefined }
  | { error: unknown; result?: undefined };

export type NodeExecVoidResult = { error?: undefined } | { error: unknown };

export async function runNodeExecution<T>(
  exec: () => Promise<T>,
): Promise<NodeExecResult<T>> {
  try {
    const result = await exec();
    return { result };
  } catch (error) {
    return { error };
  }
}

export async function runNodeEffect(
  exec: () => Promise<void>,
): Promise<NodeExecVoidResult> {
  try {
    await exec();
    return {};
  } catch (error) {
    return { error };
  }
}

export interface FinalizeNodeContext<
  Lifecycle extends AgentLifecycle<string>,
  Hooks extends AgentRunHooks,
  Agent extends object = object,
> {
  lifecycle: Lifecycle;
  hooks: Hooks;
  agent: Agent;
}
