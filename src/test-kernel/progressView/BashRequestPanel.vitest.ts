// Third-party imports
import { assert, describe, expect, it } from 'vitest';

// Local imports
import type { BashRequestPanel } from '@ui/progress/components/BashRequestPanel';
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';
import type {
  BashRequest,
  RunId,
  RuntimeRequest,
} from '@texra-ai/harness/schemas';

// Every card shares one action row (BaseRequestPanel); the bash card is where
// it guards the most, so these pin the row's keys here.
describe('bash-request-panel', () => {
  useLitComponentTestDom(
    () => import('@ui/progress/components/BashRequestPanel'),
  );

  it('rejects on one "n", sends an opened note with it, and never answers on Escape', async () => {
    const permission: BashRequest = {
      requestId: 'bash-request-1',
      allowBypass: false,
      // cast: a fixture run id; the panel only echoes it in its answer.
      runId: 'run-1' as RunId,
      command: 'echo hi',
    };
    const element = await mountComponent<BashRequestPanel>(
      'bash-request-panel',
      { permission: { kind: 'bash', data: permission } },
    );
    // The panel answers through the shell's `runtime-request` event.
    const actions: RuntimeRequest[] = [];
    element.addEventListener('runtime-request', (event) => {
      // cast: the panel dispatches `runtime-request` as a CustomEvent of a request.
      actions.push((event as CustomEvent<RuntimeRequest>).detail);
    });

    expect(element.handleKeyboardShortcut('escape')).toBe(false);
    element.shadowRoot
      ?.querySelector<HTMLElement>('wa-button[data-action="note"]')
      ?.click();
    await element.updateComplete;
    const note = element.shadowRoot?.querySelector<
      HTMLElement & { value: string }
    >('[data-note-input]');
    assert.exists(note);
    note.value = '  use latexmk instead  ';
    // With the note open, "a" must not grant, and Escape closes the note only.
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);

    expect(element.handleKeyboardShortcut('n')).toBe(true);
    expect(actions).toEqual([
      {
        kind: 'request.decide',
        runId: 'run-1',
        requestId: 'bash-request-1',
        decision: { action: 'reject', feedback: 'use latexmk instead' },
      },
    ]);
  });
});
