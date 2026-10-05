/**
 * The roster of active Lean language servers, owned by the host's
 * {@link LeanLanguageServices} adapter rather than by this module.
 *
 * Two adapters keep one each:
 *   1. The VS Code integration (one virtual entry per Lean client provided by
 *      the leanprover.lean4 extension).
 *   2. The direct LSP pool used by CLI/desktop builds (one entry per
 *      `lake env lean --server` subprocess it spawns).
 *
 * Exactly one adapter exists per process, so a roster's lifetime is that
 * adapter's: nothing survives a runtime disposal and no host has to sweep
 * another host's entries. The Tools dashboard reads it through the port
 * (`LeanLanguageServices.listServers`), so users see the same "running
 * servers" surface across all three builds.
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
  readonly errorMessage?: string;
}

export function isLeanServerActive(info: LeanServerInfo): boolean {
  return info.status === 'starting' || info.status === 'running';
}

interface RegisterLeanServerInit {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly mode: LeanServerMode;
  readonly status?: LeanServerStatus;
}

interface UpdateLeanServerPatch {
  readonly status?: LeanServerStatus;
  readonly errorMessage?: string;
}

/** One adapter's live server table; the adapter is its only writer. */
export interface LeanServerRoster {
  list(): readonly LeanServerInfo[];
  register(init: RegisterLeanServerInit): void;
  update(id: string, patch: UpdateLeanServerPatch): void;
  unregister(id: string): void;
}

/** The roster an adapter creates when it is built. */
export function createLeanServerRoster(): LeanServerRoster {
  const servers = new Map<string, LeanServerInfo>();
  return {
    list: () =>
      [...servers.values()].sort((a, b) =>
        a.workspaceRoot.localeCompare(b.workspaceRoot),
      ),
    register: (init) => {
      servers.set(init.id, {
        id: init.id,
        workspaceRoot: init.workspaceRoot,
        mode: init.mode,
        status: init.status ?? 'starting',
        startedAt: Date.now(),
      });
    },
    update: (id, patch) => {
      const existing = servers.get(id);
      if (!existing) return;
      servers.set(id, {
        ...existing,
        status: patch.status ?? existing.status,
        errorMessage:
          patch.status && patch.status !== 'error'
            ? undefined
            : (patch.errorMessage ?? existing.errorMessage),
      });
    },
    unregister: (id) => {
      servers.delete(id);
    },
  };
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
  list: readonly LeanServerInfo[],
  now: number = Date.now(),
): string {
  if (list.length === 0) return 'No Lean servers registered.';
  const lines = list.map((info) => {
    const modeLabel = LEAN_SERVER_MODE_LABELS[info.mode];
    return `• ${info.workspaceRoot} (${modeLabel})${statusTail(info, now)}`;
  });
  const header = `${formatResultCount(list.length, 'Lean server')} registered:`;
  return [header, ...lines].join('\n');
}
