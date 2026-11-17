/**
 * What the Tools dashboard shows of one Lean language server: the pool
 * derives the list from its map of servers by workspace root
 * (`LeanLanguageServices.listServers`).
 */

import {
  formatCompactDuration,
  formatResultCount,
} from '@texra-ai/harness/schemas';

export type LeanServerInfo = {
  readonly workspaceRoot: string;
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
    .map((info) => `• ${info.workspaceRoot}${statusTail(info, now)}`);
  const header = `${formatResultCount(list.length, 'Lean server')} registered:`;
  return [header, ...lines].join('\n');
}
