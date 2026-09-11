import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import type { ResultEvent } from '@agent/trace';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { INSTRUCTION_ACTION, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

function result(over: Partial<ResultEvent>): ResultEvent {
  return {
    type: 'result',
    outcome: 'failed',
    runId: 'a00101' as RunId,
    agentName: 'assistant',
    category: 'toolUse',
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
    return true;
  });
  const detachHost = session.interactions.use({ emit, cancel: vi.fn() });
  const detachToast = attachTerminalResultToast(session, session.interactions);
  const committed = new Promise<void>((resolve) =>
    session.onResult(() => resolve()),
  );
  try {
    if (parent !== null) publishTestRunStart(session, parent);
    publishTestRunStart(session, event.runId, { parent });
    session.publishRunEvent(event.runId, event);
    await committed;
  } finally {
    detachToast();
    detachHost();
    session.dispose();
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

  it('maps disk-full and unexpected to error toasts carrying the message', async () => {
    expect(
      await toastsFor(
        result({ error: { kind: 'disk-full', message: 'No space left' } }),
      ),
    ).toEqual([
      { event: 'requestShowError', payload: { message: 'No space left' } },
    ]);

    expect(
      await toastsFor(
        result({ error: { kind: 'unexpected', message: 'Boom' } }),
      ),
    ).toEqual([{ event: 'requestShowError', payload: { message: 'Boom' } }]);
  });

  it('maps context-window to an error toast, defaulting to remediation copy', async () => {
    expect(
      await toastsFor(
        result({
          error: { kind: 'context-window', message: 'Conversation too long.' },
        }),
      ),
    ).toEqual([
      {
        event: 'requestShowError',
        payload: { message: 'Conversation too long.' },
      },
    ]);

    const [defaulted] = await toastsFor(
      result({ error: { kind: 'context-window' } }),
    );
    const message = (defaulted?.payload as { message?: string } | undefined)
      ?.message;
    expect(message).toContain('context window');
    expect(message).toContain('reduce attached files');
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
