// Shared "work in progress" row for async transient states (list-form data
// fetches, /api status loading). Animated off the shared 1 Hz ticker
// (useLiveNowMs) — the same pattern ConversationPane's `ThinkingRow` uses for
// the hidden-reasoning liveness row — instead of an autonomous per-component
// interval. Replaces `@inkjs/ui`'s `<Spinner>`, whose own ~80ms `setInterval`
// (driven by `cli-spinners`) runs completely outside the shared clock: the
// exact per-component-interval anti-pattern the shared clock exists to avoid.

import { Box, Text } from 'ink';

import { useLiveNowMs } from '../state/useLiveNowMs';

// Plain ASCII spin cycle (not a braille cli-spinners frame set) — ticking at
// 1 Hz off the shared clock reads as a slow rotation, not a smooth spin, so a
// simple, always-safe frame set fits better than porting the 80ms glyph set.
const LOADING_FRAMES = ['|', '/', '-', '\\'] as const;

export interface LoadingIndicatorProps {
  readonly label: string;
}

export function LoadingIndicator(
  props: LoadingIndicatorProps,
): React.JSX.Element {
  const now = useLiveNowMs(true);
  const frame = LOADING_FRAMES[Math.floor(now / 1000) % LOADING_FRAMES.length];
  return (
    <Box gap={1}>
      <Text dimColor>{frame}</Text>
      <Text dimColor>{props.label}</Text>
    </Box>
  );
}
