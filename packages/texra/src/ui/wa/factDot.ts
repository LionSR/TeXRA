// Third-party imports
import { FACT_SEPARATOR } from '@texra-ai/worldline/schemas';
import { html, type TemplateResult } from 'lit';

const DOT = FACT_SEPARATOR.trim();

/**
 * The dot between two facts a template lays out as elements (a token count
 * and a cost, a model's name and its route): `joinFacts`' separator, hidden
 * from a screen reader, which reads the facts on either side as they are.
 * The space around it is the template's: a flex row's gap, or a literal
 * space between inline elements.
 */
export function factDot(): TemplateResult {
  return html`<span aria-hidden="true">${DOT}</span>`;
}
