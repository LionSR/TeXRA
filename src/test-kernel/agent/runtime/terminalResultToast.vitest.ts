import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import type { ResultEvent } from '@agent/trace';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { aggregateId, INSTRUCTION_ACTION, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

function result(over: Partial<ResultEvent>): ResultEvent {
  return {
    type: 'run.end',
    outcome: 'failed',
    runId: 'a00101' as RunId,
    output: { category: 'toolUse', response: '', files: [] },
    ...over,
  };
}

/**
 * Publish one terminal result through the same seam every host wires and
 * return the presentation events it produced.
 */
async function toastsFor(
  event: ResultEvent,
  parent: RunId | null = null,
): Promise<{ event: string; payload: unknown }[]> {
  const session = createTestSession();
  const emitted: { event: string; payload: unknown }[] = [];
  const emit = vi.fn((name: string, payload: unknown) => {
    emitted.push({ event: name, payload });
  });
  const detachHost = Effect.runSync(session.interactions.use({ emit }));
  const detachToast = attachTerminalResultToast(session, session.interactions);
  const committed = new Promise<void>((resolve) =>
    session.onResult(() => Effect.sync(() => resolve())),
  );
  try {
    if (parent !== null) publishTestRunStart(session, parent);
    publishTestRunStart(session, event.runId, { parent });
    const { runId, ...row } = event;
    session.publish([{ ...row, aggregateId: aggregateId('run', runId) }]);
    await committed;
  } finally {
    detachToast();
    detachHost();
    await Effect.runPromise(session.dispose());
  }
  return emitted;
}

describe('terminal result presentation', () => {
  it('maps missing-api-key to an actionable instruction', async () => {
    expect(
      await toastsFor(result({ error: { kind: 'missing-api-key' } })),
    ).toMatchObject([
      {
        event: 'requestShowInstruction',
        payload: {
          key: 'missingApiKey',
          actions: [
            INSTRUCTION_ACTION.SET_API_KEY,
            INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
          ],
        },
      },
    ]);
  });

  it('shows no toast for child runs, aborts, or success', async () => {
    expect(
      await toastsFor(
        result({ error: { kind: 'unexpected' } }),
        'a00100' as RunId,
      ),
    ).toEqual([]);
    expect(
      await toastsFor(
        result({ outcome: 'cancelled', error: { kind: 'abort' } }),
      ),
    ).toEqual([]);
    expect(await toastsFor(result({ outcome: 'completed' }))).toEqual([]);
  });
});
