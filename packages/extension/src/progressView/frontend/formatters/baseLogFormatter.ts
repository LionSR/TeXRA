/**
 * The one result type every transcript-row formatter returns.
 *
 * Formatters paint a `TranscriptRow` (`@shared/transcript`); they never derive
 * membership, streaming state, or output policy themselves — those already
 * live on the row.
 */

import type { TemplateResult } from 'lit';

/** A painted row, or `null` when this row renders nothing in this host. */
export type FormatResult = TemplateResult | null;
