/**
 * Shared dropdown utilities for agent and model options.
 *
 * Note: Option decoration is now handled declaratively in selectTemplates.ts
 * via renderAgentOptions/renderModelOptions using Lit templates.
 * These utilities provide legacy HTML string support for backwards compatibility.
 */

// =============================================================================
// PLACEHOLDER OPTIONS
// =============================================================================

/** Placeholder option for agent dropdowns */
export const AGENT_PLACEHOLDER =
  '<vscode-option value="">Select agent</vscode-option>';

/** Placeholder option for model dropdowns */
export const MODEL_PLACEHOLDER =
  '<vscode-option value="">Select model</vscode-option>';

/**
 * Prepend placeholder to options HTML.
 */
export function withPlaceholder(
  optionsHtml: string,
  placeholder: string,
): string {
  return `${placeholder}\n${optionsHtml}`;
}

// =============================================================================
// OPTION HTML APPLICATION (Legacy support)
// =============================================================================

/**
 * Mark an option as selected in HTML string before DOM insertion.
 * Used for legacy HTML string rendering fallback.
 * Prefer using Lit templates with ?selected attribute binding.
 */
export function markOptionAsSelected(
  optionsHtml: string,
  value: string,
): string {
  if (!value || !optionsHtml) return optionsHtml || '';

  const searchStr = `value="${value}"`;
  const index = optionsHtml.indexOf(searchStr);
  if (index === -1) return optionsHtml;

  const tagEnd = optionsHtml.indexOf('>', index + searchStr.length);
  if (tagEnd === -1) return optionsHtml;

  return `${optionsHtml.slice(0, tagEnd)} selected${optionsHtml.slice(tagEnd)}`;
}
