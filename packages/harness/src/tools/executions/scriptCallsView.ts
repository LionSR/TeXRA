/**
 * Bounded projection of a background script's calls for the executions
 * tool's `/executions/{id}` summary: the slice worth a model's context, with
 * what it omitted reported so the reader knows the view is truncated.
 */

// Local imports
import type { ScriptCallCard } from '@agent/runtime/scriptRun';

const MAX_ENTRIES = 8;
const TEXT_LENGTH = 160;

function compactText(value: string | undefined): string | undefined {
  return value?.slice(0, TEXT_LENGTH);
}

/** A background script's calls by section, bounded for a model's context:
 *  sections still working first, then those with a failure, then issue
 *  order; within a section, the calls needing attention first. */
export function scriptCallsView(
  calls: readonly ScriptCallCard[],
  live: boolean,
): unknown {
  const unsettled = live ? 'running' : 'interrupted';
  const status = (call: ScriptCallCard) =>
    call.status === 'unsettled' ? unsettled : call.status;
  const rank = (call: ScriptCallCard) => {
    if (call.status === 'unsettled') return 0;
    if (call.status === 'failed') return 1;
    return 2;
  };
  const sections = [
    ...Map.groupBy(calls, (call) => call.section ?? '').entries(),
  ].map(([title, members]) => ({
    title,
    members,
    rank: Math.min(...members.map(rank)),
  }));
  const shown = sections
    .toSorted((left, right) => left.rank - right.rank)
    .slice(0, MAX_ENTRIES);
  const callView = (call: ScriptCallCard) => ({
    seq: call.seq,
    tool: call.toolName,
    status: status(call),
    attempt: call.attempt,
    ...(call.reusedFrom !== null && { reusedFrom: call.reusedFrom }),
    ...(call.error !== null && { error: compactText(call.error) }),
  });
  return {
    calls: calls.length,
    sections: shown.map(({ title, members }) => {
      const listed = members
        .toSorted((left, right) => rank(left) - rank(right))
        .slice(0, MAX_ENTRIES);
      return {
        title: title === '' ? null : compactText(title),
        calls: listed.map(callView),
        ...(members.length > listed.length && {
          omittedCalls: members.length - listed.length,
        }),
      };
    }),
    ...(sections.length > shown.length && {
      omittedSections: sections.length - shown.length,
    }),
    responseBounds: {
      maxSections: MAX_ENTRIES,
      maxCallsPerSection: MAX_ENTRIES,
    },
  };
}
