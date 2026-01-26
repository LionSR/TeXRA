/**
 * Shared search UI styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Search container and input
 * - Search navigation buttons
 * - Match count display
 * - Search highlighting (mark elements)
 *
 * Used by: SearchBar (HistoryView)
 *
 * @example
 * import { searchStyles } from '@shared/styles/searchStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, searchStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const searchStyles: CSSResult = css`
  /* Search container layout */
  .search-container {
    display: flex;
    align-items: center;
    margin-bottom: var(--spacing-xlarge, 20px);
    gap: var(--spacing-medium, 8px);
    width: 100%;
  }

  /* Search input styling */
  .search-input {
    flex: 1;
    padding: var(--spacing-medium, 8px);
    font-size: var(--font-size, 13px);
  }

  /* Search controls container */
  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-small, 4px);
  }

  /* Navigation buttons (prev/next) */
  .search-nav-btn {
    min-width: var(--height-button, 30px);
    height: var(--height-button, 30px);
    padding: 0;
    font-size: var(--font-size, 13px);
  }

  /* Match count display */
  .match-count {
    font-size: var(--font-size-sm, 12px);
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
    min-width: calc(var(--height-button, 30px) * 2);
    text-align: center;
  }

  /* Search result highlighting */
  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0;
    border-radius: var(--border-radius-small, 2px);
  }

  /* Current match highlighting */
  mark.current-match {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin, 1px) solid var(--vscode-focusBorder);
  }

  /* No results message */
  .search-no-results {
    text-align: center;
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
    padding: var(--spacing-large, 12px);
    font-style: italic;
  }

  /* Clear search button */
  .search-clear {
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .search-input:not(:placeholder-shown) + .search-clear,
  .search-input:focus + .search-clear {
    opacity: 1;
  }
`;
