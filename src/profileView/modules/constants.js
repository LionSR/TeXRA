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
  TIER_INFO: 'tierInfo',
  TIER_MESSAGE: 'tierMessage',
  NOT_AUTHENTICATED: 'notAuthenticated',
  SIGN_IN_BTN: 'signInBtn',
  REMOTE_AGENTS_SECTION: 'remoteAgentsSection',
  AGENTS_TABLE_CONTAINER: 'agentsTableContainer',
  NO_AGENTS_MESSAGE: 'noAgentsMessage',
};

// CSS class names used across modules
export const CLASS_NAMES = {
  TIER_BADGE: 'tier-badge',
  VISIBILITY_BADGE: 'visibility-badge',
  AGENT_ROW: 'agent-row',
  SELECT_BTN: 'select-btn',
  TAG: 'tag',
};

// Text labels and messages
export const LABELS = {
  TIER_FREE_MESSAGE:
    'Join the researcher access program to access premium remote agents.',
  TIER_RESEARCHER_MESSAGE: 'You have access to premium remote agents.',
  NO_AGENTS_MESSAGE:
    'No remote agents available. Contact support@texra.ai for assistance.',
  NOT_AUTHENTICATED_MESSAGE: 'You are not signed in to TeXRA.',
};
