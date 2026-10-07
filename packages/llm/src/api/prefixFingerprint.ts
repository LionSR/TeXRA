// Node imports
import { hash } from 'node:crypto';

// Local imports - canonical model contract
import type { ModelOrigin } from '../protocol.js';
import type { ResolvedTurn } from '../turn.js';

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
  return hash('sha256', encoded, 'hex');
}
