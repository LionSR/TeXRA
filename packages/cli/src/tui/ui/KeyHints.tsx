// Shared footer-strip for every modal / form / palette / approval card.
//
// Per docs/prds/cli-tui-ink/2026-05-14-10-architecture.md § Intuitiveness conventions:
// each row carries scope-specific keys first, navigation in the middle, and
// `Enter confirm · Esc cancel` last. Ad-hoc footer text is a review-blocker.

import { Box, Text } from 'ink';

export interface KeyHint {
  /** Key glyph (e.g. `Enter`, `Ctrl-R`, `↑/↓`). */
  readonly key: string;
  /** What the key does (e.g. `confirm`, `cancel`, `cycle`). */
  readonly action: string;
}

export interface KeyHintsProps {
  /** Scope-specific keys (rendered first). */
  readonly hints: readonly KeyHint[];
  /** Append the canonical `Enter confirm · Esc cancel` pair when true.
   *  Modals override to `false` when their primary affordance is different
   *  (e.g. a `y / n` prompt). */
  readonly confirmCancel?: boolean;
  /** Allow a reader footer to consume multiple rows instead of truncating. */
  readonly wrap?: boolean;
}

export const KEY_HINT_SEPARATOR = ' · ';

/** Plain-text projection of one hint. Must stay in sync with the component's
 *  rendered output below (`key action`) so width math and text-only surfaces
 *  (status-bar bindings, picker hint fitting) measure exactly what renders. */
export function keyHintText(hint: KeyHint): string {
  return `${hint.key} ${hint.action}`;
}

const DEFAULT_TAIL: readonly KeyHint[] = [
  { key: 'Enter', action: 'confirm' },
  { key: 'Esc', action: 'cancel' },
];

/** Footer for the closable scroll-only readers (transcript, work plan). */
export const READER_SCROLL_HINTS: readonly KeyHint[] = [
  { key: '↑/↓', action: 'scroll' },
  { key: 'PgUp/PgDn', action: 'page' },
  { key: 'Esc', action: 'close' },
];

/** Hint spans without the surrounding dim/truncating `<Text>`. Callers that
 *  cannot use {@link KeyHints} because the strip has to share one terminal row
 *  with other content (ConfirmCard's compact title line) render these inside
 *  their own `<Text>` instead of restating the markup. */
export function keyHintSpans(
  hints: readonly KeyHint[],
): readonly React.JSX.Element[] {
  return hints.map((hint, index) => (
    <Text key={`${hint.key}-${hint.action}-${index}`}>
      {index > 0 ? KEY_HINT_SEPARATOR : ''}
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
