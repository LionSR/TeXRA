/**
 * The protocol-neutral rules of a stored continuation: the prefix an anchor
 * covers after a turn, and whether an incoming anchor still covers the
 * turn's history. A protocol adds its own covered count and request field.
 */
// Node imports
import { hash } from 'node:crypto';

// Third-party imports
import { Order, Predicate } from 'effect';

// Local imports - canonical model contract
import { sameModelOrigin, type ModelOrigin } from '../protocol.js';
import type { ResolvedTurn } from '../turn.js';

/**
 * JSON with every object's keys in sorted order, so one value serialized in
 * two key orders gives one text. A stored anchor's fingerprint is this
 * text's hash: its bytes must not change.
 */
export const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    Predicate.isObject(field)
      ? Object.fromEntries(
          Object.entries(field).toSorted(([left], [right]) =>
            Order.String(left, right),
          ),
        )
      : field,
  ) ?? 'null';

/** A versioned provider prefix: its sorted JSON, hashed. */
function prefixFingerprint(
  domain: string,
  origin: ModelOrigin,
  system: string | undefined,
  messages: ResolvedTurn['messages'],
): string {
  return hash(
    'sha256',
    sortedJson([domain, origin, system ?? null, messages]),
    'hex',
  );
}

/** The turn's history and system input. */
type History = Pick<ResolvedTurn, 'messages' | 'system'>;

/**
 * The prefix an anchor stored after `turn` covers: its messages and the
 * answer `content` the model of `origin` gave, fingerprinted under `domain`.
 */
export function anchoredPrefix(
  domain: string,
  origin: ModelOrigin,
  turn: History,
  content: Extract<
    ResolvedTurn['messages'][number],
    { readonly role: 'assistant' }
  >['content'],
) {
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    { role: 'assistant', origin, content },
  ];
  return {
    prefix,
    coveredMessages: prefix.length,
    prefixFingerprint: prefixFingerprint(domain, origin, turn.system, prefix),
  };
}

/**
 * The history's entries `continuation` covers, or undefined when it no
 * longer covers them: it must be the binding's own (`origin`), cover no more
 * entries than the history holds, and carry the fingerprint of exactly
 * those entries and the system input.
 */
export function coveredPrefix(
  domain: string,
  origin: ModelOrigin,
  turn: History,
  continuation: {
    readonly origin: ModelOrigin;
    readonly coveredMessages: number;
    readonly prefixFingerprint: string;
  },
): ResolvedTurn['messages'] | undefined {
  const prefix = turn.messages.slice(0, continuation.coveredMessages);
  return sameModelOrigin(continuation.origin, origin) &&
    continuation.coveredMessages <= turn.messages.length &&
    continuation.prefixFingerprint ===
      prefixFingerprint(domain, origin, turn.system, prefix)
    ? prefix
    : undefined;
}
