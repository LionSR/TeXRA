// Local imports - profile view
// Constants for Profile View

// Import standardized commands
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';

// Export command map for convenience
export const COMMANDS = PROFILE_VIEW_COMMANDS;

// DOM element IDs
export const ELEMENT_IDS = {
  PROFILE_INFO: 'profileInfo',
  USER_EMAIL: 'userEmail',
  USER_ID: 'userId',
  USER_TIER: 'userTier',
  NOT_AUTHENTICATED: 'notAuthenticated',
  SIGN_IN_BTN: 'signInBtn',
  REMOTE_AGENTS_SECTION: 'remoteAgentsSection',
  AGENTS_TABLE_CONTAINER: 'agentsTableContainer',
  NO_AGENTS_MESSAGE: 'noAgentsMessage',
  // API Access section (all authenticated users)
  API_ACCESS_SECTION: 'apiAccessSection',
  API_ACCESS_INCLUDED: 'apiAccessIncluded',
  API_ACCESS_PERSONAL: 'apiAccessPersonal',
  MODEL_ACCESS_INFO: 'modelAccessInfo',
  MODEL_ACCESS_SUMMARY: 'modelAccessSummary',
  ENABLED_PROVIDERS_INFO: 'enabledProvidersInfo',
  ALLOWED_MODELS_INFO: 'allowedModelsInfo',
  MODELS_LIST_CONTAINER: 'modelsListContainer',
  // Access expiration
  ACCESS_EXPIRATION_ROW: 'accessExpirationRow',
  ACCESS_EXPIRATION: 'accessExpiration',
};

// CSS class names used across modules
export const CLASS_NAMES = {
  TIER_BADGE: 'tier-badge',
  VISIBILITY_BADGE: 'visibility-badge',
  AGENT_ROW: 'agent-row',
  SELECT_BTN: 'select-btn',
  TAG: 'tag',
};

// Default values
export const DEFAULTS = {
  AGENT_CATEGORY: 'workflow',
};
