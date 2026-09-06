// Desktop scenes: the real rail, workbench, and pane templates over folded
// SessionViews (one per paper), never hand-built stream fixtures. Screenshots
// of these are the verification for the desktop boards.
import { html, nothing, type TemplateResult } from 'lit';

import { createPdfPane } from '@desktop/renderer/pdfPane.js';
import { subagentsPaneTemplate } from '@desktop/renderer/subagentsPane.js';
import {
  conversationDockTemplate,
  paperChipTemplate,
  taskSidebarTemplate,
  workbenchTabsTemplate,
  type RailPaper,
} from '@desktop/renderer/taskShell.js';
import type { WorkbenchTab } from '@desktop/shared/desktopTaskShell.js';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';
import type { PaperDisplay } from '@shared/session/hostSnapshot';
import {
  emptySessionView,
  type SessionView,
  type StreamView,
} from '@shared/session/sessionView';
import type { Shell } from '@shared/session/shell';
import { emptySurface, type Surface } from '@shared/session/surface';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  BOARD_NOW,
  buildScenario,
  CHILD,
  fanOutView,
  foldAll,
  local,
  OWNER,
  ROOT,
  tail,
  withWaitingCall,
} from '@test/shared/session/fanOutScenario';

// ── fixtures: three papers, three folded views ────────────────────────────

/** The fan-out with nothing waiting: the same replay minus the approval. */
function runningOnlyView(): SessionView {
  const scenario = buildScenario();
  return foldAll([
    ...scenario.pending.filter(
      (input) =>
        !(input._tag === 'event' && input.event.type === 'approval.requested'),
    ),
    local({ self: [OWNER] }),
  ]);
}

/**
 * The fan-out with a chat on `search`: the shared fixture carries no
 * transcript rows on a tool-use stream, and the desktop boards show that
 * stream's conversation, so the child gets a user turn, two tool rows, and
 * the reply, all before its bash approval.
 */
function withConversation(): SessionView {
  const scenario = buildScenario();
  const { log } = scenario;
  const before = log.events.length;
  const LOG = STREAM_LOG_ENTRY_TYPES.LOG;
  // The chat lands three minutes ago, after the child started (BOARD_NOW).
  const CHAT = BOARD_NOW - 3 * 60_000;
  log.entry(CHILD, CHAT, {
    id: 'chat-user',
    type: LOG,
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    text: 'what should we do next',
  });
  log.entry(CHILD, CHAT + 10, {
    id: 'chat-bash',
    type: LOG,
    messageType: MESSAGE_TYPES.TOOL_USE,
    text: 'bash',
    data: {
      toolName: 'bash',
      input: { command: 'git status && echo "--- LOG ---" && git log -n 5' },
      output: 'On branch main\nnothing to commit, working tree clean',
      status: 'completed',
    },
  });
  log.entry(CHILD, CHAT + 20, {
    id: 'chat-glob',
    type: LOG,
    messageType: MESSAGE_TYPES.TOOL_USE,
    text: 'glob',
    data: {
      toolName: 'glob',
      input: { pattern: '*' },
      output: 'Found 18 files for "*" in .',
      status: 'completed',
    },
  });
  log.entry(CHILD, CHAT + 30, {
    id: 'chat-reply',
    type: LOG,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    text:
      'Two candidates for the next step. Section 2 still cites the retracted ' +
      'Palomar registry, and the soundness proof in Appendix B has an ' +
      "unproven lemma the reviewer flagged. I'd start with the citation fix " +
      'since it blocks the resubmission.',
  });
  const chat = log.events.slice(before).map(tail);
  return foldAll([...scenario.pending, ...chat, local({ self: [OWNER] })]);
}

const display = (
  key: string,
  name: string,
  subtitle: string,
): PaperDisplay => ({
  key,
  name,
  initials: key,
  subtitle,
});

function paper(
  displayRecord: PaperDisplay,
  view: SessionView,
  selected: StreamTabId | null = null,
): RailPaper {
  const surface: Surface = { ...emptySurface(displayRecord.key), selected };
  return { display: displayRecord, view, surface };
}

const LP = display('LP', 'LDT-Lean-Paper', 'Lean formalization · with JZF');
const CT = display('CT', 'CoolingTNS', 'Cooling bound · PRL draft');
const TN = display('TN', 'TNLean', 'Referee reply, round 2');
const CO = display('CO', 'coauthor', 'TeXRA source');

const shellOf = (
  active: string,
  open: readonly string[],
  collapsed: readonly string[] = open.filter((key) => key !== active),
): Shell => ({ active, open, collapsed });

const noop = () => {};
const sidebarCallbacks = {
  onNewTask: noop,
  onSearch: noop,
  onToggleFiles: noop,
  onOpenFolder: noop,
  onSelectPaper: noop,
  onClosePaper: noop,
  onTogglePaperCollapsed: noop,
  onOpenTerminal: noop,
  onOpenBrowser: noop,
  onOpenSettings: noop,
  onOpenLogs: noop,
  onOpenSubagents: noop,
};
const workbenchCallbacks = {
  onActivate: noop,
  onClose: noop,
  onHide: noop,
  onMove: noop,
};
const filesPlaceholder = document.createElement('div');

// ── real chrome over the fixtures ─────────────────────────────────────────

const rail = (
  papers: readonly RailPaper[],
  shell: Shell,
  options: { subagentsOpen?: boolean } = {},
) =>
  taskSidebarTemplate(
    {
      files: filesPlaceholder,
      filesExpanded: false,
      papers,
      shell,
      subagentsOpen: options.subagentsOpen ?? false,
      commandsLabel: 'Commands',
    },
    sidebarCallbacks,
  );

const iconBtn = (name: Parameters<typeof waIcon>[0], label: string) =>
  html`<wa-button
    appearance="plain"
    size="s"
    class="task-header-button icon-button is-size-l"
    aria-label=${label}
    title=${label}
    >${waIcon(name)}</wa-button
  >`;

/** The conversation pane as `main.ts` composes it: the desktop header row,
 *  then the one conversation shell's pieces for the selected stream. */
const conversationPane = (
  papers: readonly RailPaper[],
  active: RailPaper,
  stream: StreamView | undefined,
  body: TemplateResult | typeof nothing,
  options: { chip?: boolean; dock?: boolean } = {},
) =>
  html`<main class="task-conversation" aria-label="Task conversation">
    <header class="task-header">
      <span class="task-header-button-slot"
        >${iconBtn('chevron-left', 'Hide sidebar')}</span
      >
      ${
        options.chip === false
          ? nothing
          : paperChipTemplate(papers, active, noop)
      }
      <span class="task-header-spacer"></span>
      ${iconBtn('circle-stop', 'Stop')}${iconBtn('window-maximize', 'Layout')}${iconBtn('ellipsis', 'More')}
    </header>
    <div class="task-conversation-body">
      <section class="task-conversation-pane" data-pane="conversation">
        <div class="h-conv-col">${body}</div>
        ${
          options.dock === false
            ? nothing
            : html`<div class="h-dock">
                <session-composer
                  compact
                  .stream=${stream ?? null}
                  .surface=${active.surface}
                ></session-composer>
                ${conversationDockTemplate()}
              </div>`
        }
      </section>
    </div>
  </main>`;

/** What `progress-app` puts in the column for a selected stream: its header
 *  (label, ancestors path, status) over its transcript. */
const transcriptBody = (paper: RailPaper, stream: StreamView) =>
  html`<stream-header .stream=${stream} .view=${paper.view}></stream-header>
    <log-list .stream=${stream} .surface=${paper.surface}></log-list>`;

const pdfPane = createPdfPane();
const tab = (
  kind: WorkbenchTab['kind'],
  title: string,
  target?: string,
): WorkbenchTab => ({
  id: target ? `workbench:${kind}:${target}` : `workbench:${kind}`,
  kind,
  placement: 'right',
  title,
  ...(target ? { target } : {}),
});

const workbench = (
  session: string,
  tabs: readonly WorkbenchTab[],
  activeId: string,
  content: TemplateResult | HTMLElement,
) =>
  html`<aside class="task-workbench" data-placement="right">
    ${workbenchTabsTemplate(tabs, activeId, 'right', workbenchCallbacks, session)}
    <div class="task-workbench-body">
      <section class="task-workbench-pane">
        <div class="task-workbench-surface">${content}</div>
      </section>
    </div>
  </aside>`;

const desktopFrame = (cols: string, ...panes: TemplateResult[]) =>
  html`<div class="h-desktop" id="frame" style="grid-template-columns:${cols}">
    ${panes}
  </div>`;

// ── scenes ────────────────────────────────────────────────────────────────

/** Plan 3: papers as sections; the selected conversation (the fixture's
 *  chat transcript is the child's); the PDF in the workbench. */
function sceneDesktopPapers(): TemplateResult {
  const lp = paper(LP, withConversation(), CHILD);
  const papers = [lp, paper(CT, runningOnlyView()), paper(TN, fanOutView())];
  const stream = lp.view.streams.get(CHILD);
  const tabs = [
    tab('pdf', 'main.pdf', '/paper/main.pdf'),
    tab('editor', 'section2.tex', '/paper/section2.tex'),
    tab('terminal', 'Terminal', '/paper'),
  ];
  return desktopFrame(
    '288px minmax(0,1fr) 440px',
    rail(papers, shellOf('LP', ['LP', 'CT', 'TN'])),
    conversationPane(
      papers,
      lp,
      stream,
      stream ? transcriptBody(lp, stream) : nothing,
    ),
    workbench(lp.display.key, tabs, tabs[0].id, pdfPane.frameFor(tabs[0])),
  );
}

/** The rail with one paper open: the sections layout already reads as the
 *  Plan 2 switcher card (mark, name, folder, badge, Add paper). */
function sceneDesktopOnePaper(): TemplateResult {
  const lp = paper(LP, withConversation(), CHILD);
  const papers = [lp];
  const stream = lp.view.streams.get(CHILD);
  return desktopFrame(
    '288px minmax(0,1fr)',
    rail(papers, shellOf('LP', ['LP'])),
    conversationPane(
      papers,
      lp,
      stream,
      stream ? transcriptBody(lp, stream) : nothing,
    ),
  );
}

/** A paper with no streams is a distinct Surface with its own composer
 *  (PRD 9): its section is empty, the conversation is the launch state, and
 *  the other papers keep their badges. The running paper's row is folded so
 *  its badge shows beside the waiting paper's amber one. */
function sceneDesktopEmptyPaper(): TemplateResult {
  const co = paper(CO, emptySessionView(CO.key));
  const papers = [co, paper(CT, runningOnlyView()), paper(TN, fanOutView())];
  return desktopFrame(
    '288px minmax(0,1fr)',
    rail(papers, shellOf('CO', ['CO', 'CT', 'TN'])),
    conversationPane(
      papers,
      co,
      undefined,
      html`<div class="h-hero">
        <h1>What are you working on?</h1>
        <p>${co.display.name} has no tasks yet.</p>
      </div>`,
    ),
  );
}

/** The window at 900 px: the rail keeps its 288 px and the conversation
 *  column takes what is left; the workbench is closed. */
function sceneDesktopNarrow(): TemplateResult {
  const lp = paper(LP, withConversation(), CHILD);
  const papers = [lp, paper(CT, runningOnlyView()), paper(TN, fanOutView())];
  const stream = lp.view.streams.get(CHILD);
  return html`<div
    class="h-desktop"
    id="frame"
    style="grid-template-columns:288px minmax(0,1fr);width:900px"
  >
    ${rail(papers, shellOf('LP', ['LP', 'CT', 'TN']))}
    ${conversationPane(
      papers,
      lp,
      stream,
      stream ? transcriptBody(lp, stream) : nothing,
    )}
  </div>`;
}

/** Desktop 5: the rail lists top-level streams only while the Subagents
 *  workbench tab owns the tree; a child is selected. */
function sceneDesktopSubagents(): TemplateResult {
  const lp = paper(LP, withConversation(), CHILD);
  const papers = [lp, paper(CT, runningOnlyView()), paper(TN, fanOutView())];
  const stream = lp.view.streams.get(CHILD);
  const root = lp.view.streams.get(ROOT);
  const tabs = [
    tab('subagents', `Subagents · ${root?.rollup.total ?? 0}`),
    tab('pdf', 'main.pdf', '/paper/main.pdf'),
  ];
  return desktopFrame(
    '288px minmax(0,1fr) 400px',
    rail(papers, shellOf('LP', ['LP', 'CT', 'TN']), { subagentsOpen: true }),
    conversationPane(
      papers,
      lp,
      stream,
      stream ? transcriptBody(lp, stream) : nothing,
    ),
    workbench(
      lp.display.key,
      tabs,
      tabs[0].id,
      subagentsPaneTemplate({
        view: lp.view,
        surface: lp.surface,
        selected: CHILD,
      }),
    ),
  );
}

/** W2: the run board with its summary line in the conversation pane; the
 *  rail shows the parent only. */
function sceneDesktopRun(): TemplateResult {
  const view = withWaitingCall();
  const rootId = view.order.find(
    (id) => view.streams.get(id)?.category === 'workflow',
  );
  const co = paper(CO, view, rootId ?? null);
  const papers = [co, paper(LP, fanOutView())];
  const stream = rootId ? view.streams.get(rootId) : undefined;
  return desktopFrame(
    '288px minmax(0,1fr)',
    rail(papers, shellOf('CO', ['CO', 'LP'])),
    conversationPane(
      papers,
      co,
      stream,
      stream?.category === 'workflow'
        ? html`<workflow-run-board
            summary
            .stream=${stream}
            .view=${view}
            .surface=${co.surface}
            .nowMs=${BOARD_NOW}
          ></workflow-run-board>`
        : nothing,
      { chip: false, dock: false },
    ),
  );
}

export const desktopScenes: Record<string, () => TemplateResult> = {
  'desktop-papers': sceneDesktopPapers,
  'desktop-one-paper': sceneDesktopOnePaper,
  'desktop-empty-paper': sceneDesktopEmptyPaper,
  'desktop-narrow': sceneDesktopNarrow,
  'desktop-subagents': sceneDesktopSubagents,
  'desktop-run': sceneDesktopRun,
};
