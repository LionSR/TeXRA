/**
 * The part vocabulary every provider codec reports a response in, and the
 * canonical-part algebra the turn fold applies: identity, restatement and
 * growth by appended text.
 */
// Node imports
import { isDeepStrictEqual } from 'node:util';

// Local imports - canonical model contract
import type { ResolvedTurn, TurnResult } from '../turn.js';

/** A completed provider turn: the HTTP arm of `TurnResult`. */
export type HttpTurnResult = Extract<
  TurnResult,
  { providerResponseId: string }
>;
/** One canonical content part of a completed turn. */
export type Part = HttpTurnResult['content'][number];
/** One part of a user turn or a tool result. */
export type InputPart = Extract<
  ResolvedTurn['messages'][number],
  { role: 'user' }
>['content'][number];

/**
 * What every codec reports a response as. A part opens at its position in
 * canonical shape, grows by appends and evidence, and closes. A `close` with
 * content replaces what streamed by the provider's own item; a `null` one
 * drops the part. An `open` on an open call restates its identity: each
 * field it names fills an unknown (empty) one or must agree.
 */
export type PartEvent =
  | {
      readonly kind: 'identity';
      readonly id: string | null;
      readonly model: string | null;
      readonly fingerprint?: string;
    }
  | { readonly kind: 'open'; readonly index: number; readonly part: Part }
  | {
      readonly kind: 'append';
      readonly index: number;
      /** `arguments` is a call's argument bytes; the rest are displayed. */
      readonly channel: keyof typeof GROW;
      readonly text: string;
      /** The provider item the text extends, when the wire names it. */
      readonly item?: string;
    }
  | {
      readonly kind: 'evidence';
      readonly index: number;
      readonly evidence: NonNullable<
        Extract<Part, { kind: 'reasoning' }>['evidence']
      >;
    }
  | {
      readonly kind: 'close';
      readonly index: number;
      readonly content?: Part | null;
    }
  | { readonly kind: 'usage'; readonly usage: HttpTurnResult['usage'] }
  | {
      readonly kind: 'finish';
      /** A `null` reason leaves it to the settled content: a tool-call
       *  finish when it holds calls, else a plain stop. */
      readonly finish: Pick<
        HttpTurnResult,
        'stopSequence' | 'finishEvidence' | 'refusalEvidence'
      > & { readonly finishReason: HttpTurnResult['finishReason'] | null };
      /** The provider's terminal statement of the content. */
      readonly snapshot?: readonly Part[];
    };

/** One position's part as it grows; a `null` part was dropped. */
export type Slot = {
  part: Part | null;
  closed: boolean;
  /** A call's seed arguments stand until its first streamed bytes. */
  streamedArguments: boolean;
};

const itemId = (part: Part) =>
  part.evidence != null && 'itemId' in part.evidence
    ? part.evidence.itemId
    : undefined;
const callOf = (part: Part) =>
  part.kind === 'local-call' ? [part.providerCallId, part.name] : [];

/** How a provider names a part: its item id, else its call id. */
export const keyOf = (part: Part): string | undefined =>
  itemId(part) ?? callOf(part)[0];

/** The same provider item: its kind, item id and call identity agree. */
export const sameIdentity = (left: Part, right: Part): boolean =>
  isDeepStrictEqual(
    [left.kind, itemId(left), ...callOf(left)],
    [right.kind, itemId(right), ...callOf(right)],
  );

/**
 * A restatement may omit what it repeats but never change it. Reasoning's
 * encrypted blob is excluded: OpenAI re-encrypts the same reasoning between
 * an item's done event and the terminal snapshot, and the first is kept.
 */
export const restates = (done: unknown, again: unknown): boolean =>
  typeof again !== 'object' || again === null || Array.isArray(again)
    ? isDeepStrictEqual(done, again)
    : typeof done === 'object' &&
      done !== null &&
      Object.entries(again).every(
        ([key, value]) =>
          value === undefined ||
          key === 'encryptedContent' ||
          restates(Reflect.get(done, key), value),
      );

/** Coalesce text onto the last element of the same kind. */
const coalesce = <K extends string>(
  list: readonly { readonly kind: K; readonly text: string }[],
  kind: K,
  text: string,
) => {
  const last = list.at(-1);
  return last?.kind === kind
    ? [...list.slice(0, -1), { kind, text: last.text + text }]
    : [...list, { kind, text }];
};

/** How each channel grows the one part kind it belongs to. */
const GROW = {
  text: (part: Part, text: string) =>
    part.kind === 'message'
      ? { ...part, content: coalesce(part.content, 'text', text) }
      : undefined,
  refusal: (part: Part, text: string) =>
    part.kind === 'message'
      ? { ...part, content: coalesce(part.content, 'refusal', text) }
      : undefined,
  summary: (part: Part, text: string) =>
    part.kind === 'reasoning'
      ? { ...part, summary: coalesce(part.summary, 'text', text) }
      : undefined,
  reasoning: (part: Part, text: string) =>
    part.kind === 'reasoning'
      ? { ...part, content: coalesce(part.content ?? [], 'text', text) }
      : undefined,
  arguments: (part: Part, text: string, streamed: boolean) =>
    part.kind === 'local-call'
      ? {
          ...part,
          argumentsText: (streamed ? part.argumentsText : '') + text,
        }
      : undefined,
} satisfies Record<
  string,
  (part: Part, text: string, streamed: boolean) => Part | undefined
>;

/** A slot's part grown by one append, or `undefined` when not its channel. */
export function grown(
  slot: Slot,
  channel: keyof typeof GROW,
  text: string,
): Part | undefined {
  if (slot.part === null || slot.closed) return undefined;
  const part = GROW[channel](slot.part, text, slot.streamedArguments);
  slot.streamedArguments ||= channel === 'arguments' && part !== undefined;
  return part;
}
