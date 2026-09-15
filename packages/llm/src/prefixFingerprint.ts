// Node imports
import { createHash } from 'node:crypto';

// Local imports - canonical model contract
import type { ModelOrigin, ResolvedTurn } from './turn.js';

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
