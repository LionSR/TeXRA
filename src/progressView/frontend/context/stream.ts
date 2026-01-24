// Third-party imports
import { createContext } from '@lit/context';

// Local imports - shared schemas
import type { StreamStatus, StreamTabId, StreamTabInfo } from '@shared/schemas';

// Local imports - agent types
import type { AgentCategoryFilter } from '@agent/types/AgentStreamTypes';

// Local imports - progress view state
import type { StreamState } from '../state/streamState';

export interface StreamContextValue {
  streams: StreamTabInfo[];
  activeStreamId: StreamTabId | null;
  activeStatus: StreamStatus;
  streamFilter: AgentCategoryFilter;
  activeStream?: StreamTabInfo;
  activeState?: StreamState;
  toolEditBypass: Record<string, boolean>;
}

export const streamContext =
  createContext<StreamContextValue>('progress-stream');
