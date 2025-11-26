// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';

// Local imports - common
import { BaseViewMessageHandler, type MessageHandler } from '@common/webview';
// @ts-ignore - Import JavaScript module
import { PROFILE_VIEW_COMMANDS, MAIN_VIEW_COMMANDS } from '@common/webview';

// Local imports - auth
import { SupabaseClient } from '@/auth/SupabaseClient';

/**
 * Message interfaces for type safety
 */
interface SelectAgentMessage {
  command: string;
  agentName: string;
}

interface ProfileDataMessage {
  command: string;
}

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
        remoteAgents: [],
      });
      return;
    }

    const user = await SupabaseClient.getUser();
    const tier = await SupabaseClient.getUserTier();

    // Fetch remote agents if user has researcher tier
    let remoteAgents: Array<{
      name: string;
      description: string;
      tags: string[];
      visibility: string;
    }> = [];

    if (tier === 'researcher') {
      const agents = await RemoteAgentLoader.listRemoteAgents();
      remoteAgents = agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        tags: agent.tags,
        visibility: agent.visibility,
      }));

      // Register remote agents so they appear in the dropdown
      // Only register agents that aren't already registered
      if (agents.length > 0) {
        const agentNames = agents.map((agent) => agent.name);
        const unregisteredAgents = agentNames.filter(
          (name) => !RemoteAgentRegistry.isRemote(name),
        );
        if (unregisteredAgents.length > 0) {
          RemoteAgentRegistry.registerMultiple(unregisteredAgents);
        }
      }
    }

    await webview.postMessage({
      command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: true,
      user: {
        email: user?.email || 'N/A',
        id: user?.id || '',
      },
      tier,
      remoteAgents,
    });
  }

  private async handleGetProfileData(
    _message: ProfileDataMessage,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendProfileData(view.webview);
  }

  private async handleSelectAgent(
    message: SelectAgentMessage,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    const agentName = message.agentName;
    if (!agentName) {
      this.logger.warn(this.channel, 'SELECT_AGENT message missing agentName');
      return;
    }

    // Focus the main view and select the agent
    await vscode.commands.executeCommand('texra.mainView.focus');

    try {
      const webviewView = await vscode.commands.executeCommand<
        vscode.WebviewView | undefined
      >('texra.getWebviewView');

      if (webviewView) {
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
          state: {
            workflowAgent: agentName,
          },
        });
        void vscode.window.showInformationMessage(
          `Remote agent "${agentName}" is now selected.`,
        );
      } else {
        this.logger.warn(this.channel, 'Main webview not available');
        void vscode.window.showWarningMessage(
          `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
        );
      }
    } catch (error) {
      this.logger.error(
        this.channel,
        `Failed to select agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      void vscode.window.showWarningMessage(
        `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
      );
    }
  }

  private async handleSignIn(
    _message: ProfileDataMessage,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.auth.signIn');
  }

  private async handleSignOut(
    _message: ProfileDataMessage,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand('texra.auth.signOut');
  }
}
