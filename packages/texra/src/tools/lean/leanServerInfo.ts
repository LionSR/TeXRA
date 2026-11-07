/**
 * What the Tools dashboard shows of one Lean language server. Each adapter
 * derives the list from what it already holds (`LeanLanguageServices.listServers`):
 * the direct pool from its map of servers by workspace root, the VS Code
 * bridge from the workspace folders it has reached the Lean 4 extension's
 * client for. So users see the same "running servers" surface across all
 * three builds.
 */

import {
  formatCompactDuration,
  formatResultCount,
} from '@texra-ai/harness/transcript';

import { LEAN_SERVER_MODE_LABELS } from './leanTypes';

export type LeanServerInfo = {
  readonly workspaceRoot: string;
  readonly mode: keyof typeof LEAN_SERVER_MODE_LABELS;
} & (
  | { readonly status: 'starting' }
  | { readonly status: 'running'; readonly startedAt: number }
  | { readonly status: 'error'; readonly errorMessage: string }
  | { readonly status: 'stopped' }
);

export function isLeanServerActive(info: LeanServerInfo): boolean {
  return info.status === 'starting' || info.status === 'running';
}

function statusTail(info: LeanServerInfo, now: number): string {
  switch (info.status) {
    case 'error':
      return `: error: ${info.errorMessage}`;
    case 'running':
      return `: uptime ${formatCompactDuration(now - info.startedAt)}`;
    case 'starting':
      return ': starting…';
    case 'stopped':
      return ': stopped';
  }
}

/** The dashboard's lines for `list`, uptimes measured to `now`. */
export function summarizeLeanServers(
  list: readonly LeanServerInfo[],
  now: number,
): string {
  if (list.length === 0) return 'No Lean servers registered.';
  const lines = list
    .toSorted((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot))
    .map((info) => {
      const modeLabel = LEAN_SERVER_MODE_LABELS[info.mode];
      return `• ${info.workspaceRoot} (${modeLabel})${statusTail(info, now)}`;
    });
  const header = `${formatResultCount(list.length, 'Lean server')} registered:`;
  return [header, ...lines].join('\n');
}
