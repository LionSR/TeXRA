// Signals for the App-level foreground surfaces — the inline slash form, the
// slash-command palette, reverse search, the transcript viewer, and the
// child-control (subagents/tasks) picker. These are view-level toggles, so
// per the CLAUDE.md TUI rule they live here as signal state rather than as
// local `useState` in the components that render them.

import { signal, type Signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';
import type { ChildControlMode } from '../childControls';

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` clears this slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
export interface ActiveSlashForm {
  /** The slash command that mounted the form (for the header strip). */
  readonly commandName: string;
  /** Status-bar verb for Escape while the form owns input. Defaults to close. */
  readonly escapeAction?: string;
  /** Render the form body. Receives the close callback. */
  readonly render: (
    onDone: () => void,
    availableRows: number,
  ) => React.ReactNode;
}
export const ACTIVE_FORM: Signal.State<ActiveSlashForm | undefined> = signal<
  ActiveSlashForm | undefined
>(undefined);

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with stream-focus Tab. */
export const SLASH_PALETTE_OPEN = signal<boolean>(false);
export const REVERSE_SEARCH_OPEN = signal<boolean>(false);

/** The stream whose full-output transcript the viewer is showing, or
 *  `undefined` when the viewer is closed. ctrl+t opens it on the active
 *  stream; the Subagents picker opens it on a chosen child so each subagent's
 *  transcript is independently browsable without disturbing the main
 *  scrollback. The viewer shows that one stream's tool output untruncated and
 *  scrollable; the finalized scrollback and live region only ever show a
 *  head+tail slice. */
export const TRANSCRIPT_VIEWER_STREAM_ID = signal<StreamTabId | undefined>(
  undefined,
);

/** Which child-control picker (subagents/tasks) App is showing in the
 *  foreground, or `undefined` when neither is open. */
export const CHILD_CONTROL_MODE: Signal.State<ChildControlMode | undefined> =
  signal<ChildControlMode | undefined>(undefined);
/** Status-bar verb for Escape while the child-control picker owns input;
 *  the picker reports this as it navigates between its list and detail view. */
export const CHILD_CONTROL_ESCAPE_ACTION = signal<string>('close');
