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

function Hint({ hint }: { hint: KeyHint }): React.JSX.Element {
  return (
    <Text dimColor>
      <Text bold>{hint.key}</Text> {hint.action}
    </Text>
  );
}

export function KeyHints(props: KeyHintsProps): React.JSX.Element {
  const tail: KeyHint[] =
    props.confirmCancel === false
      ? []
      : [
          { key: 'Enter', action: 'confirm' },
          { key: 'Esc', action: 'cancel' },
        ];
  const all = [...props.hints, ...tail];
  return (
    <Box>
      {all.map((hint, i) => (
        <Text key={i}>
          {i > 0 ? <Text dimColor>{SEP}</Text> : null}
          <Hint hint={hint} />
        </Text>
      ))}
    </Box>
  );
}
