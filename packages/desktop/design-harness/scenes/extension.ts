// Extension scenes: the real `<progress-app>` shell over folded SessionViews
// and a Surface, never hand-built stream fixtures. Screenshots of these are
// the verification for the extension boards (Real-ExtensionNew, -Session,
// -Drawer, -Wide, -Tools, -Proposal, -Inline).
import { html, type TemplateResult } from 'lit';

import { DOCUMENTS_OUTPUT_ARM } from '@shared/plugins/documents';
import {
  AgentConfigFieldsSchema,
  emptyRunEndOutput,
  MESSAGE_TYPES,
  RunIdSchema,
  type MissingTool,
} from '@shared/schemas';
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
  OTHER_OWNER,
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
    agentOptions: [
      { value: 'orchestrator', label: 'orchestrator', isOrchestrator: true },
      { value: 'polish', label: 'polish' },
      { value: 'search', label: 'search' },
      { value: 'correct', label: 'correct', rounds: 1 },
      { value: 'review', label: 'review', rounds: 3 },
    ],
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

/** Two tasks a TeXRA that has since closed left mid-turn, by title: the
 *  first with two agents (one done), the second's agent from a plugin that
 *  is off now. What the open-time notice lists. */
const REVIEW_TASK = RunIdSchema.parse('a1a1a1a1a1a1');
const ABSTRACT_TASK = RunIdSchema.parse('a2a2a2a2a2a2');
function interruptedTasksView(): SessionView {
  const log = new Log();
  const tasks = [
    [REVIEW_TASK, 'Review and fix chapter 2', T.root],
    [ABSTRACT_TASK, 'Polish abstract', T.child],
  ] as const;
  for (const [id, title, at] of tasks) {
    log.emit(
      id,
      at,
      {
        type: 'run.start',
        identity: { kind: 'agent', agent: 'assistant' },
        worktree: { workingDirectory: '/paper', branch: 'main' },
        parent: null,
        provenance: null,
        userFollowUpSupport: 'nativeInteractive',
      },
      OTHER_OWNER,
    );
    log.emit(id, at, { type: 'run.activate' }, OTHER_OWNER);
    log.emit(
      id,
      at + 1,
      { type: 'run.description', description: title, by: 'model' },
      OTHER_OWNER,
    );
  }
  const referees = [
    RunIdSchema.parse('a3a3a3a3a3a3'),
    RunIdSchema.parse('a4a4a4a4a4a4'),
  ];
  for (const [index, id] of referees.entries()) {
    log.emit(
      id,
      T.childProgress,
      {
        type: 'run.start',
        identity: { kind: 'agent', agent: `referee-${index + 1}` },
        parent: log.parent(REVIEW_TASK),
        provenance: null,
        userFollowUpSupport: 'nativeInteractive',
      },
      OTHER_OWNER,
    );
    log.emit(id, T.childProgress, { type: 'run.activate' }, OTHER_OWNER);
  }
  log.emit(
    referees[0],
    T.grandchildDone,
    {
      type: 'run.end',
      outcome: 'completed',
      output: emptyRunEndOutput(),
    },
    OTHER_OWNER,
  );
  return foldAll([
    ...log.events.map(tail),
    log.drained(),
    local({
      self: [OWNER],
      dead: [OTHER_OWNER],
      resumeBlocked: [
        {
          runId: ABSTRACT_TASK,
          reason: { kind: 'pluginOff', name: 'zotero' },
          retry: false,
        },
      ],
    }),
  ]);
}

/** A finished conversation of two turns, and a fork of it at the end of
 *  its first turn, which this window holds, waiting for a message. */
const FORK_SOURCE = RunIdSchema.parse('f1f1f1f1f1f1');
const FORK = RunIdSchema.parse('f2f2f2f2f2f2');
function forkView(): SessionView {
  const log = new Log();
  const start = (
    id: typeof FORK,
    at: number,
    provenance: null | {
      kind: 'fork';
      from: { id: typeof FORK; uid: string };
      at: number;
    },
  ) => {
    log.emit(id, at, {
      type: 'run.start',
      identity: { kind: 'agent', agent: 'assistant' },
      worktree: { workingDirectory: '/paper', branch: 'main' },
      parent: null,
      provenance,
      userFollowUpSupport: 'nativeInteractive',
    });
    log.emit(id, at, { type: 'run.activate' });
  };
  const say = (id: typeof FORK, at: number, text: string) =>
    log.emit(id, at, {
      type: 'log',
      level: 'info',
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      message: text,
    });
  const answer = (id: typeof FORK, at: number, text: string) =>
    log.emit(id, at, {
      type: 'log',
      level: 'info',
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      message: text,
    });
  const park = (id: typeof FORK, at: number, turn: number) =>
    log.emit(id, at, {
      type: 'run.position',
      payload: { family: 'toolUse', at: 'waiting', turn },
    });
  start(FORK_SOURCE, T.root, null);
  log.emit(FORK_SOURCE, T.root, {
    type: 'run.description',
    description: 'Polish abstract',
    by: 'user',
  });
  say(FORK_SOURCE, T.root, 'Tighten the abstract to 150 words.');
  answer(FORK_SOURCE, T.root + 30_000, 'Done: the abstract is now 148 words.');
  const firstPark = park(FORK_SOURCE, T.root + 31_000, 1);
  say(FORK_SOURCE, T.child, 'Now make it sound less formal.');
  answer(FORK_SOURCE, T.child + 20_000, 'Rewritten in a plainer voice.');
  park(FORK_SOURCE, T.child + 21_000, 2);
  log.emit(FORK_SOURCE, T.child + 22_000, {
    type: 'run.end',
    outcome: 'completed',
    output: emptyRunEndOutput(),
  });
  start(FORK, T.childDone, {
    kind: 'fork',
    from: { id: FORK_SOURCE, uid: log.parent(FORK_SOURCE).uid },
    at: firstPark.seq,
  });
  log.emit(FORK, T.childDone, {
    type: 'run.description',
    description: 'Polish abstract',
    by: 'user',
  });
  park(FORK, T.childDone + 1, 1);
  return foldAll([
    subscribe(FORK_SOURCE, FORK),
    ...log.events.map(tail),
    log.drained(),
    local({ self: [OWNER] }),
  ]);
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
  // First open without a credential: the "Connect a model" card.
  'ext-no-credential': () => firstRun('needs-credential'),
  // A credential that worked stopped working: the banner, not the card.
  'ext-credential-lost': () => {
    const view = emptySessionView(PROJECT.key);
    const base = host();
    return sidebar(view, surface(view, { kind: 'selectNew' }), {
      ...base,
      banners: { ...base.banners, apiKey: { visible: true } },
    });
  },
  // The desktop placement of the same shell, inside a run.
  'desktop-placement': () => {
    const view = fanOutView();
    return desktopColumn(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // Two run grants on: the header's read-only chips, each revocable.
  'ext-auto-approve': () => {
    const view = fanOutView();
    view.policy.set(CHILD, { own: { toolEdit: 'on', bash: 'on' }, goal: [] });
    return sidebar(view, surface(view, { kind: 'select', runId: CHILD }));
  },
  // The same grants in the desktop's wide column.
  'desktop-auto-approve': () => {
    const view = fanOutView();
    view.policy.set(CHILD, { own: { toolEdit: 'on', bash: 'on' }, goal: [] });
    return desktopColumn(view, surface(view, { kind: 'select', runId: CHILD }));
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
  // Opening after a crash: the notice above the composer lists the
  // interrupted tasks, the blocked one with its fix.
  'ext-interrupted-open': () => {
    const view = interruptedTasksView();
    return sidebar(view, surface(view, { kind: 'selectNew' }));
  },
  // The blocked task itself: its ended line says what it waits for, with
  // the one Resume and the fix, under the notice until "Not now".
  'ext-interrupted-blocked': () => {
    const view = interruptedTasksView();
    return sidebar(
      view,
      surface(view, { kind: 'select', runId: ABSTRACT_TASK }),
    );
  },
  // The desktop's project column at open, over the same tasks.
  'desktop-interrupted-open': () => {
    const view = interruptedTasksView();
    return desktopColumn(view, surface(view, { kind: 'selectNew' }));
  },
  // A fork waiting for its first message: where it came from, its header
  // link back, and the composer.
  'ext-forked': () => {
    const view = forkView();
    return sidebar(view, surface(view, { kind: 'select', runId: FORK }));
  },
  // The fork's source, finished: Fork on its ended line, and its user
  // messages' Fork from here (on hover).
  'ext-fork-source': () => {
    const view = forkView();
    return sidebar(view, surface(view, { kind: 'select', runId: FORK_SOURCE }));
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
  // A document task past its second pass: the header's "Pass 2 of 3" chip.
  'ext-workflow-pass': () => {
    const log = new Log();
    log.emit(ROOT, T.root, {
      type: 'run.start',
      identity: { kind: 'agent', agent: 'review' },
      worktree: { workingDirectory: '/paper', branch: 'main' },
      parent: null,
      provenance: null,
      userFollowUpSupport: 'unsupported',
    });
    log.emit(ROOT, T.root, {
      type: 'run.config',
      config: AgentConfigFieldsSchema.parse({
        agent: 'review',
        script: {
          code: 'return await tools.document_propose({});',
          title: 'review',
          tools: ['agent'],
          kind: 'recipe',
        },
      }),
    });
    log.emit(ROOT, T.root, { type: 'run.activate' });
    log.emit(ROOT, T.root + 1, {
      type: 'plugin.fact',
      plugin: DOCUMENTS_OUTPUT_ARM.plugin,
      kind: DOCUMENTS_OUTPUT_ARM.kind,
      version: DOCUMENTS_OUTPUT_ARM.version,
      parent: null,
      value: {
        rounds: [0, 1].map((round) => ({
          round,
          rawOutput: null,
          outputs: [],
          compileFailures: [],
          missingOutputs: [],
        })),
      },
    });
    log.emit(ROOT, T.root + 2, {
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
