import { AsyncLocalStorage } from 'async_hooks';

import {
  getDefaultProgressSink,
  setDefaultProgressSink,
  type ProgressSink,
} from './ProgressSink';

export type AgentRuntimeHost = ProgressSink;

let defaultAgentRuntimeHost: AgentRuntimeHost | undefined;
const runtimeHostScope = new AsyncLocalStorage<AgentRuntimeHost>();

export function setDefaultAgentRuntimeHost(host: AgentRuntimeHost): void {
  defaultAgentRuntimeHost = host;
  setDefaultProgressSink(host);
}

export function getDefaultAgentRuntimeHost(): AgentRuntimeHost {
  return defaultAgentRuntimeHost ?? getDefaultProgressSink();
}

export function getAgentRuntimeHost(): AgentRuntimeHost {
  return runtimeHostScope.getStore() ?? getDefaultAgentRuntimeHost();
}

export function runWithAgentRuntimeHost<T>(
  host: AgentRuntimeHost | undefined,
  fn: () => T,
): T {
  return host ? runtimeHostScope.run(host, fn) : fn();
}
