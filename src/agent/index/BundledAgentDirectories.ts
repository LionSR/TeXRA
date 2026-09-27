import * as path from 'node:path';

import { Effect } from 'effect';

import { AppState } from '@platform/interfaces';
import { getDisabledToolIds } from '@utils/config/constants';

export const BUILTIN_WORKFLOW_AGENTS_DIR = 'agents' as const;
export const BUILTIN_TOOL_USE_AGENTS_DIR = 'tool_use_agents' as const;

export const BUNDLED_AGENT_DIRECTORY_NAMES = [
  BUILTIN_WORKFLOW_AGENTS_DIR,
  BUILTIN_TOOL_USE_AGENTS_DIR,
] as const;

/**
 * The agent directories that tool plugins ship, at
 * `<resources>/plugins/<id>/agents`, by plugin id. Their agents are bundled
 * tool-use agents like the core ones and keep the `builtInToolUse` source, so
 * their keys do not change. The host bootstrap installs them once; the plugin
 * ids cross as strings, so `@agent/index` takes no edge to `@tools`. The
 * default installs none, which is what an embedder with its own agent
 * directories gets.
 */
let pluginAgentDirectories: ReadonlyMap<string, string> = new Map();

export function installPluginAgentDirectories(
  resourcesPath: string,
  agentPluginIds: readonly string[],
): void {
  pluginAgentDirectories = new Map(
    agentPluginIds.map((id) => [
      id,
      path.join(resourcesPath, 'plugins', id, 'agents'),
    ]),
  );
}

/**
 * The roots of the `builtInToolUse` source: the core bundled directory the
 * host's agent directories name, then each installed plugin's, except those
 * in `disabledPlugins`.
 */
export function builtInToolUseRoots(
  coreDirectory: string,
  disabledPlugins: ReadonlySet<string> = new Set(),
): readonly string[] {
  return [
    coreDirectory,
    ...[...pluginAgentDirectories].flatMap(([id, directory]) =>
      disabledPlugins.has(id) ? [] : [directory],
    ),
  ];
}

/**
 * The `builtInToolUse` roots the agent catalog scans. A plugin is one on/off
 * unit, so the user's switch (`texra.tools.disabled`) that withholds its
 * tools drops its agents too; toggling a plugin refreshes the catalog. A
 * failed dependency probe does not: a probe answers per workspace, the
 * catalog is the process's, and a plugin's agents may be what helps the user
 * set the dependency up.
 */
export const enabledToolUseRoots = (coreDirectory: string) =>
  AppState.pipe(
    Effect.flatMap(getDisabledToolIds),
    Effect.map((disabled) => builtInToolUseRoots(coreDirectory, disabled)),
  );
