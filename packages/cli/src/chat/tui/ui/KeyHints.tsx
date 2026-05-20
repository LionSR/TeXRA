// Shared footer-strip for every modal / form / palette / approval card.
//
// Per docs/prd/cli-tui-ink/10-architecture.md § Intuitiveness conventions:
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
}

const SEP = ' · ';

const DEFAULT_TAIL: readonly KeyHint[] = [
  { key: 'Enter', action: 'confirm' },
  { key: 'Esc', action: 'cancel' },
];

export function KeyHints(props: KeyHintsProps): React.JSX.Element {
  const all =
    props.confirmCancel === false
      ? props.hints
      : [...props.hints, ...DEFAULT_TAIL];
  return (
    <Box>
      <Text dimColor wrap="truncate-end">
        {all.map((hint, index) => (
          <Text key={`${hint.key}-${hint.action}-${index}`}>
            {index > 0 ? SEP : ''}
            <Text bold>{hint.key}</Text> {hint.action}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
