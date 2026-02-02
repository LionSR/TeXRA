/**
 * Event bus barrel export.
 *
 * Public API:
 * - `bus`: Singleton event bus instance for emitting/subscribing to events
 * - `ProgressEventPayloads`: Type map of event names to payload types
 * - `ProgressEventBusLike`: Interface for dependency injection in event handlers
 */
export {
  bus,
  type ProgressEventBusLike,
  type ProgressEventPayloads,
} from './ProgressEventBus';
