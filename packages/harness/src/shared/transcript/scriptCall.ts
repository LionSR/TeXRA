import { Predicate, Record as EffectRecord } from 'effect';
import { type ScriptTally } from '@shared/schemas';

const CALL_FILE_PREVIEW_LIMIT = 3;

/**
 * The files one issued call was handed, as a single clause: the editable
 * inputs by name (bounded), then how many read-only context/media files ride
 * along; undefined when it was handed none.
 */
export function formatScriptCallFiles(files: {
  readonly input: readonly string[];
  readonly context: readonly string[];
  readonly media: readonly string[];
}): string | undefined {
  const visible = files.input.slice(0, CALL_FILE_PREVIEW_LIMIT);
  const hiddenInputs = files.input.length - visible.length;
  const hiddenSuffix = hiddenInputs > 0 ? ` +${hiddenInputs}` : '';
  const parts = [
    visible.length > 0 ? `${visible.join(', ')}${hiddenSuffix}` : undefined,
    files.context.length > 0 ? `${files.context.length} context` : undefined,
    files.media.length > 0 ? `${files.media.length} media` : undefined,
  ].filter(Predicate.isNotNullish);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The outcomes a tally counts, in the order it reads them; `total` is
 *  their sum, not an outcome. */
const TALLY_OUTCOMES = EffectRecord.keys({
  ok: true,
  failed: true,
  cancelled: true,
  skipped: true,
} satisfies Record<Exclude<keyof ScriptTally, 'total'>, true>);

/** `6 ok · 1 failed · 1 cancelled` — the one spelling of a tally, by outcome,
 *  so no count can read as "done" beside a failure it includes. */
export function formatScriptTally(tally: ScriptTally): string {
  const parts = TALLY_OUTCOMES.filter((key) => tally[key] > 0).map(
    (key) => `${tally[key]} ${key}`,
  );
  return parts.length > 0 ? parts.join(' · ') : 'no calls';
}
