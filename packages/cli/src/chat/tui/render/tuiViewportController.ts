import { invalidateStaticTranscriptForRepaint } from '../state/staticTranscriptRepaint';

export interface TuiRepaintOptions {
  readonly clearScrollback?: boolean;
  readonly preserveStatic?: boolean;
}

export interface TuiRepaintTarget {
  repaint(options: TuiRepaintOptions): void;
}

/** Every static-transcript invalidation uses replace semantics: clear the
 *  terminal (viewport + scrollback) and set Ink's `fullStaticOutput` to the
 *  freshly rendered bounded tail. Callers must have remounted `<Static>` via
 *  a render-key change first; otherwise `staticOutput` is empty and the tail
 *  would be dropped. */
const TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS = {
  clearScrollback: true,
  preserveStatic: false,
} satisfies TuiRepaintOptions;

export interface TuiViewportController {
  readonly repaintTranscript: () => void;
  readonly repaintAfterTerminalResume: () => void;
}

export function createTuiViewportController(inkRef: {
  readonly current?: TuiRepaintTarget;
}): TuiViewportController {
  return {
    repaintTranscript(): void {
      inkRef.current?.repaint(TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS);
    },
    repaintAfterTerminalResume(): void {
      // Terminal resume cannot safely call repaint(TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS)
      // directly: the static-transcript epoch signal notifies through a
      // microtask, so the remounted `<Static>` is not committed yet and
      // preserveStatic:false would drop the retained tail. Bumping the epoch
      // makes StaticConversationTranscript remount `<Static>` and its
      // onRenderKeyChange handler apply the same replace-semantics repaint
      // after commit. There is no append-style resume repaint anymore.
      invalidateStaticTranscriptForRepaint();
    },
  };
}
