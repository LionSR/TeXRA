import { AsyncLocalStorage } from 'async_hooks';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import {
  getDefaultProgressSink,
  setDefaultProgressSink,
  type ProgressSink,
} from './ProgressSink';

export interface AgentRuntimeHost {
  progressSink: ProgressSink;
  emit: ProgressSink['emit'];
  updateStreamStatus: (
    payload: ProgressEventPayloads['updateStreamStatus'],
  ) => void;
  updateQueuedFollowUps: (
    payload: ProgressEventPayloads['updateQueuedFollowUps'],
  ) => void;
  updateActiveSubagents: (
    payload: ProgressEventPayloads['updateActiveSubagents'],
  ) => void;
  updateActiveProcesses: (
    payload: ProgressEventPayloads['updateActiveProcesses'],
  ) => void;
  updateProcessOutput: (
    payload: ProgressEventPayloads['updateProcessOutput'],
  ) => void;
  setParentStream: (payload: ProgressEventPayloads['setParentStream']) => void;
}

export function createAgentRuntimeHost(
  progressSink: ProgressSink,
): AgentRuntimeHost {
  const emit: ProgressSink['emit'] = (event, payload) =>
    progressSink.emit(event, payload);

  return {
    progressSink,
    emit,
    updateStreamStatus: (payload) => emit('updateStreamStatus', payload),
    updateQueuedFollowUps: (payload) => emit('updateQueuedFollowUps', payload),
    updateActiveSubagents: (payload) => emit('updateActiveSubagents', payload),
    updateActiveProcesses: (payload) => emit('updateActiveProcesses', payload),
    updateProcessOutput: (payload) => emit('updateProcessOutput', payload),
    setParentStream: (payload) => emit('setParentStream', payload),
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
