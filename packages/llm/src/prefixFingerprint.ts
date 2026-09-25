// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model contract
import type { ResolvedTurn } from './turn.js';
import type { ModelOrigin } from './protocol.js';
import type { RemoteOperation } from './errors.js';

/** Turn protocols a provider origin can name; an editor binding names none. */
type OriginProtocol = Exclude<ModelOrigin['protocol'], 'vscode-lm'>;

/** Versioned provider prefixes use sorted entries followed by ECMAScript JSON enumeration. */
export function prefixFingerprint(
  domain: string,
  origin: ModelOrigin,
  system: string | undefined,
  messages: ResolvedTurn['messages'],
): string {
  const encoded = JSON.stringify(
    [domain, origin, system ?? null, messages],
    (_key, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : Number(left > right),
        ),
      );
    },
  );
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/**
 * The digest a submission records on its accepted operation: origin, system
 * text and admitted history, hashed with the function a continuation's prefix
 * fingerprint uses. It covers the input half of that prefix, which is the half
 * a resume rebuilds and can therefore get wrong; the reply does not exist yet.
 */
export function admittedFingerprint(
  domain: string,
  turn: Extract<ResolvedTurn, { protocol: OriginProtocol }>,
): string {
  return prefixFingerprint(
    domain,
    {
      protocol: turn.protocol,
      codecVersion: turn.codecVersion,
      requestedModel: turn.requestedModel,
      deployment: turn.deployment,
    },
    turn.system,
    turn.messages,
  );
}

/**
 * Whether an observed completion may leave a continuation anchor.
 *
 * The operation records what the provider was actually given. A resume
 * rebuilds the turn from the caller's current system text, so a drifted
 * rebuild still gets its result but must leave no anchor: the next round then
 * resends the transcript instead of chaining on instructions the answer never
 * saw. The admitted storage mode is part of what makes an anchor safe: a turn
 * re-derived stored for a temporary operation must not chain.
 */
export const canChain = (
  domain: string,
  turn: Parameters<typeof admittedFingerprint>[1] & {
    readonly controls: { readonly store: boolean };
  },
  operation: RemoteOperation,
): Effect.Effect<boolean> =>
  turn.controls.store === operation.store &&
  admittedFingerprint(domain, turn) === operation.admittedFingerprint
    ? Effect.succeed(true)
    : Effect.as(
        Effect.logWarning(
          `The admitted inputs of background operation ${operation.providerResponseId} changed since it was accepted; its completion leaves no continuation.`,
        ),
        false,
      );
