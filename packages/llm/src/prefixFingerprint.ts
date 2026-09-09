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
