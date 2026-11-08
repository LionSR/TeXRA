/**
 * A run's transcript as its renderers lay it out: each stage with the rows
 * it holds, among the rows no stage holds, in first-appearance order. The
 * fold numbers stages and rows from one sequence (`seqNo`) and keeps both in
 * that order, so the layout is one pass over data the view carries.
 */
import type { Stage } from '@shared/schemas';

import type { TranscriptRow } from './transcriptRow';

type RowFields = Pick<TranscriptRow, 'id' | 'seqNo' | 'groupId'>;

/** One entry of the layout: a row no stage holds, or a stage and its rows. */
export type TimelineEntry<Row extends RowFields, S extends Stage = Stage> =
  | { readonly kind: 'row'; readonly row: Row }
  | { readonly kind: 'stage'; readonly stage: S; readonly rows: Row[] };

/** The transcript's stages, each with its rows, among its other rows. */
export function transcriptTimeline<
  Row extends RowFields,
  S extends Stage,
>(transcript: {
  readonly rows: readonly Row[];
  readonly stages: readonly S[];
}): TimelineEntry<Row, S>[] {
  const members = new Map<string, Row[]>(
    transcript.stages.map((stage) => [stage.id, []]),
  );
  const loose: Row[] = [];
  for (const row of transcript.rows) {
    const held =
      row.groupId === undefined ? undefined : members.get(row.groupId);
    if (held === undefined) loose.push(row);
    else held.push(row);
  }
  const entries: TimelineEntry<Row, S>[] = [];
  let next = 0;
  const { stages } = transcript;
  for (const row of loose) {
    while (next < stages.length && stages[next].seqNo < (row.seqNo ?? 0)) {
      const stage = stages[next];
      entries.push({ kind: 'stage', stage, rows: members.get(stage.id) ?? [] });
      next += 1;
    }
    entries.push({ kind: 'row', row });
  }
  for (const stage of stages.slice(next))
    entries.push({ kind: 'stage', stage, rows: members.get(stage.id) ?? [] });
  return entries;
}
