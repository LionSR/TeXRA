import type { RoundStage, StreamStage } from '@shared/schemas';

/** The `stage.start` fact fields the normalizers below read. */
interface StageStartLike {
  readonly kind?: 'run' | 'round' | 'phase' | 'session';
  readonly label: string;
  readonly index?: number;
  readonly total?: number;
}

function boundedTotal(total: number | undefined): { total?: number } {
  return total !== undefined && total > 0 ? { total } : {};
}

/**
 * The `RoundStage` payload of a `kind: "round"` stage fact, or undefined for
 * any other kind. Single home for the index/total normalization (`index`
 * defaults to 0; a non-positive `total` is treated as unknown) that every
 * stage consumer previously cloned inline.
 */
export function roundStageFromStageStart(
  event: StageStartLike,
): RoundStage | undefined {
  if (event.kind !== 'round') return undefined;
  return { index: event.index ?? 0, ...boundedTotal(event.total) };
}

/**
 * Normalize a `stage.start` fact into the discriminated slot. `run` and
 * `session` stages structure the trace, not run progress, so they yield
 * undefined.
 */
export function streamStageFromStageStart(
  event: StageStartLike,
): StreamStage | undefined {
  if (event.kind === 'phase') {
    return {
      kind: 'phase',
      label: event.label,
      ...(event.index !== undefined ? { index: event.index } : {}),
      ...boundedTotal(event.total),
    };
  }
  const round = roundStageFromStageStart(event);
  return round && { kind: 'round', ...round };
}
