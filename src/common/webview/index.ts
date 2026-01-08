// Barrel export for common webview components
export {
  ModuleDescriptor,
  BaseViewContentProvider,
} from './BaseViewContentProvider';
export {
  MessageHandler,
  BaseViewMessageHandler,
  type MessageHandlerOptions,
} from './BaseViewMessageHandler';
export { BaseWebviewProvider, type PanelOptions } from './BaseWebviewProvider';
export {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
  HISTORY_VIEW_COMMANDS,
  PROFILE_VIEW_COMMANDS,
  MEMORY_VIEW_COMMANDS,
  WEBVIEW_COMMANDS,
} from './commands';
export { getSharedLocalResourceRoots } from './resourceRoots';
