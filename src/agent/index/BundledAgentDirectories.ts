import * as path from 'node:path';

export const BUILTIN_WORKFLOW_AGENTS_DIR = 'agents' as const;
export const BUILTIN_TOOL_USE_AGENTS_DIR = 'tool_use_agents' as const;

export const BUNDLED_AGENT_DIRECTORY_NAMES = [
  BUILTIN_WORKFLOW_AGENTS_DIR,
  BUILTIN_TOOL_USE_AGENTS_DIR,
] as const;

/**
 * The agent directories that tool plugins ship, at
 * `<resources>/plugins/<id>/agents`. Their agents are bundled tool-use agents
 * like the core ones and keep the `builtInToolUse` source, so their keys do
 * not change. The host bootstrap installs them once; the plugin ids cross as
 * strings, so `@agent/index` takes no edge to `@tools`. The default installs
 * none, which is what an embedder with its own agent directories gets.
 */
let pluginAgentDirectories: readonly string[] = [];

export function installPluginAgentDirectories(
  resourcesPath: string,
  agentPluginIds: readonly string[],
): void {
  pluginAgentDirectories = agentPluginIds.map((id) =>
    path.join(resourcesPath, 'plugins', id, 'agents'),
  );
}

/**
 * The roots of the `builtInToolUse` source: the core bundled directory the
 * host's agent directories name, then each installed plugin's.
 */
export function builtInToolUseRoots(coreDirectory: string): readonly string[] {
  return [coreDirectory, ...pluginAgentDirectories];
}
