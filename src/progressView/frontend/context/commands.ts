// Third-party imports
import { createContext } from '@lit/context';

export interface CommandsContextValue {
  postCommand: (command: string, payload?: Record<string, unknown>) => void;
}

export const commandsContext =
  createContext<CommandsContextValue>('progress-commands');
