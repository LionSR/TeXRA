/**
 * The Shell (PRD one-fold-three-renderers, section 9): one record per view
 * instance, above the per-session `Surface`. It is what lets a rail row
 * choose a paper: a `Surface` is per session and cannot say which session,
 * a `SessionView` is a fact about one session, and the layer map is a
 * cache, not a selection. On the extension and the TUI it is degenerate,
 * one root and `open` of length one. Search has one home, the command
 * palette, so the record carries no needle of its own.
 */

export interface Shell {
  /** Which paper the view is showing. */
  readonly active: string;
  /** Rail order, user-arranged. */
  readonly open: readonly string[];
  /** Rail rows the user folded shut. */
  readonly collapsed: readonly string[];
}

export type ShellAction =
  | { readonly kind: 'activate'; readonly session: string }
  | { readonly kind: 'open'; readonly session: string }
  | { readonly kind: 'close'; readonly session: string }
  | {
      readonly kind: 'collapse';
      readonly session: string;
      readonly collapsed: boolean;
    };

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
  }
}
