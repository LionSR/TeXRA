// Active text-draft registration for foreground TUI inputs.

// Third-party imports
import { createContext, useContext, useEffect, type ReactNode } from 'react';

export type DraftDiscarder = () => boolean;

export interface ActiveDraftRegistry {
  readonly register: (discard: DraftDiscarder) => () => void;
  readonly discard: () => boolean;
}

/** Keep the most recently mounted active input as the owner of draft discard. */
export function createActiveDraftRegistry(): ActiveDraftRegistry {
  const entries: Array<{ readonly discard: DraftDiscarder }> = [];

  return {
    register(discard) {
      const entry = { discard };
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    discard() {
      return entries.at(-1)?.discard() ?? false;
    },
  };
}

const ActiveDraftContext = createContext<ActiveDraftRegistry | undefined>(
  undefined,
);

export function ActiveDraftScope(props: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly registry: ActiveDraftRegistry;
}): React.JSX.Element {
  return (
    <ActiveDraftContext.Provider
      value={props.active ? props.registry : undefined}
    >
      {props.children}
    </ActiveDraftContext.Provider>
  );
}

/** Register a focused text input with the root Ctrl-C interaction policy. */
export function useActiveDraft(discard: DraftDiscarder, active: boolean): void {
  const registry = useContext(ActiveDraftContext);

  useEffect(() => {
    if (!active || !registry) return;
    return registry.register(discard);
  }, [active, discard, registry]);
}
