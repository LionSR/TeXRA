// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  loadAndRegisterRemoteAgents,
  selectAgentInMainView,
} from '@agent/remote/remoteAgentUtils';

// Local imports - common
import {
  BaseViewMessageHandler,
  type MessageHandler,
  PROFILE_VIEW_COMMANDS,
} from '@common/webview';

// Local imports - auth
import { SupabaseClient } from '@/auth/SupabaseClient';
import { AUTH_COMMANDS } from '@/auth/authCommands';

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
      agentType?: string;
    }> = [];

    if (tier === 'researcher') {
      try {
        // Use shared utility for loading and registering agents
        const { agents } = await loadAndRegisterRemoteAgents();
        remoteAgents = agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          tags: agent.tags,
          visibility: agent.visibility,
          agentType: agent.agentType,
        }));
      } catch (error) {
        // Log error but continue - show profile without agents
        this.logger.error(
          this.channel,
          `Failed to load remote agents: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
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

    // Use shared utility for agent selection
    await selectAgentInMainView(agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
  }

  private async handleSignIn(
    _message: ProfileDataMessage,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(
    _message: ProfileDataMessage,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }
}
