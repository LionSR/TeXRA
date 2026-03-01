/**
 * Command constants for the profile view.
 */
import { COMMON_COMMANDS } from './commonCommands';

// Profile view specific commands
export const PROFILE_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_PROFILE_DATA: 'getProfileData',
  UPDATE_PROFILE: 'updateProfile',
  SELECT_AGENT: 'selectAgent',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  // API access mode toggle (Ultra tier)
  SET_API_ACCESS_MODE: 'setApiAccessMode',
} as const;
