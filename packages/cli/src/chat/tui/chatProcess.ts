// The process an Ink tree runs its programs on, and the project it works in:
// one value per root (`texra chat`, `texra config edit`), read by every
// component that runs a program instead of passed down by hand.

// Third-party imports
import { createContext, useContext } from 'react';

// Local imports
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessRuntime } from '@texra-ai/harness/host';

export interface ChatProcess {
  /** The process runtime the tree's reads and writes run on. */
  readonly runtime: ProcessRuntime;
  /** The project's roots: its files, its storage and its settings slots. */
  readonly roots: WorkspaceRoots;
}

const ChatProcessContext = createContext<ChatProcess | undefined>(undefined);

/** Hands an Ink root's process and project to the components under it. */
export const ChatProcessProvider = ChatProcessContext.Provider;

/** The process and project of the Ink root this component renders in. */
export function useChatProcess(): ChatProcess {
  const process = useContext(ChatProcessContext);
  if (process === undefined) {
    throw new Error('No chat process: render under ChatProcessProvider.');
  }
  return process;
}
