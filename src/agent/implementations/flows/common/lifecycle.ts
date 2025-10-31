import type { AgentRunLifecycleBase } from './types';

export function setLifecyclePhase<L extends AgentRunLifecycleBase>(
  lifecycle: L,
  phase: L['phase'],
): void {
  lifecycle.phase = phase;
}

export function beginLifecyclePhase<L extends AgentRunLifecycleBase>(
  lifecycle: L,
  phase: L['phase'],
): void {
  lifecycle.phase = phase;
  lifecycle.status = 'running';
  lifecycle.error = undefined;
}

export function failLifecycle<L extends AgentRunLifecycleBase>(
  lifecycle: L,
  error: unknown,
): void {
  lifecycle.status = 'error';
  lifecycle.error = error;
}

export function setLifecycleStatus<L extends AgentRunLifecycleBase>(
  lifecycle: L,
  status: L['status'],
): void {
  lifecycle.status = status;
  if (status !== 'error') {
    lifecycle.error = undefined;
  }
}

export function completeLifecycle<L extends AgentRunLifecycleBase>(
  lifecycle: L,
): void {
  setLifecycleStatus(lifecycle, 'completed');
}
