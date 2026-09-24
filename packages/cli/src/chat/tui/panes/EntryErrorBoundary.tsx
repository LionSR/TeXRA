// Isolates a render failure in a single transcript entry. Without this, one
// malformed entry — bad markdown, a throwing tool renderer, an unexpected
// payload shape — would throw during render and tear down the entire
// long-lived Ink tree, ending the session. The boundary degrades the offending
// entry to a one-line marker and lets the rest of the transcript keep
// rendering.
//
// React error boundaries have no hook equivalent (getDerivedStateFromError /
// componentDidCatch are class-only), so this is a deliberate, localized
// exception to the TUI's stateless-renderer rule. Keep it minimal: the only
// state is the captured error, and the fallback never does width math or
// anything that could itself throw. The inline marker is the whole report:
// the CLI log sink is silent while Ink owns the screen, and a write to the
// terminal from here would land inside the frame.

import { Box, Text } from 'ink';
import { Component, type ReactNode } from 'react';

import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { WARNING } from '@cli/tui/ui/glyphs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

interface EntryErrorBoundaryProps {
  // Names the failed entry in the inline marker (e.g. its
  // role or "session header"). Falls back to "entry" when omitted.
  readonly label?: string;
  readonly children: ReactNode;
}

interface EntryErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: unknown;
}

function formatRenderError(error: unknown): string {
  let message: string;
  try {
    message = toErrorMessage(error);
  } catch {
    return '';
  }
  // The marker is a single line: collapse whitespace and cap length so a long
  // or multi-line message can't reflow the transcript.
  return truncateWithEllipsis(message.replaceAll(/\s+/g, ' ').trim(), 120);
}

export class EntryErrorBoundary extends Component<
  EntryErrorBoundaryProps,
  EntryErrorBoundaryState
> {
  // `hasError` is tracked separately from `error` so a thrown `null`/`undefined`
  // still latches the fallback instead of re-rendering children and looping.
  override state: EntryErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): EntryErrorBoundaryState {
    return { hasError: true, error };
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const detail = formatRenderError(this.state.error);
    return (
      <Box paddingX={1}>
        {/* Not dimmed: this is the only signal that an entry failed to
            render, and dimming the one message reporting a failure is the
            opposite of what its salience should be. */}
        <Text color={COLOR_ERROR}>
          {`${WARNING} failed to render ${this.props.label ?? 'entry'}${detail ? `: ${detail}` : ''}`}
        </Text>
      </Box>
    );
  }
}
