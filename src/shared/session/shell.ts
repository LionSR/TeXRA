/**
 * The Shell (PRD one-fold-three-renderers, section 9): one record per view
 * instance, above the per-session `Surface`. It is what lets a rail row
 * choose a paper: a `Surface` is per session and cannot say which session,
 * a `SessionView` is a fact about one session, and the layer map is a
 * cache, not a selection. On the extension and the TUI it is degenerate,
 * one root and `open` of length one.
 */
import { z } from 'zod';

export interface Shell {
  /** Which paper the view is showing. */
  readonly active: string;
  /** Rail order, user-arranged. */
  readonly open: readonly string[];
  /** Rail rows the user folded shut. */
  readonly collapsed: readonly string[];
  /** The rail's search, across papers. Never persisted. */
  readonly search: string;
}

const SessionKeySchema = z.string().min(1);

export const PersistedShellSchema = z.object({
  active: SessionKeySchema,
  open: z.array(SessionKeySchema).prefault([]),
  collapsed: z.array(SessionKeySchema).prefault([]),
});
export type PersistedShell = z.infer<typeof PersistedShellSchema>;

export function emptyShell(active: string): Shell {
  return { active, open: [active], collapsed: [], search: '' };
}

export function shellFromPersisted(persisted: PersistedShell): Shell {
  const open = persisted.open.includes(persisted.active)
    ? persisted.open
    : [persisted.active, ...persisted.open];
  return {
    active: persisted.active,
    open,
    collapsed: persisted.collapsed.filter((key) => open.includes(key)),
    search: '',
  };
}

export function toPersistedShell(shell: Shell): PersistedShell {
  return {
    active: shell.active,
    open: [...shell.open],
    collapsed: [...shell.collapsed],
  };
}

export type ShellAction =
  | { readonly kind: 'activate'; readonly session: string }
  | { readonly kind: 'open'; readonly session: string }
  | { readonly kind: 'close'; readonly session: string }
  | {
      readonly kind: 'collapse';
      readonly session: string;
      readonly collapsed: boolean;
    }
  | { readonly kind: 'search'; readonly value: string };

export function applyShellAction(shell: Shell, action: ShellAction): Shell {
  switch (action.kind) {
    case 'activate':
      return shell.open.includes(action.session)
        ? { ...shell, active: action.session }
        : {
            ...shell,
            active: action.session,
            open: [...shell.open, action.session],
          };
    case 'open':
      return shell.open.includes(action.session)
        ? shell
        : { ...shell, open: [...shell.open, action.session] };
    case 'close': {
      const open = shell.open.filter((key) => key !== action.session);
      if (open.length === 0) return shell;
      return {
        ...shell,
        open,
        collapsed: shell.collapsed.filter((key) => key !== action.session),
        active: shell.active === action.session ? open[0] : shell.active,
      };
    }
    case 'collapse': {
      const without = shell.collapsed.filter((key) => key !== action.session);
      return {
        ...shell,
        collapsed: action.collapsed ? [...without, action.session] : without,
      };
    }
    case 'search':
      return { ...shell, search: action.value };
  }
}
