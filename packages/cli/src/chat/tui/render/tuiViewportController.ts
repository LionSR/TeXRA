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
      const target = inkRef.current;
      if (target === undefined) {
        // The first effect cascade can flush synchronously inside Ink's
        // initial render(), before it returns the instance for `inkRef`. A
        // direct repaint deferred past that point would run after `<Static>`
        // advanced its item cursor and race Ink's static-output bookkeeping,
        // so re-issue the invalidation instead: the fresh render-key change
        // remounts `<Static>` in a normal post-mount commit whose
        // layout-effect repaint runs synchronously with the instance set.
        queueMicrotask(() => {
          // If the instance still does not exist the app never mounted (or
          // is already exiting); re-invalidating would only re-enter this
          // branch forever.
          if (inkRef.current !== undefined) {
            invalidateStaticTranscriptForRepaint();
          }
        });
        return;
      }
      target.repaint(TRANSCRIPT_VIEWPORT_REPAINT_OPTIONS);
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
