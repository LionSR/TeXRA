// Extension scenes: the real `<progress-app>` shell over folded SessionViews
// and a Surface, never hand-built stream fixtures. Screenshots of these are
// the verification for the extension boards (Real-ExtensionNew, -Session,
// -Drawer, -Wide, -Tools, -Proposal, -Inline).
import { html, type TemplateResult } from 'lit';

import { AgentCategory, type MissingTool } from '@shared/schemas';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import {
  applySurfaceAction,
  emptySurface,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import {
  buildScenario,
  CHILD,
  fanOutView,
  foldAll,
  GRANDCHILD,
  local,
  Log,
  OWNER,
  PROCESS,
  ROOT,
  subscribe,
  T,
  tail,
  withInterruptedChild,
  withoutApproval,
  withProposal,
  withWaitingGrandchild,
} from '@test/shared/session/fanOutScenario';

// ── the host snapshot: one project, the catalogs the composer and sheet read ──

const PROJECT = {
  key: '/paper',
  name: 'LDT-Lean-Paper',
  initials: 'LP',
  subtitle: '~/papers/ldt-lean',
};

function host(): HostSnapshot {
  return {
    ...emptyHostSnapshot(PROJECT),
    agentOptions: {
      toolUse: [
        { value: 'orchestrator', label: 'orchestrator', isOrchestrator: true },
        { value: 'polish', label: 'polish' },
        { value: 'search', label: 'search' },
      ],
      workflow: [
        { value: 'correct', label: 'correct' },
        { value: 'review', label: 'review', rounds: 3 },
      ],
    },
    modelOptions: [
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { value: 'gpt-5.6', label: 'GPT 5.6' },
      { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    ],
    teamOptions: [
      {
        value: 'review-team',
        label: 'Review team',
        source: 'built-in',
        icon: 'users',
        description: 'Scout, review, verify.',
        unavailableMembers: [],
      },
    ],
    workspaceRoots: [{ value: '/paper', label: 'ldt-lean' }],
    fileOptions: {
      baseFile: ['main.tex', 'section2.tex', 'appendixB.tex'],
      editedFile: ['main_polish.tex', 'main_review.tex'],
      commit: [
        'HEAD',
        'HEAD~1',
        'a1f3c2 Fix lemma B.3',
        '9be0d4 Section 2 rewrite',
      ],
    },
    isGitRepo: true,
  };
}

// ── the surface: the launch selections and a draft, then the scene's action ──

function surface(view: SessionView, ...actions: SurfaceAction[]): Surface {
  const base: SurfaceAction[] = [
    {
      kind: 'launch',
      patch: {
        inputFiles: ['main.tex'],
        contextFiles: ['library.bib'],
        agent: 'orchestrator',
        model: 'gemini-3.8-flash',
        baseFile: 'main.tex',
        editedFile: 'main_polish.tex',
      },
    },
    { kind: 'expand', runId: ROOT, expanded: true },
    {
      kind: 'draft',
      runId: CHILD,
      patch: { text: 'Check appendix B before the Palomar claim' },
    },
  ];
  return [...base, ...actions].reduce(
    applySurfaceAction,
    emptySurface(view.key),
  );
}

// ── frames ──────────────────────────────────────────────────────────────

function sidebar(
  view: SessionView,
  surfaceRecord: Surface,
  hostRecord = host(),
): TemplateResult {
  return html`<div class="h-ext" id="frame">
    <div class="h-vscode-strip">
      <span>New Agent</span><span class="active">TeXRA</span
      ><span>Terminal</span>
    </div>
    <progress-app
      .view=${view}
      .surface=${surfaceRecord}
      .host=${hostRecord}
    ></progress-app>
  </div>`;
}

/** A first open: no sessions yet, the host's notices as the funnel and
 *  the folder leave them. */
const LATEXINDENT: MissingTool = {
  id: 'latexindent',
  label: 'latexindent',
  interchangeable: false,
  usedFor: 'format .tex files',
};
const IMAGE_TOOLS: MissingTool[] = ['GraphicsMagick', 'ImageMagick'].map(
  (label) => ({
    id: label === 'GraphicsMagick' ? 'gm' : 'magick',
    label,
    interchangeable: true,
    usedFor: 'turn PDF figures into images',
  }),
);

function firstRun(
  onboarding: HostSnapshot['onboarding'],
  missingTools: MissingTool[] = [LATEXINDENT],
): TemplateResult {
  const view = emptySessionView(PROJECT.key);
  const base = host();
  return sidebar(view, surface(view, { kind: 'selectNew' }), {
    ...base,
    onboarding,
    banners: {
      ...base.banners,
      dependency: {
        visible: true,
        missingTools,
      },
      gettingStarted: true,
    },
  });
}

/** The desktop app's center column: the same element, its own chrome
 *  (rail, header) drawn by the desktop shell around it. */
function desktopColumn(
  view: SessionView,
  surfaceRecord: Surface,
): TemplateResult {
  return html`<div class="h-ext h-ext-wide" id="frame">
    <progress-app
      .view=${view}
      .surface=${surfaceRecord}
      .host=${host()}
      placement="desktop"
    ></progress-app>
  </div>`;
}

function editorTab(view: SessionView, surfaceRecord: Surface): TemplateResult {
  return html`<div class="h-ext h-ext-wide" id="frame">
    <div class="h-vscode-strip">
      <span>TeXRA Settings</span><span class="active">TeXRA Tasks</span>
    </div>
    <progress-app
      .view=${view}
      .surface=${surfaceRecord}
      .host=${host()}
      placement="editor"
    ></progress-app>
  </div>`;
}

// ── scenes ──────────────────────────────────────────────────────────────

export const extensionScenes: Record<string, () => TemplateResult> = {
  // Real-ExtensionNew: the empty state with an Active now strip.
  'ext-new': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'selectNew' }));
  },
  // First open with a key: the setup funnel, no .tex yet, a missing tool.
  'ext-first-run': () => firstRun('setup'),
  // Setup done, still no .tex in the folder: the project starter.
  'ext-no-tex': () => firstRun('done', [LATEXINDENT, ...IMAGE_TOOLS]),
  // First open without a credential: the welcome card.
  'ext-no-credential': () => firstRun('needs-credential'),
  // The desktop placement of the same shell, inside a run.
  'desktop-placement': () => {
    const view = fanOutView();
    return desktopColumn(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // Two run grants on: the header's switches (the ⋯ menu's at 420px).
  'ext-auto-approve': () => {
    const view = fanOutView();
    view.policy.set(CHILD, {
      policy: 'ask',
      bypasses: { toolEdit: true, bash: true, superYolo: false },
      own: {},
      goal: [],
    });
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // Real-ExtensionSession: inside the child, with the ancestor path (its
  // workflow parent takes no replies, so no goes-to line).
  'ext-session': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // ExtE-Tree: the drawer with the root collapsed under its rollup pill,
  // nothing pending to force the path open (the surface says collapsed).
  'ext-tree': () => {
    const view = withoutApproval();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'expand', runId: ROOT, expanded: false },
        { kind: 'select', runId: ROOT },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // ExtE-Tree: a waiting grandchild forces the path open and badges it.
  'ext-waiting-grandchild': () => {
    const view = withWaitingGrandchild();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'expand', runId: ROOT, expanded: false },
        { kind: 'select', runId: GRANDCHILD },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // ExtE-Tree: an interrupted child, its path forced open, Resume on the
  // row.
  'ext-interrupted': () => {
    const view = withInterruptedChild();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'expand', runId: ROOT, expanded: false },
        { kind: 'select', runId: CHILD },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // Coming back to a finished session: the child has completed, so where
  // its composer stood the dock says so and offers the way forward.
  'ext-finished': () => {
    const view = foldAll([...buildScenario().events, local({ self: [OWNER] })]);
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // The same, on the finished workflow root: the board, then the dock.
  'ext-finished-workflow': () => {
    const view = foldAll([...buildScenario().events, local({ self: [OWNER] })]);
    return sidebar(view, surface(view, { kind: 'select', runId: ROOT }));
  },
  // An interrupted child with the drawer shut: the dock's Resume.
  'ext-interrupted-run': () => {
    const view = withInterruptedChild();
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // Real-ExtensionDrawer: the Sessions drawer over the same conversation.
  'ext-drawer': () => {
    const view = fanOutView();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'select', runId: CHILD },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // Real-ExtensionWide: the editor tab at 1100px, the list docked.
  'ext-wide': () => {
    const view = fanOutView();
    return editorTab(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // Real-ExtensionTools: the Tools sheet with the real latexdiffs-section.
  'ext-tools': () => {
    const view = fanOutView();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'select', runId: CHILD },
        { kind: 'toolsSheet', open: true },
      ),
    );
  },
  // Real-ExtensionProposal: the script's agent request on the root.
  'ext-proposal': () => {
    const view = withProposal();
    return sidebar(view, surface(view, { kind: 'select', runId: ROOT }));
  },
  // Real-ExtensionInline: the dispatch card inside the child that fanned
  // out (the root is a background script, whose calls its stage lists).
  'ext-inline': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // The running script on its root: the card's one agent at work.
  'ext-script-running': () => {
    const view = withoutApproval();
    return sidebar(view, surface(view, { kind: 'select', runId: ROOT }));
  },
  // The finished script with priced turns on the root, its agent and that
  // agent's own agent: the card and the footer read the tree total.
  'ext-cost': () => {
    const { log, events } = buildScenario();
    const priced = (
      [
        [ROOT, 0.12],
        [CHILD, 0.21],
        [GRANDCHILD, 0.51],
      ] as const
    ).map(([id, cost]) =>
      tail(
        log.emit(id, T.rootDone, {
          type: 'usage',
          usage: { inputTokens: 12_000, outputTokens: 900, cost },
        }),
      ),
    );
    const view = foldAll([...events, ...priced, local({ self: [OWNER] })]);
    return sidebar(view, surface(view, { kind: 'select', runId: ROOT }));
  },
  // A workflow task in its second pass: the header's "Pass 2 of 3" chip.
  'ext-workflow-pass': () => {
    const log = new Log();
    log.emit(ROOT, T.root, {
      type: 'run.start',
      identity: { kind: 'agent', agent: 'review' },
      category: AgentCategory.Workflow,
      worktree: { workingDirectory: '/paper', branch: 'main' },
      parent: null,
      provenance: null,
      userFollowUpSupport: 'unsupported',
    });
    log.emit(ROOT, T.root, {
      type: 'run.activate',
      category: AgentCategory.Workflow,
    });
    log.emit(ROOT, T.root + 1, {
      type: 'run.position',
      payload: { family: 'toolUse', at: 'turn.begin', turn: 2 },
    });
    const view = foldAll([
      subscribe(ROOT),
      ...log.events.map(tail),
      log.drained(),
      local({ self: [OWNER] }),
    ]);
    return editorTab(view, surface(view, { kind: 'select', runId: ROOT }));
  },
  // The background process stream: its command strip over its raw output.
  'ext-process': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', runId: PROCESS }));
  },
};
