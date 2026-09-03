import { describe, expect, it, vi } from 'vitest';

import { resumeStreamWithRefusalNotice } from '@controllers/session/resumeStreamPresentation';
import type { StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

const resumeStream = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/resumeRun', () => ({ resumeStream }));

const STREAM = 'stream:resume-presentation' as StreamTabId;

describe('resumeStreamWithRefusalNotice', () => {
  it('presents a refusal with the shared wording', async () => {
    const session = createTestSession();
    const emit = vi.spyOn(session.interactions, 'emit').mockReturnValue(false);
    resumeStream.mockResolvedValueOnce({ failed: 'not_resumable' });

    await expect(
      resumeStreamWithRefusalNotice(STREAM, {
        session,
        executeWorkflow: vi.fn(),
      }),
    ).resolves.toBe(false);
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
  });
});
