import { describe, expect, it } from 'vitest';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(() => Promise.resolve());

describe('renderLinearGauge', () => {
  it('keeps the track class when no className is supplied', async () => {
    const { renderLinearGauge } = await import('@shared/wa/gauges');
    const { render } = await import('lit');

    const container = document.createElement('div');
    render(renderLinearGauge({ percent: 40, color: 'red' }), container);

    const track = container.querySelector('.linear-gauge-track');
    expect(track).not.toBeNull();
    expect(track?.classList.contains('linear-gauge-track')).toBe(true);
  });

  it('appends a caller-supplied className alongside the track class', async () => {
    const { renderLinearGauge } = await import('@shared/wa/gauges');
    const { render } = await import('lit');

    const container = document.createElement('div');
    render(
      renderLinearGauge({ percent: 40, color: 'red', className: 'ctx-bar' }),
      container,
    );

    const track = container.querySelector('.linear-gauge-track');
    expect(track?.classList.contains('ctx-bar')).toBe(true);
  });
});

describe('renderRingGauge', () => {
  it('computes dash-offset and rotation per segment from the ring circumference', async () => {
    const { renderRingGauge } = await import('@shared/wa/gauges');
    const { render } = await import('lit');

    const container = document.createElement('div');
    render(
      renderRingGauge({
        segments: [
          { fraction: 0.25, color: 'red' },
          { fraction: 0.5, color: 'blue' },
        ],
      }),
      container,
    );

    const center = 18; // default size 36 / 2
    const radius = center - 4; // default strokeWidth 4
    const circumference = 2 * Math.PI * radius;

    const circles = container.querySelectorAll('circle');
    // First circle is the background track; segments follow in order.
    const [firstSegment, secondSegment] = [circles[1], circles[2]];

    expect(Number(firstSegment.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      circumference - circumference * 0.25,
    );
    expect(firstSegment.getAttribute('style')).toContain('rotate(0deg)');

    expect(Number(secondSegment.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      circumference - circumference * 0.5,
    );
    expect(secondSegment.getAttribute('style')).toContain('rotate(90deg)');
  });
});
