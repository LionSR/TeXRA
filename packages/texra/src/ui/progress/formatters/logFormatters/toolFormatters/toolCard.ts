/**
 * The tool card: the collapsible shell the tool-use and web-search entries
 * share.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { ClassInfo } from 'lit/directives/class-map.js';
import { buildDetailsCard } from '@ui/progress/formatters/htmlBuilders';
import type { IconName } from '@ui/wa/iconNames';
import type { TranscriptRowBase } from '@texra-ai/harness/transcript';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * Wrap formatted tool content in the collapsible banner shell shared by the
 * tool-use and web-search entries. `extraClasses` and `extraContent` carry the
 * tool-use-only state flags and summary-row controls.
 */
export function buildToolUseDetails(opts: {
  row: Pick<TranscriptRowBase, 'id' | 'timestamp'>;
  iconName: IconName;
  /** Show a spinner in place of the icon. */
  running: boolean;
  label: string;
  isError: boolean;
  content: TemplateResult;
  defaultOpen?: boolean;
  extraClasses?: ClassInfo;
  extraContent?: TemplateResult;
}): TemplateResult {
  const classes: ClassInfo = {
    'tool-use-details': true,
    'tool-use-error': opts.isError,
    ...opts.extraClasses,
  };
  // The failure icon is decorative and hidden from assistive technology.
  // Keep the collapsed summary's state available without adding visual noise.
  const statusText = opts.isError
    ? html`<span class="visually-hidden"> — Failed</span>`
    : nothing;
  const extraContent = html`${statusText}${opts.extraContent ?? nothing}`;
  // prettier-ignore
  return buildDetailsCard({
    summary: { iconName: opts.iconName, running: opts.running, label: opts.label, labelClass: 'tool-use-title', extraContent },
    body: html`<div class="banner-content log-entry-content">${opts.content}</div>`,
    open: opts.defaultOpen,
    classes,
  });
}
