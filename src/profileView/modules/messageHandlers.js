// Local imports - profile view
import { profileViewDomHandler } from './domHandlers.js';
import { profileViewState } from './profileViewState.js';
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

/**
 * Handles messages from the extension for the profile view.
 */
export class ProfileViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [PROFILE_VIEW_COMMANDS.UPDATE_PROFILE]: (m) =>
        this.handleUpdateProfile(m),
    };
  }

  handleUpdateProfile(message) {
    // Update state
    profileViewState.updateProfile({
      authenticated: message.authenticated,
      user: message.user,
      tier: message.tier,
      permissions: message.permissions || [],
      remoteAgents: message.remoteAgents,
      apiAccessMode: message.apiAccessMode,
      enabledProviders: message.enabledProviders || [],
    });

    // Update UI
    profileViewDomHandler.agentsTable.render({
      authenticated: message.authenticated,
      user: message.user,
      tier: message.tier,
      permissions: message.permissions || [],
      remoteAgents: message.remoteAgents,
      apiAccessMode: message.apiAccessMode,
      enabledProviders: message.enabledProviders || [],
    });
  }
}

export const messageHandler = new ProfileViewMessageHandler();
