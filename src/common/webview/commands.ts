/**
 * Backward-compatible re-exports of all webview command constants.
 *
 * Each command group now lives in its own domain-specific file.
 * Import directly from the domain file when possible:
 *   import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
 *   import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';
 */
export { COMMON_COMMANDS } from './commonCommands';
export { MAIN_VIEW_COMMANDS } from './mainViewCommands';
export { PROGRESS_VIEW_COMMANDS } from './progressViewCommands';
export { HISTORY_VIEW_COMMANDS } from './historyViewCommands';
export { PROFILE_VIEW_COMMANDS } from './profileViewCommands';
export { MEMORY_VIEW_COMMANDS } from './memoryViewCommands';
export { ODYSSEY_VIEW_COMMANDS } from './odysseyViewCommands';
export {
  SETTINGS_VIEW_CMD,
  SETTINGS_VIEW_COMMANDS,
} from './settingsViewCommands';
