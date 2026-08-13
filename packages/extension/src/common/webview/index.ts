// Barrel export for common webview components
export { BundledViewContentProvider } from './BaseViewContentProvider';
export { BaseViewMessageHandler } from './BaseViewMessageHandler';
export { BaseWebviewProvider } from './BaseWebviewProvider';
export {
  SIDEBAR_VIEWS,
  getActiveSidebarView,
  setActiveSidebarView,
  type SidebarView,
} from './viewState';
export {
  getSharedLocalResourceRoots,
  getCombinedLocalResourceRoots,
} from './resourceRoots';
