/**
 * Lit context definitions for MainView.
 *
 * Context values use Zod-derived types from shared schemas for type safety.
 */

// Third-party imports
import { createContext } from '@lit/context';

// Local imports - shared schemas (Zod-derived types)
import type {
  FileStateContextValue,
  SessionContextValue,
} from '@shared/schemas';

// Re-export types for consumers
export type { FileStateContextValue, SessionContextValue };

export const fileStateContext = createContext<FileStateContextValue>(
  'main-view-file-state',
);

export const sessionContext =
  createContext<SessionContextValue>('main-view-session');
