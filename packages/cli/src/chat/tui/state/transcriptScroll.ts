export interface TranscriptScrollWindow {
  readonly lineCount: number;
  readonly viewRows: number;
}

export interface TranscriptScrollState {
  readonly offset: number;
  readonly followBottom: boolean;
}

export function maxTranscriptScrollOffset({
  lineCount,
  viewRows,
}: TranscriptScrollWindow): number {
  return Math.max(0, Math.floor(lineCount) - Math.max(1, Math.floor(viewRows)));
}

export function clampTranscriptScrollOffset(
  offset: number,
  window: TranscriptScrollWindow,
): number {
  return Math.max(0, Math.min(maxTranscriptScrollOffset(window), offset));
}

export function initialTranscriptScrollState(
  window: TranscriptScrollWindow,
): TranscriptScrollState {
  return {
    offset: maxTranscriptScrollOffset(window),
    followBottom: true,
  };
}

export function scrollTranscriptToOffset(
  window: TranscriptScrollWindow,
  nextOffset: number,
): TranscriptScrollState {
  const offset = clampTranscriptScrollOffset(nextOffset, window);
  return {
    offset,
    followBottom: offset >= maxTranscriptScrollOffset(window),
  };
}

export function moveTranscriptScrollState(
  state: TranscriptScrollState,
  window: TranscriptScrollWindow,
  deltaRows: number,
): TranscriptScrollState {
  return scrollTranscriptToOffset(window, state.offset + deltaRows);
}

export function syncTranscriptScrollState(
  state: TranscriptScrollState,
  window: TranscriptScrollWindow,
): TranscriptScrollState {
  const offset = state.followBottom
    ? maxTranscriptScrollOffset(window)
    : clampTranscriptScrollOffset(state.offset, window);
  return offset === state.offset ? state : { ...state, offset };
}
