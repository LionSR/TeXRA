import type { TurnResult } from '@texra-ai/llm';

/** The assistant text of a completed turn or an assistant message: message
 *  parts, in order. */
export function turnText(turn: {
  readonly content: TurnResult['content'];
}): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');
}

/** The reasoning text of a completed turn, one part per line. */
export function turnReasoning(turn: TurnResult): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'reasoning'
        ? (part.content ?? part.summary).map((piece) => piece.text)
        : [],
    )
    .join('\n');
}
