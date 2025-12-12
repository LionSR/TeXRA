// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { getAgentsBySource, loadAgents, type AgentSource } from '@agent/index';
import { selectAgentInMainView } from '@agent/remote/remoteAgentUtils';

// Local imports - common
import {
  BaseViewMessageHandler,
  type MessageHandler,
  PROFILE_VIEW_COMMANDS,
} from '@common/webview';

// Local imports - auth
import { SupabaseClient } from '@/auth/SupabaseClient';
import { AUTH_COMMANDS } from '@/auth/authCommands';
import { PERMISSIONS, hasPermission } from '@/auth/config';

// --- Message Schemas ---
const SelectAgentMessage = z.object({ agentName: z.string().min(1) });

export class ProfileViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  constructor(private readonly context: vscode.ExtensionContext) {
    super('ProfileView');
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView | vscode.WebviewPanel>
  > {
    return {
      [PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA]:
        this.handleGetProfileData.bind(this),
      [PROFILE_VIEW_COMMANDS.SELECT_AGENT]: this.handleSelectAgent.bind(this),
      [PROFILE_VIEW_COMMANDS.SIGN_IN]: this.handleSignIn.bind(this),
      [PROFILE_VIEW_COMMANDS.SIGN_OUT]: this.handleSignOut.bind(this),
    };
  }

  public async sendProfileData(webview: vscode.Webview): Promise<void> {
    const isAuth = await SupabaseClient.isAuthenticated();

    if (!isAuth) {
      await webview.postMessage({
        command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
      });
      return;
    }

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    // Fetch remote agents if user has permission
    let remoteAgents: Array<{
      name: string;
      description: string;
      visibility: string;
      category?: string;
    }> = [];

    const canAccessRemoteAgents = hasPermission(
      authContext.permissions,
      PERMISSIONS.ACCESS_REMOTE_AGENTS,
    );

    if (canAccessRemoteAgents) {
      // Refresh agent cache to ensure remote agents are loaded after authentication
      await loadAgents();
      const entries = getAgentsBySource('remote' as AgentSource);
      remoteAgents = entries.map((entry) => ({
        name: entry.name,
        description: entry.description || '',
        visibility: entry.visibility || 'researcher',
        category: entry.category || 'workflow',
      }));
    }

    await webview.postMessage({
      command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: true,
      user: {
        email: user?.email || 'N/A',
        id: user?.id || '',
      },
      tier: authContext.primaryGroup, // Backwards compatibility
      permissions: authContext.permissions,
      remoteAgents,
    });
  }

  private async handleGetProfileData(
    _message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendProfileData(view.webview);
  }

  private async handleSelectAgent(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SelectAgentMessage,
      message,
      'selectAgent',
      async ({ agentName }) => {
        // Use shared utility for agent selection
        await selectAgentInMainView(agentName, {
          showSuccessMessage: true,
          copyToClipboardOnFailure: false,
        });
      },
    );
  }

  private async handleSignIn(
    _message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(
    _message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }
}
