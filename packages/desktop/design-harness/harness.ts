// Design harness: renders the proposed shell layouts with the real TeXRA
// components (stream-tabs, stream-header, follow-up-input) and Web Awesome
// controls on fixture data. Untracked; screenshots feed the design canvas.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import '../src/renderer/styles.css';
import '../src/renderer/themeTokens.css';
import '../src/renderer/taskShell.css';
import '@shared/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@progressView/frontend';
import '@webview/frontend';
import { html, nothing, render, type TemplateResult } from 'lit';

import { desktopScenes } from './scenes/desktop';
import { runBoard, runBoardBar } from './scenes/runBoard';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  createStreamState,
  type StreamState,
} from '@shared/schemas/streamState';
import type { StreamTabInfo } from '@shared/schemas';

// ── fixtures ────────────────────────────────────────────────────────────
const now = Date.now();
const min = (n: number) => n * 60_000;
type Tab = StreamTabInfo;
const agentTab = (
  name: string,
  label: string,
  o: {
    model?: string;
    modelLabel?: string;
    description?: string;
    parent?: string;
    agent?: string;
    ago?: number;
  } = {},
): Tab => ({
  name,
  label,
  creationTimestamp: now - min(o.ago ?? 30),
  model: o.model ?? 'gpt-5.6',
  modelLabel: o.modelLabel ?? 'GPT 5.6',
  description: o.description,
  parentStreamId: o.parent,
  identity: { kind: 'agent', agent: o.agent ?? label },
  agentCategory: 'toolUse',
});

const tabs: Tab[] = [
  agentTab('orchestrator', 'orchestrator', {
    model: 'gemini-3.8-flash',
    modelLabel: 'Gemini 3.8 Flash',
    ago: 12,
  }),
  agentTab('search-1', 'search@gpt56', {
    parent: 'orchestrator',
    agent: 'search',
    description: 'Sources for the Palomar claim',
    ago: 9,
  }),
  agentTab('review-1', 'review@gpt56', {
    parent: 'orchestrator',
    agent: 'review',
    description: 'Appendix B soundness review',
    ago: 4,
  }),
  agentTab('verify-cit', 'verify-citations', {
    parent: 'review-1',
    agent: 'verify',
    ago: 1,
  }),
  agentTab('lemma-b3', 'check-lemma-B3', {
    parent: 'review-1',
    agent: 'verify',
    ago: 2,
  }),
  agentTab('progress-1', 'progressCheck@gpt56', {
    parent: 'orchestrator',
    agent: 'progressCheck',
    ago: 3,
  }),
  agentTab('search-2', 'search@gpt56', {
    parent: 'orchestrator',
    agent: 'search',
    description: 'arXiv pass on LDT soundness',
    ago: 3,
  }),
  agentTab('s2', 'orchestrator', {
    description: 'Building Section 2 fact-check',
    ago: 3,
  }),
  agentTab('gemini37', 'orchestrator', {
    description: 'Launching Gemini 3.7 Flash run',
    ago: 25,
  }),
  agentTab('plan', 'orchestrator', {
    description: 'Planning next steps for LaTeX',
    ago: 120,
  }),
  agentTab('polish', 'polish', {
    description: 'Polishing manuscript argument',
    ago: 200,
  }),
  agentTab('lidt', 'review', {
    description: 'Polishing LIDT soundness',
    ago: 1500,
  }),
  agentTab('palomar', 'search', {
    description: 'Adding Palomar Registry',
    ago: 1600,
  }),
];
const running = new Set([
  'orchestrator',
  'review-1',
  'verify-cit',
  'search-2',
  's2',
]);
const waiting = new Set(['progress-1', 'gemini37']);
const states = new Map<string, StreamState>(
  tabs.map((t) => [
    t.name,
    createStreamState('toolUse', {
      status: running.has(t.name)
        ? 'running'
        : waiting.has(t.name)
          ? 'waiting'
          : 'ready',
      runStartedAt: running.has(t.name) ? t.creationTimestamp : undefined,
      lastTimestamp: now - min(1),
    }),
  ]),
);
const children = new Map<string, Tab[]>();
for (const t of tabs) {
  if (!t.parentStreamId) continue;
  const list = children.get(t.parentStreamId) ?? [];
  list.push(t);
  children.set(t.parentStreamId, list);
}
const pendingApproval = new Set(['progress-1', 'gemini37']);
const topLevel = tabs.filter((t) => !t.parentStreamId);
const byName = (n: string) => tabs.find((t) => t.name === n)!;

// ── small pieces ────────────────────────────────────────────────────────
const iconBtn = (name: Parameters<typeof waIcon>[0], label: string) =>
  html` <wa-button
    appearance="plain"
    size="s"
    class="icon-button"
    aria-label=${label}
    title=${label}
    >${waIcon(name)}</wa-button
  >`;

const toolRow = (icon: Parameters<typeof waIcon>[0], text: string) =>
  html` <div class="h-tool">
    ${waIcon('chevron-right')}${waIcon(icon)}<span>${text}</span>
  </div>`;

const transcript = () =>
  html` <div class="h-transcript">
    <div class="h-user">
      <div class="h-bubble">what should we do next</div>
      <span class="h-time">03:50:40 PM</span>
    </div>
    <div class="h-warn">
      ${waIcon('triangle-exclamation')}Skipping unreadable file in prompt
      context: main2.bbl (ENOENT)
    </div>
    ${toolRow('database', 'memory — Listed directory: /memories (1–2 of 2)')}
    ${toolRow('terminal', 'bash — git status && echo "--- LOG ---" && git log -n 5 --oneline')}
    ${toolRow('database', 'memory — Read /memories/ldt-paper-direction.md')}
    ${toolRow('magnifying-glass', 'glob — Found 18 files for "*" in .')}
  </div>`;

const stats = () =>
  html` <div class="h-stats">
    <span
      >${waIcon('window-maximize')} <span class="h-bar"><span></span></span> 19k
      / 1.0M</span
    ><span class="h-spacer"></span><span>↑53k · ↓12k · 184 · $0.032</span>
  </div>`;

const attention = topLevel.filter(
  (t) => running.has(t.name) || waiting.has(t.name),
);
const streamTabs = (active: string, compact = false, list: Tab[] = topLevel) =>
  html` <stream-tabs
    .streams=${list}
    .streamStates=${states}
    .childStreamsByParent=${children}
    .pendingApprovalStreamIds=${pendingApproval}
    .activeStreamId=${active}
    ?compact=${compact}
  ></stream-tabs>`;

const drawer = (title: string, active: string) =>
  html` <div class="h-scrim"></div>
    <div class="h-drawer">
      <div class="h-bar">
        <strong>${title}</strong
        ><span class="h-spacer"></span
        >${iconBtn('magnifying-glass', 'Search')}${iconBtn('plus', 'New task')}${iconBtn('xmark', 'Close')}
      </div>
      <div class="h-drawer-body">${streamTabs(active)}</div>
      <div class="h-drawer-foot">
        ${waIcon('picture-in-picture')} Open sessions in editor
      </div>
    </div>`;

const extFrame = (inner: TemplateResult) =>
  html` <div class="h-ext" id="frame">
    <div class="h-vscode-strip">
      <span>New Agent</span><span class="active">TeXRA</span
      ><span>Terminal</span>
    </div>
    ${inner}
  </div>`;

// ── scenes ──────────────────────────────────────────────────────────────
const sceneExtSession = (withDrawer: boolean) =>
  extFrame(html`
    <div class="h-bar">
      ${iconBtn('list-ul', 'Sessions')}<span class="h-title"
        ><strong>LDT-Lean-Paper</strong></span
      >
      <span class="h-spacer"></span>
      ${iconBtn('circle-stop', 'Stop')}${iconBtn('plus', 'New task')}${iconBtn('ellipsis', 'More')}
    </div>
    <stream-header
      .stream=${byName('review-1')}
      .state=${states.get('review-1')}
      .streamById=${new Map(tabs.map((t) => [t.name, t]))}
    ></stream-header>
    <div class="h-body">${transcript()}</div>
    ${stats()}
    <div class="h-routing">
      ${waIcon('code-branch')} Goes to review@gpt56 ·
      <a href="#">reply to orchestrator instead</a>
    </div>
    <follow-up-input visible streamId="review-1" .value=${''}></follow-up-input>
    ${withDrawer ? drawer('LDT-Lean-Paper', 'review-1') : nothing}
  `);

const sceneExtNew = () =>
  extFrame(html`
    <div class="h-bar">
      ${iconBtn('list-ul', 'Sessions')}<strong class="h-title">New task</strong
      ><span class="h-spacer"></span
      >${iconBtn('plus', 'New task')}${iconBtn('gear', 'Settings')}
    </div>
    <div class="h-hero-wrap">
      <div class="h-hero">
        <div class="h-mark">${waIcon('wand-magic-sparkles')}</div>
        <h1>What are you working on?</h1>
        <p>
          LDT-Lean-Paper. Describe the outcome you want: a polish, a review, a
          literature pass, a proof check.
        </p>
      </div>
      <wa-details class="h-context">
        <span slot="summary"
          >${waIcon('file-circle-plus')} Context and attachments
          <span class="h-quiet">main.tex, library.bib</span></span
        >
        <div class="h-quiet">Files selected for the run.</div>
      </wa-details>
    </div>
    <div class="h-active">
      <div class="h-label">Active now</div>
      ${streamTabs('', false, attention)}
    </div>
    <div class="h-composer">
      <wa-textarea
        resize="none"
        rows="3"
        placeholder="Describe the outcome you want…"
      ></wa-textarea>
      <div class="h-composer-row">
        <wa-select size="small" value="orchestrator"
          ><wa-option value="orchestrator">orchestrator</wa-option
          ><wa-option value="polish">polish</wa-option></wa-select
        >
        <wa-select size="small" value="gemini"
          ><wa-option value="gemini">Gemini 3.8 Flash</wa-option
          ><wa-option value="gpt">GPT 5.6</wa-option></wa-select
        >
        <wa-select size="small" value="interactive"
          ><wa-option value="interactive">Interactive</wa-option
          ><wa-option value="workflow">Workflow</wa-option></wa-select
        >
        <span class="h-spacer"></span>
        ${iconBtn('file-circle-plus', 'Attach')}${iconBtn('microphone', 'Dictate')}
        <wa-button size="s" variant="brand" class="h-send" aria-label="Send"
          >${waIcon('arrow-up')}</wa-button
        >
      </div>
    </div>
  `);

type CallStatus = 'waiting' | 'failed' | 'running' | 'done' | 'cached';
const callIcon = (s: CallStatus) =>
  s === 'done'
    ? waIcon('circle-check', { className: 'ok' })
    : s === 'cached'
      ? waIcon('check', { className: 'ok' })
      : s === 'failed'
        ? waIcon('circle-xmark', { className: 'err' })
        : s === 'waiting'
          ? waIcon('circle-dot', { className: 'warn' })
          : waIcon('circle', { className: 'run' });
const sceneRunBoard = () =>
  extFrame(html`${runBoardBar(iconBtn)}${runBoard()}`);

// W0: the proposal card in the orchestrator transcript (extension).
const planPhase = (title: string, calls: string, agents: string) =>
  html`<div class="h-plan-row">
    ${waIcon('diagram-project')}<strong>${title}</strong
    ><span class="h-last">${agents}</span><span class="h-meta">${calls}</span>
  </div>`;
const sceneExtProposal = () =>
  extFrame(html`
    <div class="h-bar">
      ${iconBtn('list-ul', 'Sessions')}<span class="h-title"
        ><strong>LDT-Lean-Paper</strong></span
      ><span class="h-spacer"></span
      >${iconBtn('circle-stop', 'Stop')}${iconBtn('plus', 'New task')}${iconBtn('ellipsis', 'More')}
    </div>
    <stream-header
      .stream=${byName('orchestrator')}
      .state=${states.get('orchestrator')}
      .streamById=${new Map(tabs.map((t) => [t.name, t]))}
    ></stream-header>
    <div class="h-body">
      <div class="h-transcript">
        <div class="h-user">
          <div class="h-bubble">
            run the simplification survey over src/agent and src/tools
          </div>
          <span class="h-time">03:50 PM</span>
        </div>
        ${toolRow('magnifying-glass', 'glob — 212 files in src/agent, src/tools')}
        <div class="h-prose h-prose-sm">
          Twelve disjoint lanes of about 3k lines each, reviewed then verified
          adversarially.
        </div>
        <div class="h-proposal">
          <div class="h-proposal-head">
            ${waIcon('diagram-project')}<strong
              >Proposes a multi-agent run</strong
            ><span class="h-spacer"></span
            ><span class="h-quiet">4 phases · 31 calls</span>
          </div>
          <div class="h-proposal-lede">
            simplification-survey · 12 lanes wide, 5 at a time · est. $2 to $4
          </div>
          ${planPhase('Scout', '12 calls', 'our-code-simplifier · Sonnet 5')}
          ${planPhase('Review', '12 calls', 'our-code-simplifier · Sonnet 5')}
          ${planPhase('Verify', 'up to 6', 'claude · Opus 5')}
          ${planPhase('Report', '1 call', 'claude · Opus 5')}
          <div class="h-proposal-actions">
            <wa-button size="s" variant="brand">Approve and run</wa-button
            ><wa-button size="s" appearance="outlined"
              >${waIcon('file-code', { slot: 'start' })} Open script</wa-button
            ><wa-button size="s" appearance="outlined">Reject</wa-button
            ><span class="h-spacer"></span
            ><wa-button size="s" appearance="plain"
              >Skip proposals this session</wa-button
            >
          </div>
        </div>
      </div>
    </div>
    ${stats()}
    <follow-up-input
      visible
      streamId="orchestrator"
      .value=${''}
    ></follow-up-input>
  `);

// E2: subagents inline at the point of dispatch (extension).
const subRow = (
  s: CallStatus,
  name: string,
  last: string,
  meta: string,
  depth = 0,
) =>
  html` <div class="h-call" style="padding-left:${12 + depth * 16}px">
    ${callIcon(s)}<strong>${name}</strong><span class="h-last">${last}</span
    ><span class="h-meta">${meta}</span>${waIcon('chevron-right')}
  </div>`;
const sceneExtInline = () =>
  extFrame(html`
    <div class="h-bar">
      ${iconBtn('list-ul', 'Sessions')}<span class="h-title"
        ><strong>LDT-Lean-Paper</strong></span
      ><span class="h-spacer"></span
      >${iconBtn('circle-stop', 'Stop')}${iconBtn('plus', 'New task')}${iconBtn('ellipsis', 'More')}
    </div>
    <stream-header
      .stream=${byName('orchestrator')}
      .state=${states.get('orchestrator')}
      .streamById=${new Map(tabs.map((t) => [t.name, t]))}
    ></stream-header>
    <div class="h-body">
      <div class="h-transcript">
        <div class="h-user">
          <div class="h-bubble">what should we do next</div>
          <span class="h-time">03:50:40 PM</span>
        </div>
        ${toolRow('database', 'memory — Read /memories/ldt-paper-direction.md')}
        <div class="h-prose h-prose-sm">
          Splitting this into a literature pass and a proof check while I plan
          the edit.
        </div>
        <wa-details open class="h-dispatch">
          <span slot="summary"
            >${waIcon('diagram-project')} Dispatched 4 subagents
            <wa-badge variant="neutral" appearance="outlined" pill>4</wa-badge>
            <wa-badge variant="success" pill>2</wa-badge>
            <wa-badge variant="warning" pill>1</wa-badge></span
          >
          ${subRow('done', 'search@gpt56', 'Found 12 sources for the Palomar claim', '9m')}
          ${subRow('running', 'review@gpt56', 'Reading appendix B', '4m')}
          ${subRow('running', 'verify-citations', 'bash — bibtex main', '1m', 1)}
          ${subRow('done', 'check-lemma-B3', 'Lemma holds under the stated bound', '2m', 1)}
          ${subRow('waiting', 'progressCheck@gpt56', 'Wants to run git push', 'approval')}
          ${subRow('running', 'search@gpt56', 'Searching arXiv for LDT soundness', '3m')}
        </wa-details>
        <div class="h-quiet">${waIcon('clock')} Waiting on 2 subagents…</div>
      </div>
    </div>
    ${stats()}
    <follow-up-input
      visible
      streamId="orchestrator"
      .value=${''}
    ></follow-up-input>
  `);

// Wide: the same progress bundle in the "TeXRA Progress" editor tab. Above
// ~720px the sessions drawer docks as a left column and the transcript keeps
// a reading width; below, it is the overlay drawer from the sidebar scenes.
const sceneExtWide = () =>
  html` <div class="h-ext h-ext-wide" id="frame">
    <div class="h-vscode-strip">
      <span>TeXRA Dashboard</span><span class="active">TeXRA Progress</span
      ><span class="h-spacer"></span
      >${waIcon('window-maximize')}${waIcon('ellipsis')}
    </div>
    <div class="h-wide">
      <div class="h-dock-list">
        <div class="h-bar">
          <strong>LDT-Lean-Paper</strong
          ><span class="h-spacer"></span
          >${iconBtn('magnifying-glass', 'Search')}${iconBtn('plus', 'New task')}
        </div>
        <div class="h-drawer-body">${streamTabs('review-1')}</div>
      </div>
      <div class="h-wide-main">
        <div class="h-bar">
          <span class="h-spacer"></span
          >${iconBtn('circle-stop', 'Stop')}${iconBtn('plus', 'New task')}${iconBtn('ellipsis', 'More')}
        </div>
        <div class="h-wide-col">
          <stream-header
            .stream=${byName('review-1')}
            .state=${states.get('review-1')}
            .streamById=${new Map(tabs.map((t) => [t.name, t]))}
          ></stream-header>
          <div class="h-body">
            ${transcript()}
            <div class="h-prose h-prose-sm">
              Appendix B, Lemma B.3: the bound holds only when the cooling rate
              is bounded below. The manuscript states it unconditionally. I am
              checking whether the original source carries the same assumption
              before proposing an edit.
            </div>
          </div>
          ${stats()}
          <div class="h-routing">
            ${waIcon('code-branch')} Goes to review@gpt56 ·
            <a href="#">reply to orchestrator instead</a>
          </div>
          <follow-up-input
            visible
            streamId="review-1"
            .value=${''}
          ></follow-up-input>
        </div>
      </div>
    </div>
  </div>`;

// LaTeXDiffs and the media tools: a "Tools" sheet opened from the header
// overflow. The real <latexdiffs-section> renders here on plain props.
const sceneExtTools = () =>
  extFrame(html`
    <div class="h-bar">
      ${iconBtn('list-ul', 'Sessions')}<span class="h-title"
        ><strong>LDT-Lean-Paper</strong></span
      ><span class="h-spacer"></span
      >${iconBtn('circle-stop', 'Stop')}${iconBtn('plus', 'New task')}<wa-button
        appearance="plain"
        size="s"
        class="icon-button h-active-btn"
        aria-label="More"
        >${waIcon('ellipsis')}</wa-button
      >
    </div>
    <stream-header
      .stream=${byName('orchestrator')}
      .state=${states.get('orchestrator')}
      .streamById=${new Map(tabs.map((t) => [t.name, t]))}
    ></stream-header>
    <div class="h-body" style="opacity:.45">${transcript()}</div>
    <div style="opacity:.45">${stats()}</div>
    <follow-up-input
      visible
      streamId="orchestrator"
      .value=${''}
      style="opacity:.45"
    ></follow-up-input>
    <div class="h-menu">
      <div class="h-menu-item">
        ${waIcon('picture-in-picture')} Open sessions in editor
      </div>
      <div class="h-menu-item">${waIcon('gear')} Open dashboard</div>
      <wa-divider></wa-divider>
      <div class="h-menu-item active">
        ${waIcon('code-compare')} LaTeXDiffs…
      </div>
      <div class="h-menu-item">${waIcon('image')} Figures…</div>
      <div class="h-menu-item">${waIcon('file-pdf')} Compile input PDF</div>
      <div class="h-menu-item">${waIcon('list-check')} Attach TeX Count</div>
      <wa-divider></wa-divider>
      <div class="h-menu-item h-quiet">
        ${waIcon('box-archive')} Pack output to History
      </div>
      <div class="h-menu-item h-quiet">
        ${waIcon('trash')} Delete output files
      </div>
    </div>
    <div class="h-sheet">
      <div class="h-bar">
        <strong>LaTeXDiffs</strong
        ><span class="h-spacer"></span>${iconBtn('xmark', 'Close')}
      </div>
      <latexdiffs-section
        .visible=${true}
        .baseFile=${'main.tex'}
        .baseFileOptions=${['main.tex', 'section2.tex', 'appendixB.tex']}
        .editedFile=${'main_polish.tex'}
        .editedFileOptions=${['main_polish.tex', 'main_review.tex']}
        .commit=${'HEAD'}
        .commitOptions=${['HEAD', 'HEAD~1', 'a1f3c2 Fix lemma B.3', '9be0d4 Section 2 rewrite']}
        .isGitRepo=${true}
      ></latexdiffs-section>
    </div>
  `);

// ── styles for the harness chrome (tokens only; components bring their own) ──
const style = html`<style>
  body {
    margin: 0;
    background: var(--wa-color-surface-lowered);
  }
  #app {
    padding: 24px;
    display: grid;
    place-items: start;
  }
  .h-quiet {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
  }
  .h-spacer {
    flex: 1 1 auto;
  }
  .ok {
    color: var(--wa-color-success-on-quiet, #1a7f37);
  }
  .err {
    color: var(--wa-color-danger-on-quiet, #a4381e);
  }
  .warn {
    color: var(--wa-color-warning-on-quiet, #bf8700);
  }
  .run {
    color: var(--wa-color-success-on-quiet, #1a7f37);
    font-size: 8px;
  }

  /* extension frame: VS Code Light Modern surface, system font */
  .h-ext {
    position: relative;
    width: 420px;
    height: 760px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-family:
      -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    border: 1px solid var(--wa-color-surface-border);
  }
  .h-vscode-strip {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 34px;
    padding: 0 12px;
    border-bottom: 1px solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-lowered);
    color: var(--wa-color-text-quiet);
  }
  .h-vscode-strip .active {
    padding: 3px 8px;
    border-radius: 5px;
    background: var(--wa-color-surface-border);
    color: var(--wa-color-text-normal);
  }
  .h-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 38px;
    padding: 0 8px;
    border-bottom: 1px solid var(--wa-color-surface-border);
    flex: 0 0 auto;
  }
  .h-title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
    padding-left: 4px;
  }
  .h-title span {
    color: var(--wa-color-text-quiet);
  }
  .h-title wa-icon {
    font-size: 10px;
    color: var(--wa-color-text-quiet);
  }
  .h-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .h-transcript {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  .h-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .h-bubble {
    max-width: 78%;
    padding: 8px 12px;
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
  }
  .h-time {
    font-size: 11px;
    color: var(--wa-color-text-quiet);
  }
  .h-warn {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 4px 6px;
    border-radius: 4px;
    background: var(--wa-color-danger-fill-quiet);
    color: var(--wa-color-danger-on-quiet);
    font-size: 12px;
    line-height: 1.4;
  }
  .h-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 10px;
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
    font-size: 12.5px;
  }
  .h-tool wa-icon {
    color: var(--wa-color-text-quiet);
    font-size: 12px;
  }
  .h-tool span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h-stats {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    font-size: 11.5px;
    color: var(--wa-color-text-quiet);
    flex: 0 0 auto;
  }
  .h-stats .h-bar {
    display: inline-block;
    width: 70px;
    height: 5px;
    border: 0;
    padding: 0;
    border-radius: 3px;
    background: var(--wa-color-surface-border);
    position: relative;
  }
  .h-stats .h-bar span {
    position: absolute;
    left: 0;
    top: 0;
    height: 5px;
    width: 2px;
    background: var(--wa-color-text-normal);
    border-radius: 3px;
  }
  .h-routing {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px 2px;
    font-size: 11.5px;
    color: var(--wa-color-text-quiet);
  }
  .h-routing wa-icon {
    font-size: 11px;
  }
  .h-routing a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }
  follow-up-input {
    display: block;
    padding: 0 8px 8px;
  }
  .h-scrim {
    position: absolute;
    inset: 34px 0 0 0;
    background: rgb(0 0 0 / 0.18);
  }
  .h-drawer {
    position: absolute;
    top: 34px;
    bottom: 0;
    left: 0;
    width: 320px;
    display: flex;
    flex-direction: column;
    background: var(--wa-color-surface-default);
    border-right: 1px solid var(--wa-color-surface-border);
    box-shadow: var(--wa-shadow-l, 8px 0 24px rgb(0 0 0 / 0.08));
  }
  .h-drawer-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 4px;
  }
  .h-drawer-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-hero-wrap {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 18px;
    padding: 0 12px;
  }
  .h-hero {
    display: grid;
    justify-items: center;
    gap: 8px;
    text-align: center;
    padding: 0 12px;
  }
  .h-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--wa-border-radius-l);
    border: 1px solid var(--wa-color-brand-border-quiet);
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-brand-on-quiet);
    font-size: 18px;
  }
  .h-hero h1 {
    margin: 4px 0 0;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1.25;
  }
  .h-hero p {
    margin: 0;
    max-width: 34ch;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--wa-color-text-quiet);
  }
  .h-context::part(base) {
    border-radius: var(--wa-border-radius-m);
  }
  .h-context [slot='summary'] {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .h-active {
    padding: 0 8px 4px;
  }
  .h-label {
    padding: 0 8px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }
  .h-composer {
    margin: 4px 12px 12px;
    padding: 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
    background: var(--wa-color-surface-default);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .h-composer wa-textarea::part(base) {
    border: 0;
    box-shadow: none;
  }
  .h-composer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .h-composer-row wa-select {
    width: 150px;
  }
  .h-composer-row wa-select:nth-of-type(3) {
    width: 124px;
  }
  .h-send::part(base) {
    border-radius: 50%;
    width: 28px;
    height: 28px;
    padding: 0;
  }
  .h-phases {
    padding: 6px 8px 0;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--wa-color-surface-border);
  }
  .h-phases wa-tab {
    font-size: 12px;
  }
  .h-phases wa-tab wa-icon {
    font-size: 10px;
    color: var(--wa-color-brand-on-quiet);
    margin-right: 4px;
  }
  .h-phases wa-tab.declared {
    color: var(--wa-color-text-quiet);
  }
  .h-phases wa-badge {
    margin-left: 6px;
    font-size: 10px;
  }
  .h-phases wa-tab-panel {
    display: none;
  }
  .h-calls {
    display: flex;
    flex-direction: column;
  }
  .h-group {
    display: flex;
    gap: 6px;
    padding: 8px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }
  .h-group span {
    font-weight: 500;
  }
  .h-group.warn {
    color: var(--wa-color-warning-on-quiet);
  }
  .h-group.err {
    color: var(--wa-color-danger-on-quiet);
  }
  .h-call {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 12px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12.5px;
  }
  .h-call > wa-icon {
    font-size: 12px;
    flex: 0 0 auto;
  }
  .h-call > wa-icon:last-child {
    color: var(--wa-color-text-quiet);
  }
  .h-call strong {
    font-weight: 500;
    white-space: nowrap;
  }
  .h-last {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--wa-color-text-quiet);
  }
  .h-meta {
    font-size: 11px;
    color: var(--wa-color-text-quiet);
    white-space: nowrap;
  }
  .h-call wa-button {
    font-size: 11.5px;
  }
  .h-fold {
    margin: 4px 8px;
  }
  .h-fold::part(base) {
    border-radius: var(--wa-border-radius-m);
  }
  .h-fold [slot='summary'] {
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 12px 12px;
    padding: 6px 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
  }

  /* desktop frame: the real shell classes from taskShell.css */
  .h-desktop {
    display: grid;
    grid-template-columns: 288px minmax(0, 1fr) 240px;
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    border: 1px solid var(--wa-color-surface-border);
  }
  .h-desktop .task-sidebar-brand {
    padding-left: 12px;
  }
  .h-rail-scroll {
    overflow: auto;
  }
  .h-nested {
    padding: 0 0 6px 10px;
  }
  .h-add-paper {
    margin-top: 8px;
    width: 100%;
  }
  .h-conv {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    height: 100%;
  }
  .h-conv-col {
    width: min(760px, 100%);
    margin: 0 auto;
    overflow: hidden;
    padding: 12px 0 0;
  }
  .h-conv-col .h-transcript {
    padding: 12px 0;
  }
  .h-conv-col .h-tool {
    font-size: 13px;
    min-height: 34px;
  }
  .h-prose {
    font-size: 14px;
    line-height: 1.55;
  }
  .h-dock {
    width: min(760px, 100%);
    margin: 0 auto;
    padding: 12px 0 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .h-chips {
    display: flex;
    gap: 6px;
  }
  .h-dock follow-up-input {
    padding: 0;
  }
  .h-paper-chip::part(base) {
    gap: 6px;
  }
  .h-context-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 56px 10px 12px;
    border-left: 1px solid var(--wa-color-surface-border);
  }
  .h-ctx-head {
    padding: 6px 8px;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }
  .h-ctx-head:not(:first-child) {
    margin-top: 10px;
  }
  .h-pdf {
    height: 100%;
    background: var(--wa-color-surface-lowered);
    padding: 16px;
    overflow: hidden;
  }
  .h-page {
    width: 100%;
    max-width: 400px;
    margin: 0 auto;
    aspect-ratio: 1 / 1.3;
    background: #fff;
    box-shadow: var(--wa-shadow-m, 0 2px 8px rgb(0 0 0 / 0.12));
    padding: 36px 32px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .h-pl {
    height: 7px;
    border-radius: 3px;
    background: #d8d8dc;
  }
  .h-pl.short {
    width: 62%;
  }
  .h-pl-title {
    height: 12px;
    width: 70%;
    background: #b9b9bf;
    margin: 0 auto 4px;
  }
  .h-pl-sub {
    width: 40%;
    margin: 0 auto 14px;
  }
  .h-pl-h {
    width: 34%;
    height: 9px;
    background: #b9b9bf;
    margin-top: 10px;
  }
  .h-pl-eq {
    width: 46%;
    margin: 6px auto;
    height: 10px;
  }
  .h-card {
    margin-top: 12px;
    padding: 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: 10px;
    background: var(--wa-color-surface-default);
    display: grid;
    gap: 2px;
  }
  .h-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 6px;
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--wa-color-text-quiet);
  }
  .h-card-note {
    padding: 6px 8px 0;
  }
  .h-switcher {
    margin-bottom: 6px;
    width: 100%;
  }
  .h-switcher::part(base) {
    justify-content: flex-start;
    min-height: 44px;
  }
  .h-switcher .task-project-copy {
    text-align: left;
    min-width: 0;
  }
  .h-switcher::part(label) {
    min-width: 0;
    overflow: hidden;
  }
  .h-ext-wide {
    width: 1100px;
  }
  .h-active-btn::part(base) {
    background: var(--wa-color-surface-lowered);
  }
  .h-menu {
    position: absolute;
    right: 8px;
    top: 74px;
    width: 250px;
    padding: 4px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    box-shadow: var(--wa-shadow-l, 0 8px 28px rgb(0 0 0 / 0.14));
    z-index: 3;
    display: grid;
    gap: 1px;
  }
  .h-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    font-size: 12.5px;
  }
  .h-menu-item.active {
    background: var(--wa-color-surface-lowered);
  }
  .h-menu-item wa-icon {
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-menu wa-divider {
    --spacing: 4px;
  }
  .h-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 62%;
    display: flex;
    flex-direction: column;
    background: var(--wa-color-surface-default);
    border-top: 1px solid var(--wa-color-surface-border);
    box-shadow: 0 -8px 28px rgb(0 0 0 / 0.1);
    z-index: 2;
  }
  .h-sheet .h-bar {
    padding-left: 12px;
  }
  .h-sheet latexdiffs-section {
    display: block;
    padding: 4px 8px 12px;
    overflow: auto;
  }
  .h-wide {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .h-dock-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-lowered);
  }
  .h-dock-list .h-bar {
    padding-left: 12px;
  }
  .h-dock-list .h-drawer-body {
    padding: 4px 6px;
  }
  .h-wide-main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .h-wide-col {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    width: min(760px, 100%);
    margin: 0 auto;
  }
  .h-wide-col .h-body {
    flex: 1 1 auto;
  }
  .h-wide-col follow-up-input {
    padding: 0 0 12px;
  }
  .h-wide-col .h-transcript {
    padding: 12px 0;
  }
  .h-wide-col .h-stats,
  .h-wide-col .h-routing {
    padding-left: 0;
    padding-right: 0;
  }
  .h-subtree {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .h-approval {
    margin: 0 4px;
    padding: 10px 12px;
    border: 1px solid var(--wa-color-warning-border-loud, #bf8700);
    border-radius: 10px;
    background: var(--wa-color-warning-fill-quiet, #fff8e6);
    font-size: var(--font-size-sm);
    display: grid;
    gap: 6px;
  }
  .h-approval-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .h-approval code {
    font-family: var(--wa-font-family-mono);
    font-size: 12px;
  }
  .h-approval-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .h-calls-card {
    border: 1px solid var(--wa-color-surface-border);
    border-radius: 10px;
    overflow: hidden;
    margin-top: 8px;
  }
  .h-calls-card .h-call {
    font-size: 13px;
  }
  .h-calls-card .h-group:first-child {
    padding-top: 10px;
  }
  .h-conv-col .h-phases {
    padding: 6px 0 0;
  }
  .h-run-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 4px 0;
    font-size: 13px;
  }
  .h-prose-sm {
    font-size: 13px;
    line-height: 1.5;
    padding: 2px 2px 0;
  }
  .h-proposal {
    border: 1px solid var(--wa-color-warning-border-loud, #bf8700);
    border-radius: var(--wa-border-radius-l);
    overflow: hidden;
    background: var(--wa-color-surface-default);
  }
  .h-proposal-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 10px;
    background: var(--wa-color-warning-fill-quiet, #fff8e6);
    font-size: 12.5px;
  }
  .h-proposal-head wa-icon {
    color: var(--wa-color-warning-on-quiet, #bf8700);
  }
  .h-proposal-lede {
    padding: 8px 10px 4px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .h-plan-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 10px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12.5px;
  }
  .h-plan-row wa-icon {
    font-size: 10px;
    color: var(--wa-color-text-quiet);
  }
  .h-plan-row strong {
    font-weight: 500;
  }
  .h-proposal-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--wa-color-surface-border);
  }
  .h-dispatch::part(base) {
    border-radius: var(--wa-border-radius-l);
  }
  .h-dispatch::part(content) {
    padding: 0;
  }
  .h-dispatch [slot='summary'] {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .h-dispatch wa-badge {
    font-size: 10px;
  }
</style>`;

const scenes: Record<string, () => TemplateResult> = {
  'ext-session': () => sceneExtSession(false),
  'ext-drawer': () => sceneExtSession(true),
  'ext-new': sceneExtNew,
  'run-board': sceneRunBoard,
  ...desktopScenes,
  'ext-proposal': sceneExtProposal,
  'ext-inline': sceneExtInline,
  'ext-wide': sceneExtWide,
  'ext-tools': sceneExtTools,
};
const scene =
  new URLSearchParams(location.search).get('scene') ?? 'ext-session';
render(
  html`${style}${(scenes[scene] ?? scenes['ext-session'])()}`,
  document.getElementById('app')!,
);
