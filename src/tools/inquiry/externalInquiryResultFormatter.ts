// Local imports - inquiry storage
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

  const known: string[] = [];
  const seen = new Set<string>();

  for (const turn of [...manifest.turns].reverse()) {
    for (const link of turn.sessionLinks ?? []) {
      if (seen.has(link)) continue;
      seen.add(link);
      known.push(link);
    }
  }

  return known.length ? known : undefined;
}
