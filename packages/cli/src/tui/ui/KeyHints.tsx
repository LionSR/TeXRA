// Shared footer-strip for every modal / form / palette / approval card.
//
// The footer convention: each row carries scope-specific keys first, navigation in the middle, and
// `Enter confirm · Esc cancel` last. Ad-hoc footer text is a review-blocker.

import { FACT_SEPARATOR, joinFacts } from '@texra-ai/harness/schemas';
import { Box, Text } from 'ink';

export interface KeyHint {
  /** Key glyph (e.g. `Enter`, `Ctrl-R`, `↑/↓`). */
  readonly key: string;
  /** What the key does (e.g. `confirm`, `cancel`, `cycle`). */
  readonly action: string;
}

interface KeyHintsProps {
  /** Scope-specific keys (rendered first). */
  readonly hints: readonly KeyHint[];
  /** Append the canonical `Enter confirm · Esc cancel` pair when true.
   *  Modals override to `false` when their primary affordance is different
   *  (e.g. a `y / n` prompt). */
  readonly confirmCancel?: boolean;
  /** Allow a reader footer to consume multiple rows instead of truncating. */
  readonly wrap?: boolean;
}

/** Plain-text projection of one hint. Must stay in sync with the component's
 *  rendered output below (`key action`) so width math and text-only surfaces
 *  (status-bar bindings, picker hint fitting) measure exactly what renders. */
export function keyHintText(hint: KeyHint): string {
  return `${hint.key} ${hint.action}`;
}

/** Plain-text projection of a whole hint strip, joined exactly as the
 *  component below renders it. Width math and row-budget math measure this
 *  rather than re-deriving the separator. */
export function keyHintsText(hints: readonly KeyHint[]): string {
  return joinFacts(hints.map(keyHintText));
}

/** Esc abandons what the surface was doing. */
export const CANCEL_HINT: KeyHint = Object.freeze({
  key: 'Esc',
  action: 'cancel',
});

/** Esc steps back to the surface this one was opened from. */
export const BACK_HINT: KeyHint = Object.freeze({ key: 'Esc', action: 'back' });

const DEFAULT_TAIL: readonly KeyHint[] = Object.freeze([
  Object.freeze({ key: 'Enter', action: 'confirm' }),
  CANCEL_HINT,
]);

/** How a hint names each arrow-key pair. */
export const UP_DOWN_KEYS = '↑/↓';
export const LEFT_RIGHT_KEYS = '←/→';

/** The arrow-key hint every list surface binds. */
export const NAVIGATE_HINT: KeyHint = Object.freeze({
  key: UP_DOWN_KEYS,
  action: 'navigate',
});

/** Esc closes the surface. */
export const CLOSE_HINT: KeyHint = Object.freeze({
  key: 'Esc',
  action: 'close',
});

/** The whole footer of a surface Esc only closes. */
export const CLOSE_HINTS: readonly KeyHint[] = Object.freeze([CLOSE_HINT]);

/** Enter closes a surface with nothing to choose. */
const ENTER_CLOSE_HINT: KeyHint = Object.freeze({
  key: 'Enter',
  action: 'close',
});

/** The footer of a surface with nothing to choose: either key closes it. */
export const ENTER_OR_ESC_CLOSE_HINTS: readonly KeyHint[] = Object.freeze([
  ENTER_CLOSE_HINT,
  CLOSE_HINT,
]);

/** The ↑/↓ + PgUp/PgDn pair a scrollable body binds while it can scroll. */
export function scrollKeyHints(action: string): readonly KeyHint[] {
  return [
    { key: UP_DOWN_KEYS, action },
    { key: 'PgUp/PgDn', action: 'page' },
  ];
}

/** The fullest footer a closable scroll-only reader (transcript, work plan)
 *  paints, which its row budget measures. */
export const READER_SCROLL_HINTS: readonly KeyHint[] = Object.freeze([
  ...scrollKeyHints('scroll').map((hint) => Object.freeze(hint)),
  ...CLOSE_HINTS,
]);

/** Hint spans without the surrounding dim/truncating `<Text>`. Callers that
 *  cannot use {@link KeyHints} because the strip has to share one terminal row
 *  with other content (ConfirmCard's compact title line) render these inside
 *  their own `<Text>` instead of restating the markup. */
export function keyHintSpans(
  hints: readonly KeyHint[],
): readonly React.JSX.Element[] {
  return hints.map((hint, index) => (
    <Text key={`${hint.key}-${hint.action}-${index}`}>
      {index > 0 ? FACT_SEPARATOR : ''}
      <Text bold>{hint.key}</Text> {hint.action}
    </Text>
  ));
}

export function KeyHints(props: KeyHintsProps): React.JSX.Element {
  const all =
    props.confirmCancel === false
      ? props.hints
      : [...props.hints, ...DEFAULT_TAIL];
  return (
    <Box>
      <Text dimColor wrap={props.wrap ? 'wrap' : 'truncate-end'}>
        {keyHintSpans(all)}
      </Text>
    </Box>
  );
}
