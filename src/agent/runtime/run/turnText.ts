import type { TurnResult } from '@texra-ai/llm/turn';

/** The assistant text of a completed turn: message parts, in order. */
export function turnText(turn: TurnResult): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');
}

/** The reasoning text of a completed turn, one part per line. */
export function turnReasoning(turn: TurnResult): string {
  if (turn.kind !== 'http') return '';
  return turn.content
    .flatMap((part) =>
      part.kind === 'reasoning'
        ? (part.content ?? part.summary).map((piece) => piece.text)
        : [],
    )
    .join('\n');
}
