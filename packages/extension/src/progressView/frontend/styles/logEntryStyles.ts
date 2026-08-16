// Third-party imports
import { css } from 'lit';

/**
 * Base log entry styles for log lines, banners, and common elements.
 */
export const logEntryStyles = css`
  /* Note: Component-specific :host and element layout styles should be defined
     in each component, not here. These styles are for content classes only. */

  .log-container {
    flex: 1 1 auto;
    width: 100%;
    padding: var(--wa-space-xs)
      max(
        var(--wa-space-m),
        calc((100% - var(--conversation-reading-width, 800px)) / 2)
      )
      var(--wa-space-s);
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    font-family: var(--font-family);
    font-size: var(--font-size);
    position: relative;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .log-line {
    line-height: var(--line-height-relaxed);
    margin: 0;
    padding: var(--wa-space-3xs) 0;
    display: block;
    white-space: pre-wrap;
    /* anywhere breaks only what cannot fit (long paths, ids, URLs); break-all
       split ordinary prose mid-word on every wrap. The terminal variant below
       already made this trade for the same reason. */
    overflow-wrap: anywhere;
    content-visibility: auto;
    contain-intrinsic-size: auto 24px;
  }

  .log-line--render-error {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    margin: var(--wa-space-2xs) 0;
    background: var(--wa-color-warning-fill-quiet);
    border: var(--border-thin) solid var(--wa-color-warning-border-quiet);
    border-radius: var(--border-radius);
    color: var(--color-warning);
    font-style: italic;
  }

  .workflow-task {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--wa-space-2xs);
    margin: var(--wa-space-2xs) 0;
    padding: var(--wa-space-xs);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-inline-start: 2px solid var(--border-control);
    border-radius: var(--wa-border-radius-m, var(--border-radius));
    background: color-mix(
      in srgb,
      var(--wa-color-surface-raised) 52%,
      transparent
    );
    content-visibility: auto;
    contain-intrinsic-size: auto 42px;
  }

  .workflow-task--running {
    border-inline-start-color: var(--wa-color-focus);
    background: var(--wa-color-neutral-fill-quiet);
  }

  .workflow-task--linked {
    cursor: pointer;
  }

  /* Hover only. Focus keeps the shared 2px ring from focusRingStyles: the
     border-color flip alone was identical to hover, so a keyboard user had no
     way to tell "focused" from "pointed at". */
  .workflow-task--linked:hover {
    border-color: var(--wa-color-focus);
  }

  .workflow-task--completed,
  .workflow-task--cached {
    border-inline-start-color: var(--color-success);
  }

  .workflow-task--failed {
    border-inline-start-color: var(--color-error);
    background: var(--wa-color-danger-fill-quiet);
  }

  .workflow-task--skipped,
  .workflow-task--cancelled {
    opacity: var(--opacity-subtle);
  }

  .workflow-task-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.2em;
    height: 1.2em;
    margin-top: 0.1em;
  }

  .workflow-task-icon wa-icon {
    font-size: 1em;
  }

  .workflow-task-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: calc(var(--wa-space-3xs) / 2);
  }

  .workflow-task-title {
    overflow-wrap: anywhere;
    font-weight: var(--wa-font-weight-semibold);
  }

  /* The card's phase is the group header it sits under, so the sub-label row
     carries terminal metadata only. */
  .workflow-task-meta {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .workflow-task-detail {
    overflow-wrap: anywhere;
  }

  .workflow-task-detail--error {
    color: var(--color-error);
  }

  .workflow-task-status {
    align-self: center;
    padding: calc(var(--wa-space-3xs) / 2) var(--wa-space-2xs);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .workflow-task--running .workflow-task-status {
    color: var(--wa-color-focus);
  }

  .workflow-task--completed .workflow-task-status,
  .workflow-task--cached .workflow-task-status {
    color: var(--color-success);
  }

  .workflow-task--failed .workflow-task-status {
    color: var(--color-error);
  }

  .log-reveal-row {
    display: flex;
    justify-content: center;
    margin: var(--wa-space-2xs) 0;
  }

  .render-error-icon {
    font-style: normal;
    flex-shrink: 0;
  }

  .log-entry-content {
    padding: var(--wa-space-2xs) 0 var(--wa-space-2xs);
    overflow: visible;
  }

  /* Light DOM formatter styles */
  .file-list-content {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .file-list-content .file-var,
  .file-list-content .file-source {
    color: var(--color-text-muted);
  }

  .file-list-content .file-var {
    font-size: var(--font-size-sm);
    margin-inline-start: var(--wa-space-3xs);
  }

  .file-list-content .file-source {
    font-size: 0.85em;
    font-style: italic;
  }

  .xml-link-container {
    margin-top: var(--wa-space-2xs);
    padding-top: var(--wa-space-2xs);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .xml-link-container wa-icon {
    color: var(--color-text-muted);
  }

  .xml-link-container .document-tag {
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* Note: .detail-item base styles are in commonViewStyles; this adds log-specific variants */

  :is(.file-link, .web-search-link) {
    color: var(--color-text-link);
    cursor: pointer;
  }

  :is(.file-link, .web-search-link):hover {
    text-decoration: underline;
  }

  /* Radius only — the ring itself comes from focusRingStyles, which an
     outline here would narrow to 1px. */
  :is(.file-link, .web-search-link):focus-visible {
    border-radius: var(--border-radius-small);
  }

  .web-search-link {
    text-decoration: none;
  }

  .memory-path {
    color: var(--color-text-secondary);
  }

  .memory-path wa-icon {
    margin-inline-end: var(--wa-space-2xs);
  }

  .memory-path .file-source {
    opacity: var(--opacity-subtle);
    font-size: 0.85em;
  }

  /* Web search result styles */
  .detail-list {
    list-style: none;
    margin: var(--wa-space-2xs) 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
  }

  .file-list-summary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
  }

  /* Per-file +added/-removed line-change counts in tool detail rows. The
     inline-flex gap spaces the two counts without a per-span inline style. */
  .file-stats {
    display: inline-flex;
    gap: var(--wa-space-2xs);
  }

  /* Note: .details-summary base styles are in commonViewStyles */

  /* File list details styling */
  .file-list-details {
    margin: var(--wa-space-2xs) 0;
  }

  .banner-content-copy {
    min-width: 0;
    padding: 0 var(--wa-space-3xs);
    opacity: 0;
    margin-inline-start: auto;
    cursor: pointer;
  }

  .details-summary:hover .banner-content-copy,
  .banner-details:focus-within .banner-content-copy,
  .banner-content-copy:focus-visible {
    opacity: var(--opacity-full);
  }

  /* Same shadow-piercing exception as .code-block-copy: this is a wa-button,
     and WebAwesome ships no focus styling of its own for it, so without this
     the control falls back to the UA default ring while every sibling control
     shows the branded one. */
  .banner-content-copy:focus-visible::part(base) {
    outline: var(--focus-ring-width) solid var(--wa-color-focus);
    outline-offset: var(--focus-ring-offset);
  }

  .banner-content-copy.copy-success {
    opacity: var(--opacity-full);
    color: var(--color-success);
  }

  .timestamp {
    color: var(--color-text-secondary);
  }

  /* Per-level log icons (replaces the former emoji map). Font Awesome glyphs
     render in currentColor, so each level sets its own color to preserve the
     at-a-glance severity coding the colored emoji used to carry. */
  .log-level-icon {
    font-size: var(--font-size-sm);
    vertical-align: -0.1em;
  }

  .log-level-icon--error {
    color: var(--color-error);
  }

  .log-level-icon--warn {
    color: var(--color-warning);
  }

  .log-level-icon--info {
    color: var(--color-success);
  }

  .log-level-icon--debug {
    color: var(--color-text-secondary);
  }

  /* Log level badges */
  :is(.level-debug, .level-info, .level-warn, .level-error) {
    font-weight: var(--font-weight-bold);
  }

  .level-debug {
    color: var(--wa-color-debug-name, #4b9ef9);
  }

  .level-info {
    color: var(--wa-color-icon-info, #75beff);
  }

  .level-warn,
  .message-warn {
    color: var(--color-warning);
  }

  .level-error,
  .message-error {
    color: var(--color-error);
  }

  .message-debug {
    color: var(--wa-color-text-preformat, #a9b7c6);
  }

  .message-info {
    color: var(--wa-color-text-normal);
  }

  .banner-details {
    margin: var(--wa-space-3xs) 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 40px;
  }

  /* Base/content resets and the header's padding come from
     commonViewStyles, which every consumer of this sheet loads first. Only
     the compact header height is specific to log banners. */
  wa-details.banner-details::part(header) {
    min-height: 26px;
  }

  .details-summary {
    gap: var(--wa-space-3xs);
    min-width: 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
  }

  .details-summary > .icon {
    color: var(--color-text-muted);
  }

  .banner-content {
    margin: 0;
  }

  .banner-content--model {
    color: var(--wa-color-text-normal);
    font-size: var(--font-size);
    line-height: 1.6;
  }

  .banner-content--thinking,
  .banner-content--scratchpad {
    padding: var(--wa-space-xs) var(--wa-space-s);
    border-radius: var(--wa-border-radius-m, var(--border-radius));
    background: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 72%,
      transparent
    );
    color: var(--wa-color-text-quiet);
  }

  /* Raw streamed text has no <p>/<br> tags to carry line breaks (unlike the
     markdown-rendered content this class normally wraps), so preserve them.
     Unlike .log-line, this text is actively being read while it grows, so
     prefer breaking at word boundaries (break-word) over .log-line's
     break-all — mid-word breaks are more disruptive mid-stream.
     Double-class selector on purpose: .banner-content--model (shared
     markdown sheet, adopted later) sets white-space: normal at the same
     0,1,0 specificity, and stylesheet order handed it the tie - collapsing
     every newline in streaming Assistant text. 0,2,0 wins regardless of
     sheet order; the element always carries both classes. */
  .banner-content.banner-content--streaming {
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .banner-details:not([open]) .banner-content {
    display: none;
  }

  /* Terminal-style output: monospace font, tighter spacing, no log bullets.
     Applied to streams that proxy raw process output (e.g. bash child streams)
     so their stdout/stderr reads like a terminal instead of a logger. */
  :host([terminal]) .log-container {
    font-family: var(
      --wa-font-family-mono,
      ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace
    );
    font-size: var(--wa-editor-font-size, var(--font-size));
    background-color: var(
      --wa-color-terminal-background,
      var(--wa-color-surface-default, transparent)
    );
    color: var(--wa-color-terminal-foreground, var(--wa-color-text-normal));
    padding-block: var(--wa-space-xs);
  }

  :host([terminal]) .log-line {
    padding: 0;
    line-height: 1.35;
    word-break: normal;
    overflow-wrap: anywhere;
  }

  @container (max-width: 640px) {
    .log-container {
      padding-inline: var(--wa-space-xs);
    }
  }

  /* Bullet/timestamp prefix is noisy for raw process output. */
  :host([terminal]) .log-line .timestamp {
    display: none;
  }

  /* stdout renders at terminal foreground; stderr keeps a warn tint. */
  :host([terminal]) .message-info,
  :host([terminal]) .message-debug {
    color: inherit;
  }

  :host([terminal]) .message-warn {
    color: var(--wa-color-terminal-ansi-yellow, var(--color-warning));
  }

  :host([terminal]) .message-error {
    color: var(--wa-color-terminal-ansi-red, var(--color-error));
  }

  /* Pre-formatted text nodes for terminal-mode streams.
     Keep committed output and the live tail separate without changing text flow. */
  :host([terminal]) .terminal-container {
    margin: 0;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    white-space: pre-wrap;
    word-break: break-all;
  }

  :host([terminal]) .terminal-pre {
    display: inline;
    margin: 0;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    white-space: inherit;
    word-break: inherit;
  }
`;

/**
 * Shared collapsing rules for the custom-element banner panels
 * (`<context-management>`, `<latexdiff-results>`). These run inside the
 * component shadow root, so the class-scoped `.banner-details` rule in this
 * sheet cannot reach them; each panel loads this block alongside its own
 * `wa-details` margin.
 */
export const bannerDetailsWaDetailsStyles = css`
  wa-details {
    content-visibility: auto;
    contain-intrinsic-size: auto 40px;
  }
`;
