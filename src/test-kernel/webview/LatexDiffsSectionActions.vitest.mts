// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { LatexDiffsSection } from '@webview/frontend/components/LatexDiffsSection';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function mount(): Promise<LatexDiffsSection> {
  return mountComponent<LatexDiffsSection>('latexdiffs-section');
}

/**
 * Regression coverage for the wa-button-group + tooltip consolidation onto
 * `renderLabeledActionButtonParts` (src/shared/wa/actionButtons.ts): the
 * diff-action groups must keep dispatching per-button `latexdiffs-action`
 * events and rendering one `<wa-tooltip>` per grouped button, and the
 * file-utility icon buttons (no longer delegated via
 * `data-file-action`/`data-file-type`) must keep dispatching
 * `get-current-file` / `empty-file` directly.
 */
describe('latexdiffs-section action buttons', () => {
  useLitComponentTestDom(
    () => import('@webview/frontend/components/LatexDiffsSection'),
  );

  it('renders each diff-action-group button as a wa-button with a matching sibling tooltip', async () => {
    const element = await mount();

    const mergeButton =
      element.shadowRoot?.querySelector<HTMLElement>('#mergeButton');
    expect(mergeButton).toBeTruthy();
    expect(mergeButton?.tagName).toBe('WA-BUTTON');

    const mergeTooltip = element.shadowRoot?.querySelector(
      'wa-tooltip[for="mergeButton"]',
    );
    expect(mergeTooltip).toBeTruthy();
    expect(mergeTooltip?.textContent).toContain('merging the edits');
  });

  it('dispatches latexdiffs-action with the button-specific action id on click', async () => {
    const element = await mount();
    const events: unknown[] = [];
    element.addEventListener('latexdiffs-action', (event) => {
      events.push((event as CustomEvent).detail);
    });

    const acceptButton =
      element.shadowRoot?.querySelector<HTMLElement>('#acceptButton');
    acceptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual([{ action: 'accept' }]);
  });

  it('dispatches get-current-file / empty-file directly from the file-utility buttons', async () => {
    const element = await mount();
    const currentEvents: unknown[] = [];
    const emptyEvents: unknown[] = [];
    element.addEventListener('get-current-file', (event) => {
      currentEvents.push((event as CustomEvent).detail);
    });
    element.addEventListener('empty-file', (event) => {
      emptyEvents.push((event as CustomEvent).detail);
    });

    const currentBaseButton = element.shadowRoot?.querySelector<HTMLElement>(
      '#currentBaseFileButton',
    );
    expect(currentBaseButton?.tagName).toBe('WA-BUTTON');
    currentBaseButton?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(currentEvents).toEqual([{ type: 'base' }]);

    const emptyEditedButton = element.shadowRoot?.querySelector<HTMLElement>(
      '#emptyEditedFileButton',
    );
    emptyEditedButton?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(emptyEvents).toEqual([{ type: 'edited' }]);
  });
});
