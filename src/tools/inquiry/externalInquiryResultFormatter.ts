// Local imports - inquiry storage
import { unique } from '@utils/core';

import type { ExternalInquiryThreadManifest } from './externalInquiryStorage';

/**
 * Collect distinct external session links (most-recent-first) across all
 * turns of a thread. Used by the inquiry panel to render "known external
 * session links" so the user can continue the same outside conversation.
 */
export function collectKnownSessionLinks(
  manifest: ExternalInquiryThreadManifest | null | undefined,
): string[] | undefined {
  if (!manifest) return undefined;

  const known = unique(
    manifest.turns
      .toReversed()
      .filter((turn) => turn.kind !== 'open')
      .flatMap((turn) => turn.sessionLinks ?? []),
  );

  return known.length ? known : undefined;
}
