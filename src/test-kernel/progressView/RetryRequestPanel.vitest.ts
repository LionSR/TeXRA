// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { RetryRequestPanel } from '@progressView/frontend/components/RetryRequestPanel';
import type { ProviderErrorPartial } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/RetryRequestPanel'),
);

function createRetryPermission(
  overrides: Partial<RetryRequestPanel['permission']['data']> = {},
): RetryRequestPanel['permission'] {
  return {
    kind: PERMISSION_KIND.RETRY,
    data: {
      requestId: 'retry-1',
      streamId: 'stream-1',
      operation: 'model request',
      model: 'test-model',
      errorMessage: 'Provider quota exhausted',
      errorDetails: {
        exhaustionReason: 'upstream-credit',
        userRetryable: true,
      },
      ...overrides,
    },
  };
}

function mountPanel(
  overrides?: Partial<RetryRequestPanel['permission']['data']>,
): Promise<RetryRequestPanel> {
  return mountComponent<RetryRequestPanel>('retry-request-panel', {
    permission: createRetryPermission(overrides),
  });
}

// `formatRetryDetails` is private; TS-private is not runtime-enforced, and
// this pure-string-formatting logic doesn't need a full render to verify.
function formatRetryDetails(
  element: RetryRequestPanel,
  details: ProviderErrorPartial,
): string | null {
  const format = (
    element as unknown as {
      formatRetryDetails: (details: ProviderErrorPartial) => string | null;
    }
  ).formatRetryDetails;
  return format.call(element, details);
}

/** Format a user-retryable direct-model error carrying partial output. */
function formatPartialOutput(
  element: RetryRequestPanel,
  partialText: string,
): string {
  const text = formatRetryDetails(element, {
    userRetryable: true,
    partialText,
  });
  if (text === null) {
    throw new Error('Expected formatted partial output');
  }
  return text;
}

/** The last formatted line, which carries the (possibly truncated) tail. */
function tailLine(text: string): string {
  return text.split('\n').at(-1) ?? '';
}

/** Rendered action buttons' `data-action` ids, in DOM order. */
function actionButtonIds(element: RetryRequestPanel): (string | null)[] {
  const buttons = [
    ...(element.shadowRoot?.querySelectorAll(
      '.retry-request__actions wa-button',
    ) ?? []),
  ];
  return buttons.map((button) => button.getAttribute('data-action'));
}

describe('retry-request-panel', () => {
  it('does not offer the API-key switch for a Kimi Code-exclusive model', async () => {
    const element = await mountPanel({
      model: 'kimiCoding',
      errorDetails: {
        exhaustionReason: 'kimi-code-subscription',
        userRetryable: true,
      },
    });

    expect(actionButtonIds(element)).toEqual(['retry', 'cancel']);
  });

  it('does not map the k shortcut to the API-key switch for exclusive models', async () => {
    const element = await mountPanel({
      model: 'kimiCoding',
      errorDetails: {
        exhaustionReason: 'kimi-code-subscription',
        userRetryable: true,
      },
    });
    const actions = recordPermissionActions(element);

    expect(element.handleKeyboardShortcut('k')).toBe(false);
    expect(element.handleKeyboardShortcut('r')).toBe(true);

    expect(actions).toEqual([{ action: 'retry' }]);
  });

  it('offers the API-key switch for an exclusive model on upstream-credit depletion', async () => {
    const element = await mountPanel({
      model: 'kimiCoding',
      errorDetails: {
        exhaustionReason: 'upstream-credit',
        userRetryable: true,
      },
    });

    expect(actionButtonIds(element)).toEqual([
      'useOwnApiKey',
      'retry',
      'cancel',
    ]);
  });

  it('marks retry action buttons with action ids for shared sizing styles', async () => {
    const element = await mountPanel();

    expect(actionButtonIds(element)).toEqual([
      'useOwnApiKey',
      'retry',
      'cancel',
    ]);
  });

  it('distinguishes a fresh direct-model run from retrying Copilot', async () => {
    const element = await mountPanel({
      requestId: 'copilot-retry',
      model: 'sonnet46',
      errorMessage: 'Copilot quota exhausted',
      errorDetails: {
        exhaustionReason: 'copilot-subscription',
        userRetryable: true,
      },
    });

    const actions = element.shadowRoot?.querySelector(
      '.retry-request__actions',
    );
    expect(actions?.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'Start with your own API key',
    );
    expect(actions?.textContent).toContain('Retry Copilot');
  });

  it('shows exactly the claimed number of tail characters for truncated partial output', async () => {
    const element = await mountPanel();

    const text = formatPartialOutput(element, 'x'.repeat(2000));

    expect(text).toContain('--- Partial Output (last 1024 of 2000 chars) ---');
    // "…" plus exactly 1024 content characters, not 1023.
    expect(tailLine(text).replace(/^…/, '')).toHaveLength(1024);
  });

  it('reports and truncates by grapheme count, not UTF-16 code-unit length', async () => {
    const element = await mountPanel();

    // Each 😀 is a surrogate pair (2 UTF-16 units, 1 grapheme). 600 of them
    // is 1200 code units but only 600 graphemes — under the 1024 threshold,
    // so this must NOT be reported or truncated as if it were over it.
    const text = formatPartialOutput(element, '😀'.repeat(600));

    expect(text).toContain('--- Partial Output (600 chars) ---');
    expect(text).not.toContain('last 1024');
  });

  it('agrees on truncation at the exact boundary (maxTailChars + 1 total chars)', async () => {
    const element = await mountPanel();

    // At exactly 1025 chars, tailWithEllipsis(text, 1025) returns the text
    // unchanged (1025 <= its own budget of 1025) — the header must not
    // claim truncation when nothing was actually cut.
    const text = formatPartialOutput(element, 'x'.repeat(1025));

    expect(text).toContain('--- Partial Output (1025 chars) ---');
    expect(text).not.toContain('last 1024');
    expect(tailLine(text)).toBe('x'.repeat(1025));
  });

  it('truncates one char past the boundary (maxTailChars + 2 total chars)', async () => {
    const element = await mountPanel();

    const text = formatPartialOutput(element, 'x'.repeat(1026));

    expect(text).toContain('--- Partial Output (last 1024 of 1026 chars) ---');
    const tail = tailLine(text);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.replace(/^…/, '')).toHaveLength(1024);
  });
});
