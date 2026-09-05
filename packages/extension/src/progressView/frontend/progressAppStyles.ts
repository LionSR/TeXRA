// Third-party imports
import { css } from 'lit';

// Shared styles
import { visuallyHiddenStyles } from '@shared/styles';
import { buttonStyles } from '@shared/styles/controlStyles';

/**
 * Layout for the `<progress-app>` shell: the 38px header, the body, the
 * docked list of the wide editor tab, and the empty state. The docking is
 * a container query on the host at 720px, active only in the editor
 * placement; below it the tab behaves like the sidebar (the drawer).
 */
export const progressAppStyles = css`
  :host {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    container-type: inline-size;
  }

  ${buttonStyles}

  ${visuallyHiddenStyles}

  .shell {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
  }

  .shell-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex: 0 0 auto;
    min-height: var(--height-header, 38px);
    padding: 0 var(--wa-space-2xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .shell-title {
    min-width: 0;
    padding-inline-start: var(--wa-space-3xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--font-weight-semibold);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .stop-button {
    color: var(--color-error);
  }

  .shell-body {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .reading {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  /* The docked list exists only in the wide editor tab (see the container
     query); the sidebar and the narrow tab use the drawer. */
  .dock {
    display: none;
    flex-direction: column;
    flex: 0 0 300px;
    min-height: 0;
    border-inline-end: var(--border-thin) solid var(--color-border);
    background: var(--wa-color-surface-lowered);
  }

  .dock-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex: 0 0 auto;
    min-height: var(--height-header, 38px);
    padding: 0 var(--wa-space-2xs) 0 var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .dock-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--font-weight-semibold);
  }

  .dock stream-tabs {
    flex: 1;
    min-height: 0;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
  }

  @container (min-width: 720px) {
    .shell.is-editor .dock {
      display: flex;
    }
    .shell.is-editor .sessions-button,
    .shell.is-editor session-drawer {
      display: none;
    }
    .shell.is-editor .reading {
      align-items: stretch;
    }
    .shell.is-editor .reading > * {
      width: min(760px, 100%);
      margin: 0 auto;
    }
  }

  /* Empty state: hero, context disclosure, Active now, the expanded composer. */
  .empty {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .hero-wrap {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 1 1 auto;
    gap: var(--wa-space-m);
    padding: var(--wa-space-l) var(--wa-space-xs);
  }

  .hero {
    display: grid;
    justify-items: center;
    gap: var(--wa-space-2xs);
    padding: 0 var(--wa-space-xs);
    text-align: center;
  }

  .hero-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--wa-border-radius-l);
    border: var(--border-thin) solid var(--wa-color-brand-border-quiet);
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-brand-on-quiet);
    font-size: 18px;
  }

  .hero h1 {
    margin: var(--wa-space-3xs) 0 0;
    font-size: var(--font-size-h2, 1.25em);
    font-weight: var(--font-weight-semibold);
    letter-spacing: -0.005em;
    line-height: var(--line-height-heading, 1.25);
  }

  .hero p {
    margin: 0;
    max-width: 34ch;
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal, 1.5);
    color: var(--color-text-secondary);
  }

  .context::part(base) {
    border-radius: var(--wa-border-radius-m);
  }

  .context-summary {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .context-files {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .context-body {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
  }

  .active-now {
    flex: 0 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 var(--wa-space-2xs) var(--wa-space-3xs);
  }

  .active-label {
    padding: 0 var(--wa-space-2xs) var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .active-now stream-tabs {
    flex: 0 1 auto;
    min-height: 0;
  }

  .launch-composer {
    flex: 0 0 auto;
    padding: var(--wa-space-3xs) var(--wa-space-xs) var(--wa-space-xs);
  }

  wa-icon {
    font-size: 1em;
  }
`;
