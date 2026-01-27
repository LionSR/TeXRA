/**
 * Remote Agent Module
 *
 * Provides infrastructure for loading and using remote agents
 * stored in Supabase.
 */

// Core types and schemas
export {
  RemoteAgentListItemSchema,
  type RemoteAgentListItem,
  type RemoteAgentConfig,
} from './types';

// Remote agent loader
export { RemoteAgentLoader } from './RemoteAgentLoader';

// VS Code-specific utilities
export { selectAgentInMainView } from './remoteAgentUtils';
