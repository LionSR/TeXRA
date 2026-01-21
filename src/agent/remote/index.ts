/**
 * Remote Agent Module
 *
 * Provides infrastructure for loading and using remote agents
 * stored in Supabase.
 */

// Core types and schemas
export {
  RemoteAgentListItemSchema,
  RemoteAgentMetadataSchema,
  type RemoteAgentListItem,
  type RemoteAgentMetadata,
  type RemoteAgentConfig,
  type RemoteAgentLoadOptions,
} from './types';

// Remote agent loader
export { RemoteAgentLoader } from './RemoteAgentLoader';

// VS Code-specific utilities
export {
  selectAgentInMainView,
  type SelectAgentResult,
} from './remoteAgentUtils';
