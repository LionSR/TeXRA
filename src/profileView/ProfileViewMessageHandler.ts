/**
 * Schema-driven message handler for ProfileView.
 *
 * Uses discriminated union validation at dispatch point (single safeParse)
 * with typed handler registry for type-safe message handling.
 */
import * as vscode from 'vscode';

import { getAgentsBySource, loadAgents, type AgentSource } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { selectAgentInMainView } from '@agent/remote/remoteAgentUtils';
import { PROFILE_VIEW_COMMANDS } from '@common/webview';
import * as logger from '@logger/logUtils';
import { SupabaseClient } from '@/auth/SupabaseClient';
import { AUTH_COMMANDS } from '@/auth/authCommands';
import { ULTRA_TIER, MAX_TIER } from '@/auth/config';
import { getServerSideKeyService } from '@/auth/serverKeys';
import {
  dispatchProfileViewInbound,
  type ProfileViewInboundHandlerRegistry,
  type ProfileViewInboundMessage,
  type RemoteAgent,
} from '@shared/schemas/profileViewMessages';

// Type helper for extracting specific message types
type MessageFor<C extends ProfileViewInboundMessage['command']> = Extract<
  ProfileViewInboundMessage,
  { command: C }
>;

export class ProfileViewMessageHandler {
  private readonly channel = 'ProfileViewMessageHandler';
  private _activeView: vscode.WebviewView | vscode.WebviewPanel | undefined;
  private readonly handlers: ProfileViewInboundHandlerRegistry;

  constructor(_context: vscode.ExtensionContext) {
    logger.initialize(this.channel);
    this.handlers = this.createHandlers();
  }

  private getActiveView():
    | vscode.WebviewView
    | vscode.WebviewPanel
    | undefined {
    return this._activeView;
  }

  private createHandlers(): ProfileViewInboundHandlerRegistry {
    return {
      [PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA]: () =>
        this.handleGetProfileData(),
      [PROFILE_VIEW_COMMANDS.SELECT_AGENT]: (data) =>
        this.handleSelectAgent(data),
      [PROFILE_VIEW_COMMANDS.SIGN_IN]: () => this.handleSignIn(),
      [PROFILE_VIEW_COMMANDS.SIGN_OUT]: () => this.handleSignOut(),
      [PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE]: (data) =>
        this.handleSetApiAccessMode(data),
    };
  }

  public async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    this._activeView = webviewView;

    const handled = dispatchProfileViewInbound(
      message,
      this.handlers,
      (error) => {
        logger.debug(this.channel, 'Message validation failed', {
          data: error,
        });
      },
    );

    if (
      !handled &&
      message &&
      typeof message === 'object' &&
      'command' in message
    ) {
      logger.warn(
        this.channel,
        `Unhandled command: ${(message as { command: string }).command}`,
      );
    }
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendProfileData(webview: vscode.Webview): Promise<void> {
    // Check authentication status directly - this is independent of server-side key settings
    const isAuthenticated = await SupabaseClient.isAuthenticated();

    if (!isAuthenticated) {
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

    // Prime server-side key caches (providers, tier config, user tier)
    // This returns false if user disabled server-side access, but caches are still primed
    const serverSideKeyService = getServerSideKeyService();
    const hasServerSideAccess =
      await serverSideKeyService.canUseServerSideKeys();

    // Get user details for display (email, permissions for remote agent visibility)
    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    // Fetch remote agents - RLS filters based on user's permissions
    await loadAgents();
    const remoteAgents: RemoteAgent[] = getAgentsBySource(
      'remote' as AgentSource,
    ).map((entry) => ({
      name: entry.name,
      description: entry.description || '',
      visibility: entry.visibility || ['public'],
      category: entry.category || AgentCategory.Workflow,
      supportsMultipleOutput: Boolean(entry.multiplePath),
    }));

    // Get model access settings from the service (caches already primed)
    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();
    const apiAccessMode = useIncludedAccess ? 'included' : 'personal';

    // Use service methods that encapsulate tier-specific logic
    // These handle Ultra vs Max/free tier differences internally
    const enabledProviders = hasServerSideAccess
      ? serverSideKeyService.getEffectiveProvidersForCurrentUser()
      : [];
    const allowedModels = hasServerSideAccess
      ? serverSideKeyService.getAllowedModelsForCurrentUser()
      : [];

    // Get access expiration date (call after canUseServerSideKeys primes caches)
    const accessExpiresAt = serverSideKeyService.getAccessExpirationDate();

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
      // Access expiration date (null = no expiration / lifetime access)
      accessExpiresAt: accessExpiresAt?.toISOString() ?? null,
    });
  }

  // ============================================================
  // Handler implementations
  // ============================================================

  private async handleGetProfileData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendProfileData(view.webview);
    }
  }

  private async handleSelectAgent(
    data: MessageFor<typeof PROFILE_VIEW_COMMANDS.SELECT_AGENT>,
  ): Promise<void> {
    // Use shared utility for agent selection
    await selectAgentInMainView(data.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
  }

  private async handleSignIn(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }

  private async handleSetApiAccessMode(
    data: MessageFor<typeof PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE>,
  ): Promise<void> {
    const view = this.getActiveView();

    // Update the setting (also clears cache and fires change event)
    const useIncludedAccess = data.mode === 'included';
    await getServerSideKeyService().setUseIncludedModelAccess(
      useIncludedAccess,
    );

    // Refresh profile data to reflect the change
    if (view) {
      await this.sendProfileData(view.webview);
    }

    // Show confirmation message
    const modeLabel =
      data.mode === 'included' ? 'Included Access' : 'My Own Keys';
    void vscode.window.showInformationMessage(
      `Model access changed to: ${modeLabel}`,
    );
  }
}
