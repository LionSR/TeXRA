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

export type LeanServerMode = 'vscode-extension' | 'direct-lsp';

export type LeanServerStatus =
  | 'starting'
  | 'running'
  | 'error'
  | 'stopped';

export interface LeanServerInfo {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly mode: LeanServerMode;
  readonly status: LeanServerStatus;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly toolchain?: string;
  readonly pid?: number;
  readonly errorMessage?: string;
}

type Listener = (snapshot: readonly LeanServerInfo[]) => void;

const servers = new Map<string, LeanServerInfo>();
const listeners = new Set<Listener>();

function snapshot(): readonly LeanServerInfo[] {
  return [...servers.values()].sort((a, b) =>
    a.workspaceRoot.localeCompare(b.workspaceRoot),
  );
}

function notify(): void {
  const view = snapshot();
  for (const listener of listeners) {
    try {
      listener(view);
    } catch {
      // Ignore listener failures so one bad observer can't break the others.
    }
  }
}

export function listLeanServers(): readonly LeanServerInfo[] {
  return snapshot();
}

export function subscribeLeanServers(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface RegisterLeanServerInit {
  id: string;
  workspaceRoot: string;
  mode: LeanServerMode;
  status?: LeanServerStatus;
  toolchain?: string;
  pid?: number;
}

export function registerLeanServer(init: RegisterLeanServerInit): void {
  const now = Date.now();
  servers.set(init.id, {
    id: init.id,
    workspaceRoot: init.workspaceRoot,
    mode: init.mode,
    status: init.status ?? 'starting',
    startedAt: now,
    lastActivityAt: now,
    toolchain: init.toolchain,
    pid: init.pid,
  });
  notify();
}

export interface UpdateLeanServerPatch {
  status?: LeanServerStatus;
  toolchain?: string;
  pid?: number;
  errorMessage?: string;
  touchActivity?: boolean;
}

export function updateLeanServer(id: string, patch: UpdateLeanServerPatch): void {
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
    lastActivityAt: patch.touchActivity ? Date.now() : existing.lastActivityAt,
  });
  notify();
}

export function unregisterLeanServer(id: string): void {
  if (!servers.delete(id)) return;
  notify();
}

/** Clear all entries — only used by tests and shutdown handlers. */
export function clearLeanServerRegistry(): void {
  if (servers.size === 0) return;
  servers.clear();
  notify();
}

export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function summarizeLeanServers(
  list: readonly LeanServerInfo[] = snapshot(),
  now: number = Date.now(),
): string {
  if (list.length === 0) return 'No Lean servers active.';
  const lines = list.map((info) => {
    const uptime = formatUptime(now - info.startedAt);
    const modeLabel =
      info.mode === 'vscode-extension' ? 'leanprover.lean4' : 'direct LSP';
    const toolchain = info.toolchain ? `, ${info.toolchain}` : '';
    const tail =
      info.status === 'error'
        ? ` — error: ${info.errorMessage ?? 'unknown'}`
        : info.status === 'running'
          ? ` — uptime ${uptime}`
          : info.status === 'starting'
            ? ' — starting…'
            : ' — stopped';
    return `• ${info.workspaceRoot} (${modeLabel}${toolchain})${tail}`;
  });
  const header =
    list.length === 1
      ? '1 Lean server active:'
      : `${list.length} Lean servers active:`;
  return [header, ...lines].join('\n');
}
