import * as vscode from 'vscode';

/** Metadata stored for each remote agent. */
export interface RemoteAgentInfo {
  description?: string;
  agentType?: string;
}

/**
 * Registry tracking remote agent status without prefix markers.
 * State is persisted to ExtensionContext.globalState for resilience across VS Code reloads.
 */
class RemoteAgentRegistryClass {
  private static readonly STORAGE_KEY = 'texra.remoteAgentRegistry';
  private remoteAgents = new Set<string>();
  private agentMetadata = new Map<string, RemoteAgentInfo>();
  private context: vscode.ExtensionContext | null = null;

  /**
   * Initialize the registry with ExtensionContext and restore persisted state.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    const persisted = context.globalState.get<string[]>(
      RemoteAgentRegistryClass.STORAGE_KEY,
      [],
    );
    this.remoteAgents = new Set(persisted);
  }

  /**
   * Persist current state to ExtensionContext.globalState.
   */
  private async persist(): Promise<void> {
    if (this.context) {
      await this.context.globalState.update(
        RemoteAgentRegistryClass.STORAGE_KEY,
        Array.from(this.remoteAgents),
      );
    }
  }

  /**
   * Register an agent as remote.
   */
  register(agentName: string): void {
    this.remoteAgents.add(agentName);
    void this.persist();
  }

  /**
   * Register multiple agents as remote with optional metadata.
   */
  registerMultiple(
    agents: Array<{ name: string; description?: string; agentType?: string }>,
  ): void {
    agents.forEach(({ name, description, agentType }) => {
      this.remoteAgents.add(name);
      if (description || agentType) {
        this.agentMetadata.set(name, { description, agentType });
      }
    });
    void this.persist();
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
    void this.persist();
  }

  /**
   * Clear all registered remote agents.
   */
  clear(): void {
    this.remoteAgents.clear();
    this.agentMetadata.clear();
    void this.persist();
  }

  /**
   * Get all registered remote agent names.
   */
  getAll(): string[] {
    return Array.from(this.remoteAgents);
  }

  /**
   * Get metadata for a remote agent.
   */
  getMetadata(agentName: string): RemoteAgentInfo | undefined {
    const cleanName = this.getCleanName(agentName);
    return this.agentMetadata.get(cleanName);
  }
}

/** Singleton remote agent registry. */
export const RemoteAgentRegistry = new RemoteAgentRegistryClass();
