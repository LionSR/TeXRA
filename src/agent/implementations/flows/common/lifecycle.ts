import type { AgentLifecycleState } from './types';

export function createLifecycleState<Phase extends string>(
  phase: Phase,
): AgentLifecycleState<Phase> {
  return {
    phase,
    status: 'pending',
    error: undefined,
  };
}

export function setLifecyclePhase<L extends AgentLifecycleState<string>>(
  lifecycle: L,
  phase: L['phase'],
): void {
  lifecycle.phase = phase;
}

export function beginLifecyclePhase<L extends AgentLifecycleState<string>>(
  lifecycle: L,
  phase: L['phase'],
): void {
  lifecycle.phase = phase;
  lifecycle.status = 'running';
  lifecycle.error = undefined;
}

export function failLifecycle<L extends AgentLifecycleState<string>>(
  lifecycle: L,
  error: unknown,
): void {
  lifecycle.status = 'error';
  lifecycle.error = error;
}

export function setLifecycleStatus<L extends AgentLifecycleState<string>>(
  lifecycle: L,
  status: L['status'],
): void {
  lifecycle.status = status;
  if (status !== 'error') {
    lifecycle.error = undefined;
  }
}

export function completeLifecycle<L extends AgentLifecycleState<string>>(
  lifecycle: L,
): void {
  setLifecycleStatus(lifecycle, 'completed');
}
