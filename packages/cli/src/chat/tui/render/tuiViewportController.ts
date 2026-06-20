import type { TranscriptViewportChange } from '../state/transcriptViewportMode';

export interface TuiRepaintOptions {
  readonly clearScrollback?: boolean;
  readonly preserveStatic?: boolean;
}

export interface TuiRepaintTarget {
  repaint(options: TuiRepaintOptions): void;
}

const TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS = {
  clearScrollback: true,
  preserveStatic: false,
} satisfies TuiRepaintOptions;

const TERMINAL_RESUME_REPAINT_OPTIONS = {
  clearScrollback: true,
} satisfies TuiRepaintOptions;

export interface TuiViewportController {
  readonly handleTranscriptViewportChange: (
    change: TranscriptViewportChange,
  ) => void;
  readonly repaintAfterTerminalResume: () => void;
}

export function createTuiViewportController(inkRef: {
  readonly current?: TuiRepaintTarget;
}): TuiViewportController {
  return {
    handleTranscriptViewportChange(): void {
      inkRef.current?.repaint(TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS);
    },
    repaintAfterTerminalResume(): void {
      inkRef.current?.repaint(TERMINAL_RESUME_REPAINT_OPTIONS);
    },
  };
}
