// Presentational gauge widgets shared between hosts. Callers compute the
// domain math (percentage, color thresholds, tick positions, segment
// fractions); these helpers only turn already-computed values into markup.

import { css, html, type CSSResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { styleMap } from 'lit/directives/style-map.js';

export interface LinearGaugeTick {
  /** Position along the track, 0-100. */
  readonly position: number;
  readonly title?: string;
}

export interface LinearGaugeOptions {
  /** Fill amount, 0-100 (caller clamps). */
  readonly percent: number;
  /** CSS color for the fill segment. */
  readonly color: string;
  readonly ticks?: readonly LinearGaugeTick[];
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
}

const DEFAULT_LINEAR_GAUGE_WIDTH = 80;
const DEFAULT_LINEAR_GAUGE_HEIGHT = 6;

/** Horizontal tick-bar gauge (e.g. context-window utilization). */
export function renderLinearGauge(options: LinearGaugeOptions): TemplateResult {
  const width = options.width ?? DEFAULT_LINEAR_GAUGE_WIDTH;
  const height = options.height ?? DEFAULT_LINEAR_GAUGE_HEIGHT;

  return html`
    <span
      class=${['linear-gauge-track', options.className].filter(Boolean).join(' ')}
      style=${styleMap({ width: `${width}px`, height: `${height}px` })}
      title=${ifDefined(options.title)}
    >
      <span
        class="linear-gauge-fill"
        style=${styleMap({
          width: `${options.percent}%`,
          backgroundColor: options.color,
        })}
      ></span>
      ${(options.ticks ?? []).map(
        (tick) => html`
          <span
            class="linear-gauge-tick"
            style=${styleMap({ left: `${tick.position}%` })}
            title=${ifDefined(tick.title)}
          ></span>
        `,
      )}
    </span>
  `;
}

export const linearGaugeStyles: CSSResult = css`
  .linear-gauge-track {
    position: relative;
    display: inline-block;
    background: var(--wa-color-surface-border, rgba(128, 128, 128, 0.3));
    border-radius: var(--border-radius);
    overflow: hidden;
  }

  .linear-gauge-fill {
    display: block;
    height: 100%;
    border-radius: var(--border-radius);
    transition: width var(--transition-slow);
  }

  .linear-gauge-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--border-thin);
    background: var(--wa-color-text-normal);
    opacity: var(--opacity-separator);
  }
`;

export interface RingGaugeSegment {
  /** Portion of the ring's circumference, 0-1. */
  readonly fraction: number;
  /** CSS color for this segment's stroke. */
  readonly color: string;
}

export interface RingGaugeOptions {
  /** Rendered in order, starting at 12 o'clock and going clockwise. */
  readonly segments: readonly RingGaugeSegment[];
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly trackColor?: string;
  readonly className?: string;
}

const DEFAULT_RING_SIZE = 36;
const DEFAULT_RING_STROKE_WIDTH = 4;
const DEFAULT_RING_TRACK_COLOR =
  'var(--wa-color-surface-border, rgba(128, 128, 128, 0.25))';

/** Circular donut-ring gauge (e.g. tool-availability health ring). */
export function renderRingGauge(options: RingGaugeOptions): TemplateResult {
  const size = options.size ?? DEFAULT_RING_SIZE;
  const strokeWidth = options.strokeWidth ?? DEFAULT_RING_STROKE_WIDTH;
  const trackColor = options.trackColor ?? DEFAULT_RING_TRACK_COLOR;
  const center = size / 2;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  let cumulativeFraction = 0;
  const segments = options.segments.map((segment) => {
    const dashOffset = circumference - circumference * segment.fraction;
    const rotation = cumulativeFraction * 360;
    cumulativeFraction += segment.fraction;
    return { ...segment, dashOffset, rotation };
  });

  return html`
    <svg
      class=${ifDefined(options.className)}
      viewBox="0 0 ${size} ${size}"
      width=${size}
      height=${size}
      style="transform: rotate(-90deg)"
      aria-hidden="true"
    >
      <circle
        fill="none"
        stroke=${trackColor}
        stroke-width=${strokeWidth}
        cx=${center}
        cy=${center}
        r=${radius}
      />
      ${segments.map(
        (segment) => html`
          <circle
            fill="none"
            stroke=${segment.color}
            stroke-width=${strokeWidth}
            stroke-linecap="round"
            cx=${center}
            cy=${center}
            r=${radius}
            stroke-dasharray=${circumference}
            stroke-dashoffset=${segment.dashOffset}
            style=${styleMap({
              transformOrigin: '50% 50%',
              transform: `rotate(${segment.rotation}deg)`,
            })}
          />
        `,
      )}
    </svg>
  `;
}
