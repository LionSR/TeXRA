/**
 * Shared `<stream-header>` wiring for the stream-content containers.
 *
 * The tool-use, workflow, and process containers each render an identical
 * `<stream-header>`; the only variation is the bypass/goal fields, which
 * exist only on tool-use state. Centralizing it here keeps the header
 * contract in one place so adding a prop touches a single call site.
 */

// Third-party imports
import { html, type TemplateResult } from 'lit';

// Local imports - shared schemas
import {
  isToolUseState,
  type StreamState,
  type StreamTabInfo,
} from '@shared/schemas';

// Side-effect import - register the <stream-header> element
import './StreamHeader';

/**
 * Render the stream header for a container. Bypass and goal indicators are only
 * meaningful for tool-use streams; workflow/process states report them as off.
 */
export function renderStreamHeader(
  streamInfo: StreamTabInfo,
  state: StreamState,
  unsupportedCommands: ReadonlySet<string> | null,
): TemplateResult {
  const toolUse = isToolUseState(state) ? state : null;
  return html`
    <stream-header
      .stream=${streamInfo}
      .status=${state.status}
      .substate=${state.substate}
      .progress=${state.conversationProgress}
      .stage=${state.stage}
      .yoloActive=${Boolean(toolUse?.toolEditBypass)}
      .superYoloActive=${Boolean(toolUse?.superYoloBypass)}
      .goalActive=${Boolean(toolUse?.goalActive)}
      .goalStatus=${toolUse?.goalStatus ?? ''}
      .goalObjective=${toolUse?.goalObjective ?? ''}
      .unsupportedCommands=${unsupportedCommands}
    ></stream-header>
  `;
}
