import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Third-party imports
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { getDefaultToolRegistry } from '@tools/registry';

/** The review sink a host attaches, derived from the port. */
type ReportReviewIssueSink = NonNullable<HostInteractions['reportReviewIssue']>;

const REPORT = {
  file: 'src/x.ts',
  startLine: 5,
  severity: 'critical',
  title: 'Broken loop',
  description: 'Off-by-one in bounds.',
} as const;

let detachHostInteractions = (): void => {};

/** Attach a review sink the way a host does: as a session capability. */
function useReviewSink(sink: ReportReviewIssueSink): void {
  detachHostInteractions();
  detachHostInteractions = defaultSession().interactions.use({
    reportReviewIssue: sink,
  });
}

function useAcceptingSink() {
  const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
  useReviewSink(sink);
  return { sink, tool: getDefaultToolRegistry().get('report_review_issue')! };
}

describe('ReportReviewIssueTool', () => {
  afterEach(() => {
    detachHostInteractions();
    detachHostInteractions = () => undefined;
  });

  it.effect('runs each finding to the sink immediately and unchanged', () =>
    Effect.gen(function* () {
      const { sink, tool } = useAcceptingSink();
      const first = { ...REPORT, endLine: 7 };
      const second = {
        ...REPORT,
        file: 'src/y.ts',
        startLine: 11,
        title: 'Dropped result',
      };

      yield* tool.call(first);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenLastCalledWith({
        ...first,
        suggestion: undefined,
      });

      yield* tool.call(second);

      expect(sink).toHaveBeenCalledTimes(2);
      expect(sink).toHaveBeenLastCalledWith({
        ...second,
        endLine: undefined,
        suggestion: undefined,
      });
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect(
    'reports that agent review is unavailable when no host serves it',
    () =>
      Effect.gen(function* () {
        const tool = getDefaultToolRegistry().get('report_review_issue')!;

        const result = yield* tool.call(REPORT);

        expect(result).toMatchObject({
          summary: 'Review issue not accepted',
          output: expect.stringContaining('not available'),
        });
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect(
    'surfaces the sink rejection reason when a review session refuses it',
    () =>
      Effect.gen(function* () {
        useReviewSink(() => ({
          accepted: false,
          reason: 'No agent review session is collecting issues.',
        }));
        const tool = getDefaultToolRegistry().get('report_review_issue')!;

        const result = yield* tool.call(REPORT);

        expect(result).toMatchObject({
          summary: 'Review issue not accepted',
          output: expect.stringContaining('No agent review session'),
        });
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect('rejects invalid input before reaching the sink', () =>
    Effect.gen(function* () {
      const { sink, tool } = useAcceptingSink();

      const result = yield* tool.call({ ...REPORT, severity: 'fatal' });

      expect(result).toMatchObject({ status: 'error' });
      expect(sink).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
