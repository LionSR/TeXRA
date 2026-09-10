import { describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { resumeRunWithRefusalNotice } from '@controllers/session/resumeRunPresentation';
import type { RunId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

const resumeClaimedRun = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/resumeRun', () => ({ resumeClaimedRun }));

const STREAM = 'stream:resume-presentation' as RunId;

describe('resumeRunWithRefusalNotice', () => {
  it.live('presents a refusal with the shared wording', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const emit = vi
        .spyOn(session.interactions, 'emit')
        .mockReturnValue(false);
      resumeClaimedRun.mockReturnValueOnce(
        Effect.succeed({ failed: 'not_resumable' }),
      );

      expect(
        yield* resumeRunWithRefusalNotice(STREAM, {
          session,
          executeWorkflow: vi.fn(),
        }),
      ).toBe(false);
      expect(emit).toHaveBeenCalledWith(
        'requestShowInstruction',
        {
          key: 'resumeRefused',
          message:
            'This run cannot accept messages right now. Resume it, or start a new agent task.',
          showSuppress: false,
        },
        { replayWhenAttached: true },
      );
      session.dispose();
    }),
  );
});
