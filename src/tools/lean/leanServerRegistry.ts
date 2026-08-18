/**
 * Per-process registry of active Lean language servers.
 *
 * Two adapters write to this registry:
 *   1. The VS Code integration (one virtual entry per Lean client provided by
 *      the leanprover.lean4 extension).
 *   2. The direct LSP adapter used by CLI/desktop builds (one entry per
 *      `lake env lean --server` subprocess we spawn).
 *
 * The Tools dashboard reads from here so users see the same "running servers"
 * surface across all three builds.
 */

import {
  formatCompactDuration,
  formatResultCount,
} from '@utils/text/stringUtils';

import { LEAN_SERVER_MODE_LABELS } from './leanTypes';

type LeanServerMode = keyof typeof LEAN_SERVER_MODE_LABELS;

type LeanServerStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface LeanServerInfo {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly mode: LeanServerMode;
  readonly status: LeanServerStatus;
  readonly startedAt: number;
  readonly toolchain?: string;
  readonly pid?: number;
  readonly errorMessage?: string;
}

const servers = new Map<string, LeanServerInfo>();

export function listLeanServers(): readonly LeanServerInfo[] {
  return [...servers.values()].sort((a, b) =>
    a.workspaceRoot.localeCompare(b.workspaceRoot),
  );
}

export function isLeanServerActive(info: LeanServerInfo): boolean {
  return info.status === 'starting' || info.status === 'running';
}

export interface RegisterLeanServerInit {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly mode: LeanServerMode;
  readonly status?: LeanServerStatus;
  readonly toolchain?: string;
  readonly pid?: number;
}

export function registerLeanServer(init: RegisterLeanServerInit): void {
  servers.set(init.id, {
    id: init.id,
    workspaceRoot: init.workspaceRoot,
    mode: init.mode,
    status: init.status ?? 'starting',
    startedAt: Date.now(),
    toolchain: init.toolchain,
    pid: init.pid,
  });
}

export interface UpdateLeanServerPatch {
  readonly status?: LeanServerStatus;
  readonly toolchain?: string;
  readonly pid?: number;
  readonly errorMessage?: string;
}

export function updateLeanServer(
  id: string,
  patch: UpdateLeanServerPatch,
): void {
  const existing = servers.get(id);
  if (!existing) return;
  servers.set(id, {
    ...existing,
    status: patch.status ?? existing.status,
    toolchain: patch.toolchain ?? existing.toolchain,
    pid: patch.pid ?? existing.pid,
    errorMessage:
      patch.status && patch.status !== 'error'
        ? undefined
        : (patch.errorMessage ?? existing.errorMessage),
  });
}

export function unregisterLeanServer(id: string): void {
  servers.delete(id);
}

function statusTail(info: LeanServerInfo, now: number): string {
  switch (info.status) {
    case 'error':
      return `: error: ${info.errorMessage ?? 'unknown'}`;
    case 'running':
      return `: uptime ${formatCompactDuration(now - info.startedAt)}`;
    case 'starting':
      return ': starting…';
    case 'stopped':
      return ': stopped';
  }
}

export function summarizeLeanServers(
  list: readonly LeanServerInfo[] = listLeanServers(),
  now: number = Date.now(),
): string {
  if (list.length === 0) return 'No Lean servers registered.';
  const lines = list.map((info) => {
    const modeLabel = LEAN_SERVER_MODE_LABELS[info.mode];
    const toolchain = info.toolchain ? `, ${info.toolchain}` : '';
    return `• ${info.workspaceRoot} (${modeLabel}${toolchain})${statusTail(info, now)}`;
  });
  const header = `${formatResultCount(list.length, 'Lean server')} registered:`;
  return [header, ...lines].join('\n');
}
