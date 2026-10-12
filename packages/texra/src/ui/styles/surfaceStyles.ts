import { css } from 'lit';

/** Shared frame for messages, requests, notices, and expandable log entries. */
export const panelFrameStyles = css`
  box-sizing: border-box;
  min-width: 0;
  border: var(--border-thin) solid var(--wa-color-surface-border);
  border-radius: var(--panel-radius);
  background: var(--panel-background);
  color: var(--wa-color-text-normal);
`;

export const panelHeaderStyles = css`
  box-sizing: border-box;
  min-height: var(--row-height);
  padding: var(--panel-padding-block) var(--panel-padding-inline);
`;

export const panelContentStyles = css`
  padding: 0 var(--panel-padding-inline) var(--panel-padding-block);
`;

/** One reading measure for transcript-adjacent panels and notices. */
export const readingColumnStyles = css`
  width: min(
    var(--conversation-width, 760px),
    calc(100% - 2 * var(--conversation-gutter, var(--wa-space-m)))
  );
  min-width: 0;
  margin-inline: auto;
  box-sizing: border-box;

  @container (max-width: 520px) {
    width: min(
      var(--conversation-width, 760px),
      calc(100% - 2 * var(--wa-space-s))
    );
  }
`;

/** Web Awesome notices use the panel scale, including slotted icon alignment. */
export const noticeStyles = css`
  wa-callout {
    ${panelFrameStyles}
    padding: var(--panel-padding-block) var(--panel-padding-inline);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  wa-callout::part(message) {
    min-width: 0;
    padding: 0;
    overflow-wrap: anywhere;
  }

  wa-callout::part(icon) {
    align-self: start;
    display: grid;
    place-items: center;
    font-size: var(--font-size-icon-sm);
    padding: 0;
    margin-block-start: calc(
      (
          var(--font-size-sm) *
            var(--line-height-normal) - var(--font-size-icon-sm)
        ) /
        2
    );
    margin-inline-end: var(--wa-space-xs);
  }

  wa-callout > [slot='icon'] {
    margin: 0;
  }

  wa-callout:not(:has(> [slot='icon']))::part(icon) {
    display: none;
    margin: 0;
  }
`;
