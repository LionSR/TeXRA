/**
 * Registry to track which agents are remote.
 * Replaces the "remote://" prefix approach to avoid file path issues.
 */
class RemoteAgentRegistryClass {
  private remoteAgents = new Set<string>();

  /**
   * Register an agent as remote.
   */
  register(agentName: string): void {
    this.remoteAgents.add(agentName);
  }

  /**
   * Register multiple agents as remote.
   */
  registerMultiple(agentNames: string[]): void {
    agentNames.forEach((name) => this.remoteAgents.add(name));
  }

  /**
   * Check if an agent is remote.
   */
  isRemote(agentName: string): boolean {
    // Also check for legacy remote:// prefix for backwards compatibility
    if (agentName.startsWith('remote://')) {
      return true;
    }
    return this.remoteAgents.has(agentName);
  }

  /**
   * Get the clean agent name (strip remote:// prefix if present).
   */
  getCleanName(agentName: string): string {
    return agentName.replace(/^remote:\/\//, '');
  }

  /**
   * Unregister an agent.
   */
  unregister(agentName: string): void {
    this.remoteAgents.delete(agentName);
  }

  /**
   * Clear all registered remote agents.
   */
  clear(): void {
    this.remoteAgents.clear();
  }

  /**
   * Get all registered remote agent names.
   */
  getAll(): string[] {
    return Array.from(this.remoteAgents);
  }
}

/**
 * Singleton instance of the remote agent registry.
 */
export const RemoteAgentRegistry = new RemoteAgentRegistryClass();
