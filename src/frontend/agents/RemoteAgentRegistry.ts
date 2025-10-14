// Third-party imports
import * as vscode from 'vscode';

// Local imports - auth
import {
  getEntitlements,
  onEntitlementsChanged,
  type RemoteAgentDescriptor,
} from '@common/auth/supabaseClient';

export type RemoteAgentMap = Record<string, RemoteAgentDescriptor>;

class RemoteAgentRegistry {
  private readonly emitter = new vscode.EventEmitter<void>();
  private cache: RemoteAgentMap = {};

  constructor() {
    this.refresh();
    onEntitlementsChanged(() => {
      this.refresh();
      this.emitter.fire();
    });
  }

  private refresh(): void {
    const entitlements = getEntitlements();
    const next: RemoteAgentMap = {};
    for (const agent of entitlements?.remoteAgents ?? []) {
      if (!agent.name) {
        continue;
      }
      next[agent.name] = agent;
    }
    this.cache = next;
  }

  public get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  public list(): RemoteAgentDescriptor[] {
    return Object.values(this.cache);
  }

  public has(name: string): boolean {
    return Boolean(this.cache[name]);
  }

  public get(name: string): RemoteAgentDescriptor | undefined {
    return this.cache[name];
  }

  public workflowAgents(): RemoteAgentDescriptor[] {
    return this.list().filter((agent) => !agent.isToolUse);
  }

  public toolUseAgents(): RemoteAgentDescriptor[] {
    return this.list().filter((agent) => agent.isToolUse);
  }
}

export const remoteAgentRegistry = new RemoteAgentRegistry();
