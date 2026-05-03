import { AsyncLocalStorage } from 'async_hooks';

import {
  getDefaultProgressSink,
  setDefaultProgressSink,
  type ProgressSink,
} from './ProgressSink';

export interface AgentRuntimeHost {
  progressSink: ProgressSink;
  emit: ProgressSink['emit'];
}

export function createAgentRuntimeHost(
  progressSink: ProgressSink,
): AgentRuntimeHost {
  return {
    progressSink,
    emit: (event, payload) => progressSink.emit(event, payload),
  };
}

let defaultAgentRuntimeHost: AgentRuntimeHost | undefined;
const runtimeHostScope = new AsyncLocalStorage<AgentRuntimeHost>();

export function setDefaultAgentRuntimeHost(host: AgentRuntimeHost): void {
  defaultAgentRuntimeHost = host;
  setDefaultProgressSink(host.progressSink);
}

export function getDefaultAgentRuntimeHost(): AgentRuntimeHost {
  return (
    defaultAgentRuntimeHost ?? createAgentRuntimeHost(getDefaultProgressSink())
  );
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
