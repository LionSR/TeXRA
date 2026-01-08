// Local imports - profile view
import { profileViewDomHandler } from './domHandlers.js';
import { profileViewState } from './profileViewState.js';
// Local imports - common
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { createMessageHandler } from '@common/messageHandlerFactory.js';

function handleUpdateProfile(message) {
  // allowedModels semantics (from backend ProfileViewMessageHandler.ts):
  // - null: all models allowed (Ultra tier)
  // - []: no models available (unauthenticated, or Max tier with failed config fetch)
  // - string[]: specific models allowed (Max tier with successful config)
  // Note: undefined fallback to [] handles potential message serialization edge cases
  const allowedModels =
    message.allowedModels === undefined ? [] : message.allowedModels;

  // Update state
  profileViewState.updateProfile({
    authenticated: message.authenticated,
    user: message.user,
    tier: message.tier,
    remoteAgents: message.remoteAgents,
    apiAccessMode: message.apiAccessMode,
    enabledProviders: message.enabledProviders ?? [],
    allowedModels,
    tierConstants: message.tierConstants,
    accessExpiresAt: message.accessExpiresAt ?? null,
  });

  // Update UI
  profileViewDomHandler.agentsTable.render({
    authenticated: message.authenticated,
    user: message.user,
    tier: message.tier,
    remoteAgents: message.remoteAgents,
    apiAccessMode: message.apiAccessMode,
    enabledProviders: message.enabledProviders ?? [],
    allowedModels,
    tierConstants: message.tierConstants,
    accessExpiresAt: message.accessExpiresAt ?? null,
  });
}

export const messageHandler = createMessageHandler({
  [PROFILE_VIEW_COMMANDS.UPDATE_PROFILE]: handleUpdateProfile,
});
