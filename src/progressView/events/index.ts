// Barrel export for progress view events
export { withEventErrorHandling } from './errorHandling';
export { ProgressEventHandler, type UICallbacks } from './ProgressEventHandler';
export { registerUIEvents } from './UIEvents';

// Domain-specific event handlers (modular, focused files)
export { type EventHandlerContext } from './EventHandlerContext';
export { registerLogEventHandlers } from './LogEventHandlers';
export { registerOutputEventHandlers } from './OutputEventHandlers';
export { registerUsageEventHandlers } from './UsageEventHandlers';
export { registerTodoEventHandlers } from './TodoEventHandlers';
