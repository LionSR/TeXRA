/**
 * Thin wrapper around `@lit-labs/ssr`. Centralises the render-to-string
 * dance so callers don't import from `lib/render-result.js` directly.
 */
import { render } from '@lit-labs/ssr';
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js';

import type { TemplateResult } from 'lit';

export function renderTemplateToHtml(template: TemplateResult): string {
  return collectResultSync(render(template));
}
