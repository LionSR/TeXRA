/** Component-scoped styles for {@link ExternalInquiryPanel} (external inquiry requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@ui/styles';

export const externalInquiryPanelStyles: CSSResult = css`
  :host {
    --request-accent: var(--wa-color-focus);
  }

  /* Question and answer are the card; the dock scrolls rather than this
     body, so the answer box is never scrolled out of its own card. */
  .request-card__details {
    max-height: none;
    overflow-y: visible;
  }

  .external-inquiry-request__question {
    background: var(--wa-color-surface-lowered);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    padding: ${sp.medium};
    position: relative;
  }

  .external-inquiry-request__question-text {
    font-size: var(--font-size);
    line-height: var(--line-height-relaxed, 1.6);
    color: var(--wa-color-text-normal);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: min(22vh, 14rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .external-inquiry-request__question-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${sp.medium};
    margin-top: ${sp.small};
    padding-top: ${sp.small};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .external-inquiry-request__more::part(content) {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  .external-inquiry-request__transcript-turns {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  .external-inquiry-request__transcript-turn,
  .external-inquiry-request__attach-files,
  .external-inquiry-request__answer-area {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__transcript-turn
    + .external-inquiry-request__transcript-turn {
    padding-top: ${sp.medium};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .external-inquiry-request__transcript-turn-header,
  .external-inquiry-request__transcript-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__transcript-context,
  .external-inquiry-request__chat-links,
  .external-inquiry-request__answer-hint {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__transcript-text {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .external-inquiry-request__transcript-links {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .external-inquiry-request__search-hint {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    font-size: var(--font-size-sm);
    color: var(--wa-color-brand-on-quiet, var(--wa-color-focus));
    padding: ${sp.small} 0;
  }

  .external-inquiry-request__attach-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-quiet);
    display: flex;
    align-items: center;
    gap: ${sp.small};
  }

  .external-inquiry-request__file-list,
  .external-inquiry-request__session-links-list {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
    padding: ${sp.small};
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius-small);
    margin: 0;
    list-style: none;
  }

  .external-inquiry-request__file-item {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    font-size: var(--font-size-sm);
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-link);
  }

  .external-inquiry-request__session-links-label,
  .external-inquiry-request__answer-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .external-inquiry-request__session-link-item {
    display: block;
    font-size: var(--font-size-sm);
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-link);
    text-decoration: none;
    word-break: break-word;
  }

  a.external-inquiry-request__session-link-item:hover {
    text-decoration: underline;
  }

  /* Sizing via the canonical skin's tokens (formControlStyles, reached
     through commonViewStyles); font/line rules come from the skin itself. */
  .external-inquiry-request__session-links-input {
    --textarea-min-height: 2.75rem;
    --textarea-max-height: min(12vh, 5rem);
  }

  .external-inquiry-request__chat-links a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }

  .external-inquiry-request__chat-links {
    line-height: var(--line-height-normal);
    overflow-wrap: anywhere;
  }

  .external-inquiry-request__chat-links a:hover {
    text-decoration: underline;
  }

  .external-inquiry-request__answer-input {
    --textarea-min-height: 96px;
    --textarea-max-height: min(24vh, 12rem);
  }

  /* Answer text stays at body size, larger than the skin's sm default. */
  .external-inquiry-request__answer-input::part(textarea) {
    font-size: var(--font-size);
  }

  @media (max-height: 900px) {
    .external-inquiry-request__question-text {
      max-height: min(18vh, 10rem);
    }

    .external-inquiry-request__answer-input {
      --textarea-min-height: 80px;
      --textarea-max-height: min(20vh, 10rem);
    }

    .external-inquiry-request__session-links-input {
      --textarea-min-height: 2.5rem;
      --textarea-max-height: min(10vh, 4.5rem);
    }
  }
`;
