/**
 * Extension webview foundations — the public surface shared by extension
 * startup and the main, progress, and settings views.
 *
 * Extension production code and kernel tests import `@common/webview` rather
 * than individual base classes or view-state helpers. Concrete view modules
 * and other files in this directory remain implementation details and are not
 * re-exported here.
 */
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
