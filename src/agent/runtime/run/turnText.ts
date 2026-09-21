import type { TurnResult } from '@texra-ai/llm/turn';

/** The assistant text of a completed turn: message parts, in order. */
export function turnText(turn: TurnResult): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');
}
