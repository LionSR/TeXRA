// Extension scenes: the real `<progress-app>` shell over folded SessionViews
// and a Surface, never hand-built stream fixtures. Screenshots of these are
// the verification for the extension boards (Real-ExtensionNew, -Session,
// -Drawer, -Wide, -Tools, -Proposal, -Inline).
import { html, type TemplateResult } from 'lit';

import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import type { SessionView } from '@shared/session/sessionView';
import {
  applySurfaceAction,
  emptySurface,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import { FILE_SELECT_CONFIGS } from '@shared/launcher/fileSelectConfigs';
import {
  BOARD_NOW,
  CHILD,
  fanOutView,
  GRANDCHILD,
  PROCESS,
  ROOT,
  withInterruptedChild,
  withoutApproval,
  withProposal,
  withWaitingGrandchild,
} from '@test/shared/session/fanOutScenario';

// ── the host snapshot: one paper, the catalogs the composer and sheet read ──

const PAPER = {
  key: '/paper',
  name: 'LDT-Lean-Paper',
  initials: 'LP',
  subtitle: '~/papers/ldt-lean',
};

function host(): HostSnapshot {
  return {
    ...emptyHostSnapshot(PAPER),
    agentOptions: {
      toolUse: [
        { value: 'orchestrator', label: 'orchestrator', isOrchestrator: true },
        { value: 'polish', label: 'polish' },
        { value: 'search', label: 'search' },
      ],
      workflow: [
        { value: 'correct', label: 'correct' },
        { value: 'review', label: 'review' },
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
    fileConfigs: FILE_SELECT_CONFIGS,
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
    debugMode: true,
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
        agent: { toolUse: 'orchestrator', workflow: 'correct' },
        model: 'gemini-3.8-flash',
        baseFile: 'main.tex',
        editedFile: 'main_polish.tex',
      },
    },
    { kind: 'expand', streamId: ROOT, override: 'expanded' },
    {
      kind: 'draft',
      streamId: CHILD,
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
      .nowMs=${BOARD_NOW}
    ></progress-app>
  </div>`;
}

function editorTab(view: SessionView, surfaceRecord: Surface): TemplateResult {
  return html`<div class="h-ext h-ext-wide" id="frame">
    <div class="h-vscode-strip">
      <span>TeXRA Dashboard</span><span class="active">TeXRA Progress</span>
    </div>
    <progress-app
      .view=${view}
      .surface=${surfaceRecord}
      .host=${host()}
      placement="editor"
      .nowMs=${BOARD_NOW}
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
  // Real-ExtensionSession: inside the child, with the ancestor path and the
  // goes-to line.
  'ext-session': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', streamId: CHILD }));
  },
  // ExtE-Tree: the drawer with the root collapsed under its rollup pill,
  // nothing pending to force the path open (the override says collapsed).
  'ext-tree': () => {
    const view = withoutApproval();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'expand', streamId: ROOT, override: 'collapsed' },
        { kind: 'select', streamId: ROOT },
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
        { kind: 'expand', streamId: ROOT, override: 'collapsed' },
        { kind: 'select', streamId: GRANDCHILD },
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
        { kind: 'expand', streamId: ROOT, override: 'collapsed' },
        { kind: 'select', streamId: CHILD },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // Real-ExtensionDrawer: the Sessions drawer over the same conversation.
  'ext-drawer': () => {
    const view = fanOutView();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'select', streamId: CHILD },
        { kind: 'drawer', open: true },
      ),
    );
  },
  // Real-ExtensionWide: the editor tab at 1100px, the list docked.
  'ext-wide': () => {
    const view = fanOutView();
    return editorTab(view, surface(view, { kind: 'select', streamId: CHILD }));
  },
  // Real-ExtensionTools: the Tools sheet with the real latexdiffs-section.
  'ext-tools': () => {
    const view = fanOutView();
    return sidebar(
      view,
      surface(
        view,
        { kind: 'select', streamId: CHILD },
        { kind: 'toolsSheet', open: true },
      ),
    );
  },
  // Real-ExtensionProposal: the workflow-script proposal card on the root.
  'ext-proposal': () => {
    const view = withProposal();
    return sidebar(view, surface(view, { kind: 'select', streamId: ROOT }));
  },
  // Real-ExtensionInline: the dispatch card inside the child that fanned
  // out (the root is a workflow run, whose calls the run board lists).
  'ext-inline': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', streamId: CHILD }));
  },
  // The background process stream: its command strip over its raw output.
  'ext-process': () => {
    const view = fanOutView();
    return sidebar(view, surface(view, { kind: 'select', streamId: PROCESS }));
  },
};
