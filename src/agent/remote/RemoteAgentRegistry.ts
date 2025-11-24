/**
 * Registry tracking remote agent status without prefix markers.
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
    // Support legacy remote:// prefix for backwards compatibility
    if (agentName.startsWith('remote://')) {
      return true;
    }
    return this.remoteAgents.has(agentName);
  }

  /**
   * Get clean agent name (strips legacy remote:// prefix).
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

/** Singleton remote agent registry. */
export const RemoteAgentRegistry = new RemoteAgentRegistryClass();
