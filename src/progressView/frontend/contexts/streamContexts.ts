// Third-party imports
import { createContext } from '@lit/context';

// Local imports - progress view
import type { FollowupOptionsState, StreamState } from '../store';

// Local imports - progress view components
import type { PromptState } from '../components/PromptOverlay';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

export interface StreamContextValue {
  streamInfo: StreamTabInfo | null;
  streamState: StreamState | null;
  runId: string | null;
  followupOptions: FollowupOptionsState | null;
}

export const streamStateContext = createContext<StreamContextValue>(
  'progress-stream-state',
);

export const promptsContext = createContext<PromptState[]>('progress-prompts');
