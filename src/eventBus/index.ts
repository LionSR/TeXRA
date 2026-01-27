/**
 * Event bus barrel export.
 *
 * Note: Most consumers import directly from @eventBus/ProgressEventBus.
 * The schemas are internal implementation details used only by ProgressEventBus.
 */
export {
  bus,
  type ProgressEvent,
  type ProgressEventPayloads,
  type ProgressEventBusLike,
} from './ProgressEventBus';
