// The rounded panel every `/` form paints: a bordered column, full terminal
// width, with a colored title and a key-hint footer (`Esc close` unless the
// form names its own keys).

import { joinFacts } from '@texra-ai/worldline/schemas';
import { Text, useWindowSize } from 'ink';

import { CLOSE_HINTS, KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import {
  BORDERED_PANEL_CHROME_COLUMNS,
  BorderedPanel,
} from '@cli/tui/ui/BorderedPanel';
import { COLOR_ERROR, COLOR_HINT } from '@cli/tui/ui/colors';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';

// Before Ink reports a size (a non-TTY render), frame at a classic 80 columns.
const FORM_FRAME_FALLBACK_WIDTH = 80;

interface FormFrameProps {
  /** Border/title color. Defaults to the palette's informational hint —
   *  pass an explicit color only for a non-default state (e.g. an
   *  empty-results warning or an error transient). */
  readonly color?: string;
  readonly title: string;
  readonly children: React.ReactNode;
  /** The footer's keys, `Esc close` by default; an empty list paints no
   *  footer. */
  readonly hints?: readonly KeyHint[];
}

/** Forms span the terminal's full width, like the readers and modals. */
function formFrameWidth(columns: number | undefined): number {
  return columns != null && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : FORM_FRAME_FALLBACK_WIDTH;
}

/** Width a form frame's body paints at, inside the border. */
export function formFrameContentWidth(columns: number | undefined): number {
  return Math.max(1, formFrameWidth(columns) - BORDERED_PANEL_CHROME_COLUMNS);
}

export function FormFrame(props: FormFrameProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const hints = props.hints ?? CLOSE_HINTS;
  return (
    <BorderedPanel
      color={props.color ?? COLOR_HINT}
      title={props.title}
      width={formFrameWidth(columns)}
      footer={hints.length === 0 ? undefined : <KeyHints hints={hints} />}
    >
      {props.children}
    </BorderedPanel>
  );
}

/**
 * The loading / error transient frame every async list form renders before its
 * data resolves: a `<LoadingIndicator>` row while loading, then a red
 * `{error}` frame on failure, each with `Esc close` (the form closes on Esc
 * in both). Returns `null` once data is ready so callers fall through to
 * their real layout:
 * `const t = renderAsyncListFormTransient(...); if (t) return t;`.
 */
export function renderAsyncListFormTransient(props: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly title: string;
  readonly loadingLabel: string;
}): React.JSX.Element | null {
  if (props.loading) {
    return (
      <FormFrame title={props.title}>
        <LoadingIndicator label={props.loadingLabel} />
      </FormFrame>
    );
  }
  if (props.error !== undefined) {
    return (
      <FormFrame color={COLOR_ERROR} title={joinFacts([props.title, 'error'])}>
        <Text>{props.error}</Text>
      </FormFrame>
    );
  }
  return null;
}
