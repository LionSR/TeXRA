import { css, type CSSResult } from 'lit';

/** The one colour per tone (`RunTone`): an element classed `tone-<tone>`
 *  sets `--tone-color`, which its glyph, dot or spinner paints with. */
export const toneStyles: CSSResult = css`
  :is(.tone-running, .tone-success) {
    --tone-color: var(--color-success);
  }

  .tone-danger {
    --tone-color: var(--color-error);
  }

  .tone-warning {
    --tone-color: var(--color-warning);
  }

  .tone-neutral {
    --tone-color: var(--color-text-muted);
  }

  @media (forced-colors: active) {
    :is(.tone-running, .tone-warning) {
      --tone-color: Highlight;
    }

    .tone-danger {
      --tone-color: CanvasText;
    }

    :is(.tone-success, .tone-neutral) {
      --tone-color: GrayText;
    }
  }
`;
