/**
 * Tool-use row painter.
 *
 * Everything this card says about a call — its header label and preview, the
 * structured sections, whether the output block is shown at all, the error
 * text and the user instruction — comes from `ToolRow.model`
 * (`toolRowModel` in `@shared/transcript`). This file paints that model with
 * Lit and applies the webview's own widths, icons, and live controls.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates
 * with indentation will render with unwanted spaces in the output. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Third-party imports - Lit template utilities
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared utilities
import type { ToolRow } from '@shared/transcript';
import { parseDelegationToolInput, TOOL_USE_STATUS } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  DELEGATION_TOOL_CATEGORY,
} from '@shared/constants/delegationTools';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { toolDisplayKind } from '@shared/tools/toolKind';
import {
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  getToolIconName,
  buildSpillArtifactButton,
  stopSummaryToggleKeydown,
  SPINNER_ICON_NAME,
} from '../htmlBuilders';

import {
  buildTerminalSection,
  buildToolSection,
  buildToolUseDetails,
  getToolTimeoutMs,
} from './toolFormatters/helpers';
import { renderToolSections } from './toolFormatters/toolSections';
import type { FormatResult } from '../baseLogFormatter';

/** Header width for this surface; the model carries the preview untruncated. */
const HEADER_PREVIEW_MAX_CHARS = 120;

/** Format tool use log entry as TemplateResult. */
export function formatToolUseTemplate(row: ToolRow): FormatResult {
  const { toolUse, model } = row;
  const { toolName, input } = toolUse;
  const normalizedToolName = normalizeToolName(toolName);
  const displayKind = toolDisplayKind(toolName);
  const showAsError = model.isError && !model.isUserFeedback;

  let iconName: TeXRAIconName | typeof SPINNER_ICON_NAME;
  if (model.isUserFeedback) {
    iconName = 'comment';
  } else if (model.isInProgress) {
    iconName = SPINNER_ICON_NAME;
  } else {
    iconName = getToolIconName(normalizedToolName, showAsError);
  }

  const headerPreview = truncateWithEllipsis(
    model.headerPreview,
    HEADER_PREVIEW_MAX_CHARS,
  );
  const titleText = headerPreview
    ? `${model.headerLabel} — ${headerPreview}`
    : model.headerLabel;

  const sections: TemplateResult[] = renderToolSections(
    model.sections,
    toolName,
  );

  // Output is shown unless the model suppressed it (empty, already said by
  // the header, the error, or the sections above).
  if (model.output) {
    sections.push(
      displayKind === 'bash' || normalizedToolName === 'codex'
        ? buildTerminalSection('', model.output.full)
        : buildToolSection('', model.output.full, {
            toolName,
            extraClass: 'tool-output-full',
          }),
    );
  }

  // The shell exit status a failed call reported. Only meaningful on failure:
  // a successful command's `exit 0` says nothing the status icon does not.
  if (model.isError && model.exitCode !== undefined) {
    // prettier-ignore
    sections.push(html`<div class="tool-use-section tool-exit-code">exit ${model.exitCode}</div>`);
  }

  if (model.errorPreview) {
    sections.push(
      buildToolUseSection(
        'Error:',
        wrapInPre(model.errorPreview.full, 'tool-error-content'),
      ),
    );
  }

  if (model.userInstruction) {
    sections.push(
      buildToolUseSection(
        'User Instruction:',
        wrapInPre(model.userInstruction.full, 'tool-user-feedback'),
      ),
    );
  }

  // "It ran and printed nothing" is a result, not an absence — but only for a
  // call whose output is the point: a shell command or an MCP call.
  if (
    model.outputSuppression === 'empty' &&
    !model.isError &&
    model.status === TOOL_USE_STATUS.COMPLETED &&
    (displayKind === 'bash' || isMcpToolName(toolName))
  ) {
    // prettier-ignore
    sections.push(html`<div class="tool-use-section tool-no-output">(no output)</div>`);
  }

  // Workflow scripts already have a compact live summary and can be very
  // large, so keep their source behind disclosure even while launching.
  const shouldOpen =
    model.isInProgress && toolName !== DELEGATE_MULTI_AGENTS_TOOL_NAME;

  // Live timer for in-progress tools, with timeout limit when available
  const toolTimeoutMs = getToolTimeoutMs(toolName, input);
  // prettier-ignore
  const timerTemplate = model.isInProgress ? html`<tool-timer .startTime=${row.timestamp} .timeoutMs=${toolTimeoutMs ?? 0}></tool-timer>` : undefined;

  // Delegation banner extras: setup link (shown in summary row)
  const isProposalBearingDelegation = Object.hasOwn(
    DELEGATION_TOOL_CATEGORY,
    toolName,
  );
  const proposal =
    isProposalBearingDelegation && !model.isInProgress
      ? parseDelegationToolInput(input, toolName)
      : null;

  // A real <button> (not a role="button" span) so wa-details' own summary
  // click handler recognizes it as interactive and skips its toggle — see
  // stopSummaryToggleKeydown for why the keydown path additionally needs an
  // explicit stopPropagation. The click binding carries the parsed proposal
  // itself, so nothing has to survive a round trip through a DOM attribute.
  // prettier-ignore
  const setupButton = proposal
    ? html`<button type="button" class="proposal-restore-link proposal-banner-setup" title="Setup this proposal configuration" @click=${(event: Event) => { event.preventDefault(); postMessage(PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG, { proposal }); }} @keydown=${stopSummaryToggleKeydown}>${waIcon('reply')} Setup</button>`
    : nothing;
  // prettier-ignore
  const extraContent = html`${timerTemplate ?? nothing}${model.spillPath ? buildSpillArtifactButton(model.spillPath) : nothing}${setupButton}`;

  return buildToolUseDetails({
    row,
    iconName,
    label: titleText,
    isError: showAsError,
    content: html`${sections}`,
    defaultOpen: shouldOpen,
    extraClasses: {
      'tool-use-user-feedback': model.isUserFeedback,
      'tool-use-in-progress': model.isInProgress,
    },
    extraContent,
  });
}
