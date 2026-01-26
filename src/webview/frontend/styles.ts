// Third-party imports
import { css, type CSSResult } from 'lit';

export const mainViewStyles: CSSResult = css`
  :host {
    background-color: transparent;
    color: var(--text-color);
    font-weight: var(--font-weight);
    min-height: 100vh;
    padding: var(--spacing-medium);
    display: flex;
    flex-direction: column;
  }

  @keyframes pulse-fade {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .select-group {
    display: flex;
    align-items: center;
    flex: 1;
  }

  .select-group .codicon {
    margin-right: var(--spacing-small);
    color: var(--text-color);
    vertical-align: text-bottom;
  }

  .select-group select,
  .select-group vscode-single-select {
    flex-grow: 1;
    height: var(--height-button);
  }

  .codicon.clickable:hover {
    color: var(--button-hover-background);
  }

  .dropdown-container {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dropdown-container vscode-toolbar-button {
    flex-shrink: 0;
  }

  .dropdown-container .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    right: 0;
    z-index: 100;
    display: block;
    background-color: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border);
    border-radius: var(--border-radius);
    min-width: 160px;
  }

  .dropdown-container.dropdown-left .dropdown-menu {
    left: 0;
    right: auto;
  }

  .dropdown-container .dropdown-menu:not([show]) {
    display: none;
  }

  .dropdown-container .dropdown-menu .dropdown-menu-content {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--spacing-tiny);
  }

  .dropdown-container .dropdown-menu vscode-checkbox {
    display: flex;
    align-items: center;
    height: 20px;
    padding: var(--spacing-tiny);
    font-size: var(--font-size-sm);
  }

  .dropdown-container .dropdown-menu vscode-checkbox:hover {
    background: var(--vscode-list-hoverBackground);
  }

  vscode-toolbar-button[aria-expanded='true'] .codicon-chevron-down {
    transform: rotate(180deg);
  }

  vscode-option.disabled-option,
  vscode-option.disabled-model,
  vscode-option.disabled-agent,
  vscode-option[data-requires-key='true'] {
    color: var(--color-text-secondary);
    opacity: var(--opacity-subtle);
    font-style: italic;
  }

  .api-key-missing {
    color: var(--vscode-errorForeground);
    opacity: 1;
    font-style: normal;
  }

  vscode-option {
    font-family: var(--vscode-font-family);
  }

  vscode-option[data-tool-use='true'] {
    font-style: italic;
  }

  .file-selection-group {
    background-color: var(--background-color);
    border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-medium);
    margin-bottom: var(--spacing-large);
    overflow: visible;
  }

  .file-selection-group--disabled {
    display: none;
  }

  .latexdiffs-section {
    margin-top: auto;
    padding: var(--spacing-large) 0 0;
    background-color: transparent;
    border: none;
    margin-bottom: var(--spacing-large);
  }

  .latexdiffs-section[data-expanded='true'] {
    background-color: var(--background-color);
    border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-medium);
    overflow: visible;
  }

  #latexdiffsContent {
    overflow: visible;
  }

  .latexdiffs-section vscode-button,
  .latexdiffs-section vscode-toolbar-button,
  .file-select-actions vscode-button,
  .file-select-actions vscode-toolbar-button {
    width: var(--height-control);
    height: var(--height-control);
    min-width: var(--height-control);
    min-height: var(--height-control);
  }

  .multiple-files-container {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: var(--spacing-small);
    padding: 0;
  }

  .multiple-files-content {
    width: 100%;
    padding: 0;
  }

  .multiple-files-list {
    background-color: var(--background-color);
    border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-small);
    font-size: var(--font-size);
    max-height: var(--height-small);
    overflow-y: auto;
  }

  .multiple-files-list div {
    padding: var(--spacing-tiny) var(--spacing-small);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .remove-button {
    color: var(--vscode-errorForeground);
    cursor: pointer;
  }

  .file-select {
    margin-bottom: var(--spacing-large);
  }

  .file-select:has(.optional-label) {
    margin-bottom: var(--spacing-tiny);
  }

  .file-select-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-small);
    flex-wrap: nowrap;
    line-height: 1.5;
    gap: var(--spacing-small);
  }

  .file-select-header > vscode-toolbar-button {
    opacity: 1;
    flex-shrink: 0;
  }

  .file-select-header label {
    margin-right: var(--spacing-small);
  }

  .file-select-label-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-wrap: nowrap;
    flex: 1;
    min-width: 0;
    min-height: var(--height-control);
  }

  .file-select-label-group vscode-toolbar-button {
    opacity: 1;
  }

  .file-select-label-group vscode-textfield {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .file-select-label-group label {
    margin-right: var(--spacing-small);
  }

  .file-select-actions,
  vscode-toolbar-container.file-select-actions {
    flex-direction: column !important;
    flex-wrap: nowrap;
    margin-left: auto;
  }

  .file-select-actions vscode-toolbar-button {
    opacity: 1;
  }

  .file-select label {
    display: block;
    margin-bottom: var(--spacing-tiny);
    font-size: var(--font-size);
  }

  .file-select select,
  .file-select vscode-single-select {
    width: 100%;
  }

  .optional-label {
    color: var(--text-color);
    font-weight: normal;
    font-size: var(--font-size);
    white-space: nowrap;
    min-width: calc(var(--width-button-min) * 2);
    display: flex;
    align-items: center;
    height: var(--height-control);
  }

  .toggle-icon {
    cursor: pointer;
    user-select: none;
    margin: 0;
    position: relative;
    padding: 0 var(--spacing-tiny);
    color: var(--text-color);
    display: flex;
    align-items: center;
    height: var(--height-control);
  }

  .file-select[data-expanded='true'] .optional-label,
  .file-select[data-expanded='true'] .toggle-icon {
    color: var(--vscode-foreground);
  }

  .file-select:not([data-expanded='true']) .file-action-button {
    display: none;
  }

  .latexdiffs-section .file-select-header {
    margin-bottom: 0;
  }

  .latexdiffs-section[data-expanded='true'] .optional-label,
  .latexdiffs-section[data-expanded='true'] .toggle-icon {
    color: var(--vscode-foreground);
  }

  #commit {
    position: relative;
  }

  #commit::part(listbox) {
    max-height: var(--height-large);
  }

  .instruction-box {
    margin-bottom: var(--spacing-small);
    position: relative;
    padding: var(--spacing-medium);
  }

  #instruction {
    width: 100%;
    margin: var(--spacing-medium) 0;
  }

  #instruction::part(control) {
    max-height: var(--height-xlarge);
    transition: height 0.1s ease-out;
  }

  .instruction-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-small);
    flex-wrap: wrap;
    width: 100%;
  }

  .instruction-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-medium);
    margin-bottom: var(--spacing-small);
    line-height: 1.5;
    flex-wrap: wrap;
  }

  .instruction-header-leading {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    flex-wrap: wrap;
  }

  .instruction-session-toggle {
    display: flex;
    align-items: center;
  }

  .instruction-session-toggle vscode-radio-group {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  #executeButton {
    font-size: var(--font-size);
    margin-left: var(--spacing-small);
    flex-shrink: 0;
    min-width: 3rem;
    align-self: center;
  }

  #recordInstructionButton.recording .codicon-stop-circle {
    animation: pulse-fade 1.5s ease-in-out infinite;
  }

  .model-selection-footer {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex: 0 1 auto;
  }

  .model-selection-footer .select-group,
  .model-selection-footer .agent-select-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex: 0 1 auto;
  }

  .model-selection-footer .codicon {
    display: flex;
    align-items: center;
    line-height: 1;
  }

  .agent-select-controls,
  .agent-select-dropdowns {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex: 0 1 auto;
    min-width: 10rem;
    max-width: 14rem;
    position: relative;
  }

  .agent-select-dropdowns select,
  .agent-select-dropdowns vscode-single-select,
  .agent-select {
    width: 100%;
  }

  .model-selection-footer .select-group select,
  .model-selection-footer .select-group vscode-single-select {
    min-width: 6rem;
    max-width: 10rem;
  }

  .agent-select--hidden {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }

  .agent-select--active {
    position: relative;
  }

  .model-selection-footer vscode-single-select::part(listbox),
  #workflowAgent::part(listbox),
  #toolUseAgent::part(listbox),
  #model::part(listbox) {
    bottom: 100%;
    top: auto;
  }
`;

export const bannerStyles: CSSResult = css`
  .api-key-banner .actions,
  .agent-config-banner .actions,
  .dependency-banner .actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .dependency-banner .dependency-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-small);
  }

  .api-key-banner,
  .agent-config-banner,
  .dependency-banner,
  .getting-started-banner {
    border-radius: var(--border-radius);
    padding: var(--spacing-small) var(--spacing-medium);
    margin-bottom: var(--spacing-large);
  }

  .api-key-banner,
  .agent-config-banner,
  .dependency-banner {
    background-color: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .getting-started-banner {
    background-color: var(--vscode-inputValidation-infoBackground);
    color: var(--vscode-inputValidation-infoForeground);
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    line-height: 1.5;
  }

  .getting-started-banner a {
    color: var(--color-text-link);
    text-decoration: none;
  }

  .getting-started-banner a:hover {
    text-decoration: underline;
  }

  .login-banner {
    background: linear-gradient(
      135deg,
      var(--vscode-inputValidation-infoBackground) 0%,
      color-mix(
          in srgb,
          var(--vscode-inputValidation-infoBackground) 80%,
          var(--vscode-button-background)
        )
        100%
    );
    color: var(--vscode-inputValidation-infoForeground);
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    border-radius: var(--border-radius);
    padding: var(--spacing-medium);
    margin-bottom: var(--spacing-large);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-medium);
  }

  .login-banner-content {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    flex: 1;
  }

  .login-banner-icon {
    font-size: 1.5em;
    color: var(--vscode-button-background);
    display: flex;
    align-items: center;
  }

  .login-banner-text {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .login-banner-title {
    font-weight: 600;
    font-size: 1em;
  }

  .login-banner-description {
    font-size: 0.9em;
    opacity: 0.9;
  }

  .login-banner .actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-shrink: 0;
  }
`;
