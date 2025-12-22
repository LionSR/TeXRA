// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - agent
import { getAgentsBySource, loadAgents, type AgentSource } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
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
import { ULTRA_TIER, MAX_TIER } from '@/auth/config';
import {
  getEnabledProviders,
  setUseIncludedModelAccess,
  getUseIncludedModelAccess,
} from '@/auth/serverSideKeyAccess';
import {
  getTierConfig,
  getAllowedModelsForTier,
  getEffectiveProvidersForTier,
} from '@/auth/tierModelAccess';

// --- Message Schemas ---
const SelectAgentMessage = z.object({ agentName: z.string().min(1) });
const SetApiAccessModeMessage = z.object({
  mode: z.enum(['included', 'personal']),
});

/** Schema for remote agent data sent to webview (used for type inference only) */
const RemoteAgentPayloadSchema = z.object({
  name: z.string(),
  description: z.string(),
  visibility: z.array(z.string()),
  category: z.nativeEnum(AgentCategory),
  supportsMultipleOutput: z.boolean(),
});
type RemoteAgentPayload = z.infer<typeof RemoteAgentPayloadSchema>;

export class ProfileViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  constructor(_context: vscode.ExtensionContext) {
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
      [PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE]:
        this.handleSetApiAccessMode.bind(this),
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
        apiAccessMode: 'personal',
        enabledProviders: [],
        allowedModels: [], // No models for unauthenticated users
        tierConstants: {
          ultra: ULTRA_TIER,
          max: MAX_TIER,
        },
      });
      return;
    }

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    // Fetch remote agents - RLS filters based on user's permissions
    // All authenticated users can see agents matching their visibility access
    await loadAgents();
    const entries = getAgentsBySource('remote' as AgentSource);
    const remoteAgents: RemoteAgentPayload[] = entries.map((entry) => ({
      name: entry.name,
      description: entry.description || '',
      visibility: entry.visibility || ['public'],
      category: entry.category || AgentCategory.Workflow,
      supportsMultipleOutput: !!entry.multiplePath,
    }));

    // Get model access settings - all authenticated users have access (Researcher Access Program)
    const isUltra = authContext.tier === ULTRA_TIER;
    const useIncludedAccess = getUseIncludedModelAccess();
    const apiAccessMode = useIncludedAccess ? 'included' : 'personal';

    // Fetch tier config and enabled providers for all authenticated users
    const [tierConfig, serverProviders] = await Promise.all([
      getTierConfig(),
      getEnabledProviders(),
    ]);

    let enabledProviders: string[] = [];
    let allowedModels: string[] | null = null;

    // For Ultra tier, use all enabled providers from server
    // For Max/free tiers, use the tier-specific provider list filtered by server
    if (isUltra) {
      enabledProviders = serverProviders;
      allowedModels = null; // null = all models
    } else if (tierConfig) {
      // Max and free tiers use tier-specific configuration
      const userTier = authContext.tier;
      enabledProviders = getEffectiveProvidersForTier(
        userTier,
        tierConfig,
        serverProviders,
      );
      allowedModels = getAllowedModelsForTier(userTier, tierConfig);
    }

    await webview.postMessage({
      command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: true,
      user: {
        email: user?.email || 'N/A',
        id: user?.id || '',
      },
      tier: authContext.tier,
      permissions: authContext.permissions,
      remoteAgents,
      apiAccessMode,
      enabledProviders,
      // New fields for Max tier support
      allowedModels, // null = all models (Ultra), array = specific models (Max)
      tierConstants: {
        ultra: ULTRA_TIER,
        max: MAX_TIER,
      },
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

  private async handleSetApiAccessMode(
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      SetApiAccessModeMessage,
      message,
      'setApiAccessMode',
      async ({ mode }) => {
        // Update the setting (also clears cache and fires change event)
        const useIncludedAccess = mode === 'included';
        await setUseIncludedModelAccess(useIncludedAccess);

        // Refresh profile data to reflect the change
        await this.sendProfileData(view.webview);

        // Show confirmation message
        const modeLabel =
          mode === 'included' ? 'Included Access' : 'My Own Keys';
        void vscode.window.showInformationMessage(
          `Model access changed to: ${modeLabel}`,
        );
      },
    );
  }
}
