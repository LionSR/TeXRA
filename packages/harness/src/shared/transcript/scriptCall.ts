import { Number as Num, Record as EffectRecord } from 'effect';
import { type ScriptTally } from '@shared/schemas';
import { formatClippedList, joinFacts } from '@utils/text/stringUtils';

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
  return (
    joinFacts([
      files.input.length > 0 &&
        formatClippedList(files.input, CALL_FILE_PREVIEW_LIMIT),
      files.context.length > 0 && `${files.context.length} context`,
      files.media.length > 0 && `${files.media.length} media`,
    ]) || undefined
  );
}

/** The outcomes a tally counts, in the order it reads them. */
const TALLY_OUTCOMES = EffectRecord.keys({
  ok: true,
  failed: true,
  cancelled: true,
  skipped: true,
} satisfies Record<keyof ScriptTally, true>);

/** How many calls a tally counts: every call ended under one outcome. */
export const tallyTotal = (tally: ScriptTally): number =>
  Num.sumAll(TALLY_OUTCOMES.map((key) => tally[key]));

/** `6 ok · 1 failed · 1 cancelled` — the one spelling of a tally, by outcome,
 *  so no count can read as "done" beside a failure it includes. */
export function formatScriptTally(tally: ScriptTally): string {
  return (
    joinFacts(
      TALLY_OUTCOMES.filter((key) => tally[key] > 0).map(
        (key) => `${tally[key]} ${key}`,
      ),
    ) || 'no calls'
  );
}
