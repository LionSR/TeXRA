// Node imports
import { createHash } from 'node:crypto';

// Local imports - canonical model contract
import type { ModelOrigin, ResolvedTurn } from './turn.js';

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
 * A non-secret name for the account a credential acts as on one endpoint of
 * one protocol: a SHA-256 digest of the three, never the credential itself
 * (the run binding names its wire route the same way). A provider file id is
 * valid only inside the account that uploaded it, so a receipt carries this
 * and only a binding that computes the same value sends the id.
 */
export function issuerFingerprint(
  protocol: string,
  endpoint: string,
  credential: string,
): string {
  return createHash('sha256')
    .update(`texra-file-issuer-v1\0${protocol}\0${endpoint}\0${credential}`)
    .digest('hex');
}
