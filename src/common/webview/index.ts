// Barrel export for common webview components
export { BaseViewContentProvider } from './BaseViewContentProvider';
export { BaseViewMessageHandler } from './BaseViewMessageHandler';
export { BaseWebviewProvider } from './BaseWebviewProvider';
export {
  TEXRA_ACTIVE_VIEW_CONTEXT_KEY,
  SIDEBAR_VIEWS,
  getActiveSidebarView,
  setActiveSidebarView,
  type SidebarView,
} from './viewState';
export {
  getSharedLocalResourceRoots,
  getCombinedLocalResourceRoots,
} from './resourceRoots';
