/** Injectable provider for agent directory paths. */
export interface AgentDirectories {
  custom(): Promise<string>;
  builtIn(): Promise<string>;
  builtInToolUse(): Promise<string>;
}

let agentDirectories: AgentDirectories | null = null;

/** Inject the agent directory provider. Called by host composition roots. */
export function setAgentDirectories(dirs: AgentDirectories): void {
  agentDirectories = dirs;
}

export function getAgentDirectories(): AgentDirectories {
  if (!agentDirectories) {
    throw new Error(
      'Agent directories not initialized — call setAgentDirectories() first.',
    );
  }
  return agentDirectories;
}
