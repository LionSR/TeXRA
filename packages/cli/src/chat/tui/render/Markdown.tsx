// Renders a markdown body through the shared `@shared/markdown` factory +
// ANSI rule overrides, then ships the result through an Ink `<Text>`. The
// renderer cache (per-host LRU) lives in `ansiMarkdown.ts` so re-renders of
// the same content during streaming reuse the cached ANSI string.

import { Text } from 'ink';

import { renderAnsiMarkdown } from './ansiMarkdown';

export interface MarkdownProps {
  readonly content: string;
  readonly width?: number;
}

export function Markdown(props: MarkdownProps): React.JSX.Element {
  // `renderAnsiMarkdown` trims trailing newlines so Ink doesn't add a blank
  // line at the bottom of each conversation entry; the parent
  // `<Box marginBottom={1}>` already provides separation between entries.
  const rendered = renderAnsiMarkdown(props.content, { width: props.width });
  return <Text>{rendered}</Text>;
}
