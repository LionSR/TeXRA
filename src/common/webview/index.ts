// Barrel export for common webview components
export { BaseViewContentProvider } from './BaseViewContentProvider';
export { BaseViewMessageHandler } from './BaseViewMessageHandler';
export { BaseWebviewProvider } from './BaseWebviewProvider';
export {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
  HISTORY_VIEW_COMMANDS,
  PROFILE_VIEW_COMMANDS,
  MEMORY_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from './commands';
export {
  TEXRA_ACTIVE_VIEW_CONTEXT_KEY,
  TEXRA_VIEW_CONTAINER_ID,
  TEXRA_VIEW_CONTAINER_COMMAND_ID,
  TEXRA_VIEW_IDS,
  SIDEBAR_VIEWS,
  getActiveSidebarView,
  ensureTeXRAViewsCoLocated,
  setActiveSidebarView,
  type SidebarView,
} from './viewState';
export { getSharedLocalResourceRoots } from './resourceRoots';
