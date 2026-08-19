// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { StreamHeader } from '@progressView/frontend/components/StreamHeader';
import { ELEMENT_IDS } from '@progressView/frontend/constants';
import type { StreamEventDetail } from '@progressView/frontend/events';
import {
  AgentCategory,
  STREAM_PHASE,
  createStreamState,
  type StreamTabInfo,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '@shared/schemas';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

// Local file imports
import {
  dispatchKey,
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function baseStream(overrides: Partial<StreamTabInfo> = {}): StreamTabInfo {
  return {
    name: 'stream-a',
    label: 'Stream A',
    identity: { kind: 'agent', agent: 'stream-a' },
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
    ...overrides,
  };
}

function baseState(
  overrides: Partial<ToolUseStreamState> = {},
): ToolUseStreamState {
  return createStreamState(AgentCategory.ToolUse, {
    status: STREAM_PHASE.RUNNING,
    ...overrides,
  }) as ToolUseStreamState;
}

function workflowState(
  overrides: Partial<WorkflowStreamState> = {},
): WorkflowStreamState {
  return createStreamState(AgentCategory.Workflow, {
    status: STREAM_PHASE.COMPLETED,
    files: {
      2: [
        {
          source: 'main.tex',
          round: 2,
          lineage: null,
          diff: null,
          location: {
            kind: 'runStorage',
            absolutePath: '/tmp/exec/answer.tex',
            relativePath: 'answer.tex',
            executionId: 'a1b2c3d4',
          },
        },
      ],
    },
    ...overrides,
  }) as WorkflowStreamState;
}

function mount(props: Partial<StreamHeader> = {}): Promise<StreamHeader> {
  return mountComponent<StreamHeader>('stream-header', {
    stream: baseStream(),
    state: baseState(),
    // Buttons default to hidden until the host confirms which commands it
    // supports (`isKnownUnsupported` treats `null` as "unknown, so hide").
    unsupportedCommands: new Set(),
    ...props,
  });
}

/** Themed-tooltip contract: anchor carries an id, no native title, sibling wa-tooltip[for=id]. */
function expectAnchoredTooltip(
  element: StreamHeader,
  anchorId: string,
  text: string,
): void {
  const anchor = element.shadowRoot?.querySelector(`#${anchorId}`);
  expect(anchor).toBeTruthy();
  expect(anchor?.hasAttribute('title')).toBe(false);

  const tooltip = element.shadowRoot?.querySelector(
    `wa-tooltip[for="${anchorId}"]`,
  );
  expect(tooltip).toBeTruthy();
  expect(tooltip?.textContent?.trim()).toBe(text);
}

// Single shared DOM/customElements registration for the whole file: each
// `useLitComponentTestDom` call tears down its jsdom window (and the
// customElements registry defined against it) in `afterAll`, and the
// `@progressView/frontend/components/StreamHeader` module — including its
// `customElements.define(...)` — only evaluates once thanks to ESM module
// caching. A second top-level call in this file would re-run against a
// fresh, unregistered window, silently leaving `stream-header` undefined for
// every test in that later block. Nest all suites under one registration
// instead of calling `useLitComponentTestDom` per describe.
describe('stream-header', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamHeader'),
  );

  /**
   * Regression coverage for the a11y-clickables audit: the "go to parent
   * stream" label was a bare `<span @click>` with no role/tabindex/keydown, so
   * keyboard users could never reach or activate it even though `.parent-link`
   * already shipped a `:focus-visible` outline. Mirrors FileList.ts's
   * file-path keyboard-activation coverage for the same "clickable label"
   * job.
   */
  describe('parent-link keyboard activation', () => {
    it('exposes role=button and tabindex=0 on the parent-link span', async () => {
      const element = await mount({
        stream: baseStream({ parentStreamId: 'assistant@123' }),
      });

      const link = element.shadowRoot?.querySelector('.parent-link');
      expect(link).toBeInstanceOf(HTMLElement);
      expect(link?.getAttribute('role')).toBe('button');
      expect(link?.getAttribute('tabindex')).toBe('0');
    });

    it('switches to the parent stream on Enter and Space, not on other keys', async () => {
      const element = await mount({
        stream: baseStream({ parentStreamId: 'assistant@123' }),
      });
      const switches: StreamEventDetail[] = [];
      element.addEventListener('stream-switch', (event) => {
        switches.push((event as CustomEvent<StreamEventDetail>).detail);
      });

      const link = element.shadowRoot?.querySelector('.parent-link');
      expect(link).toBeInstanceOf(HTMLElement);

      dispatchKey(link!, 'a');
      expect(switches).toHaveLength(0);

      dispatchKey(link!, 'Enter');
      dispatchKey(link!, ' ');

      expect(switches).toEqual([
        { streamId: 'assistant@123' },
        { streamId: 'assistant@123' },
      ]);
    });

    it('renders nothing when there is no parent stream', async () => {
      const element = await mount({ stream: baseStream() });
      expect(element.shadowRoot?.querySelector('.parent-link')).toBeFalsy();
    });
  });

  /**
   * Regression coverage for #8158: the goal chip (`wa-badge`) and progress
   * badge (`wa-tag`) used native `title=` hover labels while the rest of the
   * header (e.g. the status indicator, id `statusIndicator`) already uses the
   * themed `wa-tooltip[for=]` mechanism. Both anchors must expose an id with a
   * sibling `<wa-tooltip for=id>` and no native `title` attribute, matching the
   * status-indicator pattern.
   */
  describe('tooltips', () => {
    it('anchors the truncated stream label via wa-tooltip[for]', async () => {
      const element = await mount();
      // The label names the run; the opaque id rides along so it is
      // recoverable on hover without ever sitting in the header text.
      expectAnchoredTooltip(
        element,
        ELEMENT_IDS.ACTIVE_STREAM_NAME,
        'Stream A · stream-a',
      );
    });

    it('keeps the icon-only stream status accessible and available on hover', async () => {
      const element = await mount({
        state: baseState({ status: STREAM_PHASE.FAILED }),
      });
      const indicator = element.shadowRoot?.querySelector(
        `#${ELEMENT_IDS.STATUS_INDICATOR}`,
      );

      expect(indicator?.textContent?.trim()).toBe('');
      expect(indicator?.getAttribute('role')).toBe('img');
      expect(indicator?.getAttribute('aria-label')).toBe('Error');
      expectAnchoredTooltip(element, ELEMENT_IDS.STATUS_INDICATOR, 'Error');
    });

    it('anchors the goal chip tooltip via wa-tooltip[for], not a native title', async () => {
      const element = await mount({
        state: baseState({
          goalActive: true,
          goalStatus: 'active',
          goalObjective: 'ship the fix',
        }),
      });

      expectAnchoredTooltip(element, 'goalChip', 'Goal: ship the fix');
    });

    it('anchors the progress badge tooltip via wa-tooltip[for], not a native title', async () => {
      const element = await mount({
        state: baseState({ stage: { kind: 'round', index: 0, total: 2 } }),
      });

      expectAnchoredTooltip(element, 'progressBadge', 'Round 1 of 2');
    });

    it('omits the progress badge tooltip entirely when there is no title text', async () => {
      const element = await mount({});

      expect(element.shadowRoot?.querySelector('#progressBadge')).toBeFalsy();
      expect(
        element.shadowRoot?.querySelector('wa-tooltip[for="progressBadge"]'),
      ).toBeFalsy();
    });
  });

  /**
   * The badge's stage slot is the canonical discriminated `StreamStage`: a
   * workflow-script run advances through named phases, a tool-use run through
   * numbered rounds — one slot carries whichever this stream has.
   */
  describe('phase/round stage slot', () => {
    function badgeText(element: StreamHeader): string | undefined {
      return element.shadowRoot
        ?.querySelector(`#${ELEMENT_IDS.PROGRESS_BADGE}`)
        ?.textContent?.trim();
    }

    function badgeTooltip(element: StreamHeader): string | undefined {
      return element.shadowRoot
        ?.querySelector(`wa-tooltip[for="${ELEMENT_IDS.PROGRESS_BADGE}"]`)
        ?.textContent?.trim();
    }

    it.each<{
      name: string;
      props: Partial<StreamHeader>;
      text: string;
      tooltip: string;
    }>([
      {
        name: 'renders the phase label when the stream has one',
        props: {
          state: baseState({
            stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
          }),
        },
        text: 'Reduce 2/3',
        tooltip: 'Phase 2 of 3: Reduce',
      },
      {
        name: 'renders a dynamically opened phase with no declared position',
        props: {
          state: baseState({ stage: { kind: 'phase', label: 'Cleanup' } }),
        },
        text: 'Cleanup',
        tooltip: 'Phase: Cleanup',
      },
      {
        name: 'keeps the tool-call count alongside the phase',
        props: {
          state: baseState({
            stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
            conversationProgress: { toolCallCount: 4 },
          }),
        },
        text: 'Reduce 2/3, 4 tool calls',
        tooltip: 'Phase 2 of 3: Reduce, Tool calls: 4',
      },
    ])('$name', async ({ props, text, tooltip }) => {
      const element = await mount(props);

      expect(badgeText(element)).toBe(text);
      expect(badgeTooltip(element)).toBe(tooltip);
    });
  });

  /**
   * Regression coverage for consolidating the toolbar's wa-button-group +
   * external-tooltip workaround onto `renderIconActionButtonParts` (src/
   * shared/wa/actionButtons.ts): each toolbar button must anchor its own
   * `<wa-tooltip>` by id (not via a slotted child, which would break
   * wa-button-group's corner-fusion), and clicking a button must dispatch
   * `toolbar-command` directly — no more delegated `[data-command]` lookup.
   */
  describe('toolbar', () => {
    it('renders the stop button as a wa-button with a matching sibling tooltip', async () => {
      const element = await mount();

      const stopButton = element.shadowRoot?.querySelector<HTMLElement>(
        `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
      );
      expect(stopButton).toBeTruthy();
      expect(stopButton?.tagName).toBe('WA-BUTTON');
      expect(stopButton?.hasAttribute('data-command')).toBe(false);
      expect(stopButton?.querySelector('wa-icon')?.getAttribute('name')).toBe(
        'circle-stop',
      );

      const stopTooltip = element.shadowRoot?.querySelector(
        `wa-tooltip[for="${ELEMENT_IDS.STOP_STREAM_BTN}"]`,
      );
      expect(stopTooltip).toBeTruthy();
    });

    it('describes delegated-work approval with its run-scoped shared copy', async () => {
      const element = await mount({
        stream: baseStream({ agentCategory: AgentCategory.ToolUse }),
      });

      const tooltip = element.shadowRoot?.querySelector(
        `wa-tooltip[for="${ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN}"]`,
      );
      expect(tooltip?.textContent?.trim()).toBe(
        DELEGATION_APPROVAL_COPY.progressViewToggle,
      );
    });

    it('dispatches toolbar-command with the button-specific command on click', async () => {
      const element = await mount();
      const events: unknown[] = [];
      element.addEventListener('toolbar-command', (event) => {
        events.push((event as CustomEvent).detail);
      });

      const stopButton = element.shadowRoot?.querySelector<HTMLElement>(
        `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
      );
      stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ command: expect.any(String) });
    });
  });

  /**
   * The run-context copy is the one toolbar entry with no backend command: it
   * writes the clipboard from state the webview already holds. These pin that
   * it stays a local action (no `toolbar-command`) and that it only offers
   * itself when there is something to copy.
   */
  describe('copy run context', () => {
    it('writes the run context and dispatches no toolbar command', async () => {
      const element = await mount({
        stream: baseStream({
          model: 'gemini31p',
          modelLabel: 'Gemini 3.1 Pro',
          executionId: 'a1b2c3d4',
        }),
        state: workflowState(),
      });
      const commands: unknown[] = [];
      element.addEventListener('toolbar-command', (event) => {
        commands.push((event as CustomEvent).detail);
      });

      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      element.shadowRoot
        ?.querySelector<HTMLElement>(`#${ELEMENT_IDS.COPY_RUN_CONTEXT_BTN}`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      expect(writeText).toHaveBeenCalledWith(
        [
          'Workflow run: stream-a (Gemini 3.1 Pro)',
          'Execution: a1b2c3d4',
          '',
          'Outputs:',
          '- r3: /executions/a1b2c3d4/files/answer.tex (source: main.tex)',
        ].join('\n'),
      );
      expect(commands).toHaveLength(0);
      vi.unstubAllGlobals();
    });

    it('disables itself when the workflow produced nothing to copy', async () => {
      const element = await mount({
        state: workflowState({ files: {} }),
      });

      const button = element.shadowRoot?.querySelector(
        `#${ELEMENT_IDS.COPY_RUN_CONTEXT_BTN}`,
      );
      expect(button?.hasAttribute('disabled')).toBe(true);
    });

    it('is not offered on a tool-use stream', async () => {
      const element = await mount({
        stream: baseStream({ agentCategory: AgentCategory.ToolUse }),
        state: baseState(),
      });

      expect(
        element.shadowRoot?.querySelector(
          `#${ELEMENT_IDS.COPY_RUN_CONTEXT_BTN}`,
        ),
      ).toBeNull();
    });
  });
});
