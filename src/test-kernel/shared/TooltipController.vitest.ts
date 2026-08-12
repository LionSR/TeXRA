import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

let installToolbarTooltips: (typeof import('@shared/litControllers/TooltipController'))['installToolbarTooltips'];

useLitComponentTestDom(async () => {
  ({ installToolbarTooltips } =
    await import('@shared/litControllers/TooltipController'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toolbar tooltip controller', () => {
  it('does not clobber a wa-button title that changes while hovered', () => {
    vi.useFakeTimers();
    installToolbarTooltips();

    const button = document.createElement('wa-button');
    button.setAttribute('title', 'Copy text');
    document.body.append(button);

    button.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, composed: true }),
    );
    vi.advanceTimersByTime(501);

    expect(button.hasAttribute('title')).toBe(false);

    button.setAttribute('title', 'Copied!');
    button.dispatchEvent(
      new MouseEvent('mouseout', {
        bubbles: true,
        composed: true,
        relatedTarget: document.body,
      }),
    );

    expect(button.getAttribute('title')).toBe('Copied!');
  });
});
