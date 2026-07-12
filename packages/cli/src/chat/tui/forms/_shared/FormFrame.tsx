// Shared rounded panel used by `/`-form transient states (loading, error, and
// empty). Replaces the per-form `XFrame` wrappers that all rendered the same
// bordered column with a colored title and an `Esc close` footer.

import { Text, useWindowSize } from 'ink';

import { KeyHints, type KeyHint } from '@cli/chat/tui/ui/KeyHints';
import { BorderedPanel } from '@cli/chat/tui/ui/BorderedPanel';
import { COLOR_ERROR, COLOR_HINT } from '@cli/chat/tui/ui/colors';
import { LoadingIndicator } from '@cli/chat/tui/ui/LoadingIndicator';
import { FORM_FRAME_MAX_WIDTH } from '@cli/chat/tui/ui/theme';
import { clamp } from '@utils/core';

export interface FormFrameProps {
  /** Border/title color. Defaults to the palette's informational hint —
   *  pass an explicit color only for a non-default state (e.g. an
   *  empty-results warning or an error transient). */
  readonly color?: string;
  readonly title: string;
  readonly children: React.ReactNode;
  /**
   * Append the canonical `Esc close` footer. Forms whose transient states
   * carry their own footer (or none, like `/tools`) pass `false`.
   */
  readonly showCloseHint?: boolean;
}

export function formFrameWidth(columns: number | undefined): number {
  const normalized =
    columns != null && Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : FORM_FRAME_MAX_WIDTH;
  return clamp(normalized, 1, FORM_FRAME_MAX_WIDTH);
}

export function FormFrame(props: FormFrameProps): React.JSX.Element {
  const { columns } = useWindowSize();

  return (
    <BorderedPanel
      color={props.color ?? COLOR_HINT}
      title={props.title}
      width={formFrameWidth(columns)}
      footer={
        props.showCloseHint === false ? undefined : (
          <KeyHints
            hints={[{ key: 'Esc', action: 'close' }]}
            confirmCancel={false}
          />
        )
      }
    >
      {props.children}
    </BorderedPanel>
  );
}

/**
 * The loading / error transient frame every async list form rendered before its
 * data resolved: a cyan `<LoadingIndicator>` row while loading, then a red
 * `{error}` frame on failure. Returns `null` once data is ready so callers
 * fall through to their real layout:
 * `const t = renderAsyncListFormTransient(...); if (t) return t;`.
 * `showCloseHint` is forwarded to `FormFrame` so each form keeps its existing
 * footer behaviour (forms with their own footer pass `false`).
 */
export function renderAsyncListFormTransient(props: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly title: string;
  readonly loadingLabel: string;
  readonly showCloseHint?: boolean;
}): React.JSX.Element | null {
  if (props.loading) {
    return (
      <FormFrame title={props.title} showCloseHint={props.showCloseHint}>
        <LoadingIndicator label={props.loadingLabel} />
      </FormFrame>
    );
  }
  if (props.error !== undefined) {
    return (
      <FormFrame
        color={COLOR_ERROR}
        title={`${props.title} - error`}
        showCloseHint={props.showCloseHint}
      >
        <Text>{props.error}</Text>
      </FormFrame>
    );
  }
  return null;
}

export function CompactFormKeyHints(props: {
  readonly primary: KeyHint;
  readonly escapeAction?: string;
}): React.JSX.Element {
  return (
    <KeyHints
      hints={[
        { key: '↑/↓', action: 'navigate' },
        props.primary,
        { key: 'Esc', action: props.escapeAction ?? 'close' },
      ]}
      confirmCancel={false}
    />
  );
}
