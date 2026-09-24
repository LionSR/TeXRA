// Renders a markdown body through the shared `@ui/markdown` factory +
// ANSI rule overrides, then ships the result through an Ink `<Text>`. The
// renderer cache (per-host LRU) lives in `ansiMarkdown.ts` so re-renders of
// the same content during streaming reuse the cached ANSI string.

import { memo } from 'react';
import { Text } from 'ink';

import { renderAnsiMarkdown } from './ansiMarkdown';

interface MarkdownProps {
  readonly content: string;
  readonly width?: number;
  readonly colorEnabled?: boolean;
}

// Memoized: props are scalars, so unchanged entries skip even the LRU lookup
// in `renderAnsiMarkdown` when an unrelated signal re-renders the pane.
export const Markdown = memo(function Markdown(
  props: MarkdownProps,
): React.JSX.Element {
  // `renderAnsiMarkdown` trims trailing newlines so Ink doesn't add a blank
  // line at the bottom of each conversation entry; the parent
  // `<Box marginBottom={1}>` already provides separation between entries.
  return (
    <Text>
      {renderAnsiMarkdown(props.content, {
        width: props.width,
        colorEnabled: props.colorEnabled,
      })}
    </Text>
  );
});
