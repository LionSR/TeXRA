/**
 * Stream status constants shared across agent runtime and UI layers.
 *
 * RE-EXPORT from @shared/status for backward compatibility.
 * New code should import directly from '@shared/status'.
 *
 * @deprecated Import from '@shared/status' instead
 */
export {
  STREAM_STATUS,
  StreamStatusSchema,
  TaskGroupStatusSchema,
  type StreamStatus,
  type TaskGroupStatus,
} from '@shared/status';
