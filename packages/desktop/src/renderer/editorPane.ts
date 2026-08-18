// Minimal IDE pane: workspace file tree + Monaco editor.
//
// The desktop app is not VS Code, so users have no other way to see what is in
// the working directory or read a file an agent just rewrote. This is
// deliberately minimal — open, read, edit, save. No debugger, no extensions, no
// multi-root workspaces.
//
// Monaco arrives through the shared @shared/monaco/monacoLoader so the worker
// setup is identical to the diff viewer's (that config is a module global; two
// copies would race).
//
// File I/O goes over IPC to the main process, which owns the only trustworthy
// view of the filesystem: the renderer is sandboxed with no node integration.

import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { html, nothing, render, type TemplateResult } from 'lit';

import type { DesktopThemeKind } from '@shared/schemas';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderLoadingState } from '@shared/wa/loadingState';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { monacoLanguageForPath } from '@shared/monaco/monacoLanguage';
import {
  loadMonaco,
  monacoThemeForHostTheme,
  type MonacoModule,
} from '@shared/monaco/monacoLoader';

import { getDesktopChromeFontSize } from './desktopTypography';
import {
  buildEditorDirectoryEntries,
  type EditorFileEntry,
  type EditorTreeDirectory,
  type EditorTreeNode,
} from './editorTree';

type CodeEditor = ReturnType<MonacoModule['editor']['create']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

export interface EditorPaneCallbacks {
  /** Lists the direct children of one workspace directory for the tree. */
  listFiles(directory: string): Promise<readonly EditorFileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Reports dirty state so the tab strip can show its indicator. */
  onDirtyChange(path: string, dirty: boolean): void;
  /**
   * A tree row was activated. The pane does NOT load the file itself: the shell
   * owns tabs, so it creates (or focuses) the editor tab and calls back into
   * `open()`. Without this the tree loaded files into a pane that had no tab,
   * so nothing appeared.
   */
  onRequestOpen(path: string): void;
  onError(error: unknown): void;
}

export interface EditorPane {
  /** Editor surface, hosted by whichever pane holds the editor tab. */
  readonly element: HTMLElement;
  /**
   * File tree, hosted by the explorer sidebar rather than beside the editor: the
   * tree is workspace-wide context, not part of one document's view, so it should
   * stay put while editor tabs move between panes.
   */
  readonly treeElement: HTMLElement;
  /** Opens `path`, loading it if not already open. */
  open(path: string): Promise<void>;
  /** Refreshes the file tree from disk. */
  refresh(): Promise<void>;
  setTheme(theme: DesktopThemeKind): void;
  /** Re-lays-out Monaco after its container resizes or becomes visible. */
  layout(): void;
  hasUnsavedChanges(): boolean;
  save(): Promise<void>;
  dispose(): void;
}

export function createEditorPane(callbacks: EditorPaneCallbacks): EditorPane {
  const element = document.createElement('div');
  element.className = 'desktop-editor-pane';

  // The tree is a sibling of the editor in the DOM, not a child: the sidebar
  // mounts it independently of wherever the editor surface currently lives.
  const treeHost = document.createElement('div');
  treeHost.className = 'desktop-editor-tree';
  const editorHost = document.createElement('div');
  editorHost.className = 'desktop-editor-surface';
  element.append(editorHost);

  let monaco: MonacoModule | undefined;
  let editor: CodeEditor | undefined;
  let editorLoad: Promise<CodeEditor | undefined> | undefined;
  let latestOpenRequest = 0;
  let treeNodes: readonly EditorTreeNode[] = [];
  let openPath: string | undefined;
  let theme: DesktopThemeKind = 'dark';
  let treeError: string | undefined;
  let treeLoading = true;
  let refreshPromise: Promise<void> | undefined;
  let treeRevision = 0;
  const expandedDirectories = new Set<string>();
  const directoryChildren = new Map<string, readonly EditorTreeNode[]>();
  const loadingDirectories = new Set<string>();
  const directoryErrors = new Set<string>();
  // One model per opened file so switching tabs preserves each file's undo
  // history and cursor — recreating a model on every switch would lose both.
  const models = new Map<string, TextModel>();
  const dirtyPaths = new Set<string>();
  const syncingPaths = new Set<string>();

  function renderTree(): void {
    render(treeTemplate(), treeHost);
  }

  /**
   * Opens the file a tree row addresses. Directories carry no editor content,
   * so they are filtered here rather than marked `disabled` — a disabled
   * `wa-tree-item` drops out of the roving tabindex entirely, which would make
   * a directory an unreachable hole in keyboard navigation.
   */
  function requestOpenFromRow(row: HTMLElement | null | undefined): void {
    if (row?.dataset.kind !== 'file') return;
    const path = row.dataset.path;
    if (path) callbacks.onRequestOpen(path);
  }

  function treeTemplate(): TemplateResult {
    if (treeError) {
      return html`
        <wa-callout class="desktop-editor-tree-empty" variant="danger">
          ${waIcon('triangle-exclamation', { slot: 'icon' })} ${treeError}
        </wa-callout>
      `;
    }
    if (treeLoading) {
      return renderLoadingState('Loading project files…');
    }
    if (treeNodes.length === 0) {
      return renderEmptyState({
        icon: 'folder-open',
        title: 'No files found in this workspace.',
        // h2, not h3: the surrounding "Project" label (taskShell.ts) is a
        // plain div, not a heading, so there's no h1/h2 in this sidebar
        // subtree to nest under.
        headingTag: 'h2',
        className: 'desktop-editor-tree-empty desktop-editor-tree-empty-state',
      });
    }
    return html`
      <div class="desktop-editor-tree-header">
        <span>Files</span>
        ${renderIconActionButton({
          id: 'editor-tree-refresh',
          icon: 'rotate-right',
          label: 'Refresh file list',
          tooltip: 'Refresh file list',
          className: 'desktop-editor-tree-refresh',
          onClick: () => void refresh(),
        })}
      </div>
      <wa-tree
        class="desktop-editor-tree-list"
        selection="leaf"
        @wa-selection-change=${(
          event: CustomEvent<{ selection: HTMLElement[] }>,
        ) => requestOpenFromRow(event.detail.selection.at(-1))}
        @click=${handleTreeClick}
      >
        ${treeNodes.map((node) => treeNodeTemplate(node))}
      </wa-tree>
    `;
  }

  /**
   * Re-open the already-selected row. `wa-tree.selectItem` only dispatches
   * `wa-selection-change` when the selected set actually changes, so clicking
   * the row that is already selected emits nothing — and the row stays
   * selected after its editor tab is closed, which would leave that file
   * unopenable from the tree.
   */
  function handleTreeClick(event: MouseEvent): void {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      'wa-tree-item',
    );
    if (row?.hasAttribute('selected')) requestOpenFromRow(row);
  }

  function handleDirectoryToggle(
    event: Event,
    directory: EditorTreeDirectory,
    expanded: boolean,
  ): void {
    // Tree item events bubble through ancestor tree items. Only the directory
    // whose disclosure control changed should update its expansion state.
    if (event.target !== event.currentTarget) return;
    if (expanded) {
      expandedDirectories.add(directory.path);
      void loadDirectory(directory);
    } else {
      expandedDirectories.delete(directory.path);
    }
  }

  async function loadDirectory(directory: EditorTreeDirectory): Promise<void> {
    if (
      directoryChildren.has(directory.path) ||
      loadingDirectories.has(directory.path)
    ) {
      return;
    }

    const revision = treeRevision;
    loadingDirectories.add(directory.path);
    directoryErrors.delete(directory.path);
    renderTree();
    try {
      const entries = await callbacks.listFiles(directory.path);
      if (revision !== treeRevision) return;
      directoryChildren.set(
        directory.path,
        buildEditorDirectoryEntries(entries),
      );
    } catch (error) {
      if (revision !== treeRevision) return;
      callbacks.onError(error);
      directoryErrors.add(directory.path);
    } finally {
      if (revision === treeRevision) {
        loadingDirectories.delete(directory.path);
        renderTree();
      }
    }
  }

  function treeNodeTemplate(node: EditorTreeNode): TemplateResult {
    if (node.kind === 'directory') {
      const expanded = expandedDirectories.has(node.path);
      const loaded = directoryChildren.has(node.path);
      const children = directoryChildren.get(node.path) ?? [];
      const loading = loadingDirectories.has(node.path);
      const failed = directoryErrors.has(node.path);
      return html`
        <wa-tree-item
          class="desktop-editor-tree-row"
          data-path=${node.path}
          data-kind="directory"
          .expanded=${expanded}
          .lazy=${!loaded}
          title=${node.path}
          @wa-lazy-load=${(event: Event) =>
            handleDirectoryToggle(event, node, true)}
          @wa-expand=${(event: Event) =>
            handleDirectoryToggle(event, node, true)}
          @wa-collapse=${(event: Event) =>
            handleDirectoryToggle(event, node, false)}
        >
          <span class="desktop-editor-tree-icon">
            ${waIcon(expanded ? 'folder-open' : 'folder')}
          </span>
          <span class="desktop-editor-tree-label">${node.name}</span>
          ${
            loading
              ? html`<wa-tree-item class="desktop-editor-tree-status" disabled
                  >Loading…</wa-tree-item
                >`
              : nothing
          }
          ${
            failed
              ? html`<wa-tree-item
                  class="desktop-editor-tree-status is-error"
                  disabled
                  >Could not load folder</wa-tree-item
                >`
              : nothing
          }
          ${children.map((child) => treeNodeTemplate(child))}
        </wa-tree-item>
      `;
    }

    const isOpen = node.path === openPath;
    const isDirty = dirtyPaths.has(node.path);
    return html`
      <wa-tree-item
        class="desktop-editor-tree-row"
        data-path=${node.path}
        data-kind="file"
        .selected=${isOpen}
        title=${node.path}
      >
        <span class="desktop-editor-tree-icon">${waIcon('file-lines')}</span>
        <span class="desktop-editor-tree-label">${node.name}</span>
        ${isDirty ? html`<span class="desktop-editor-dirty-dot"></span>` : nothing}
      </wa-tree-item>
    `;
  }

  async function ensureEditor(): Promise<CodeEditor | undefined> {
    if (editor) return editor;
    if (editorLoad) return editorLoad;

    editorLoad = loadMonaco()
      .then((loadedMonaco) => {
        monaco = loadedMonaco;
        const editorFontSize = getDesktopChromeFontSize();
        editor = loadedMonaco.editor.create(editorHost, {
          theme: monacoThemeForHostTheme(theme),
          // Monaco measures its own container, and the pane is resized by splits
          // and divider drags, not only by the window.
          automaticLayout: true,
          // A minimap on a prose-shaped document is noise; the file tree already
          // names the file. Line numbers stay because errors are reported by line.
          minimap: { enabled: false },
          fontSize: editorFontSize,
          lineHeight: Math.round(editorFontSize * 1.5),
          // Papers and proofs have paragraph-length lines, so wrapping beats a
          // horizontal scrollbar — but wrap on word boundaries, not anywhere.
          wordWrap: 'bounded',
          wordWrapColumn: 120,
          wrappingStrategy: 'advanced',
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          padding: { top: 12, bottom: 12 },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
        });
        return editor;
      })
      .catch((error: unknown) => {
        callbacks.onError(error);
        render(
          html`<wa-callout class="desktop-editor-tree-empty" variant="danger">
            ${waIcon('triangle-exclamation', { slot: 'icon' })} The editor
            failed to load.
          </wa-callout>`,
          editorHost,
        );
        return undefined;
      })
      .finally(() => {
        editorLoad = undefined;
      });
    return editorLoad;
  }

  async function open(path: string): Promise<void> {
    const request = ++latestOpenRequest;
    const target = await ensureEditor();
    if (!target || !monaco) return;
    try {
      let model = models.get(path);
      if (!model) {
        const contents = await callbacks.readFile(path);
        model = monaco.editor.createModel(
          contents,
          monacoLanguageForPath(path),
        );
        // Track dirty per file. `onDidChangeContent` fires for programmatic
        // edits too, which is correct here: only reads and saves are
        // programmatic, and both reset the flag explicitly.
        model.onDidChangeContent(() => {
          if (syncingPaths.has(path)) return;
          if (dirtyPaths.has(path)) return;
          dirtyPaths.add(path);
          callbacks.onDirtyChange(path, true);
          renderTree();
        });
        models.set(path, model);
      } else if (!dirtyPaths.has(path)) {
        const contents = await callbacks.readFile(path);
        // The read crosses IPC. Recheck dirty state in case the user edited the
        // cached model while it was in flight; their local change always wins.
        if (!dirtyPaths.has(path) && model.getValue() !== contents) {
          syncingPaths.add(path);
          try {
            model.setValue(contents);
          } finally {
            syncingPaths.delete(path);
          }
        }
      }
      // Several tree clicks can race the first Monaco load and IPC reads.
      // Populate every requested model, but only the newest request may choose
      // which one is visible.
      if (request !== latestOpenRequest) return;
      target.setModel(model);
      openPath = path;
      renderTree();
    } catch (error) {
      callbacks.onError(error);
    }
  }

  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    treeRevision += 1;
    const revision = treeRevision;
    treeLoading = true;
    expandedDirectories.clear();
    directoryChildren.clear();
    loadingDirectories.clear();
    directoryErrors.clear();
    renderTree();
    refreshPromise = callbacks
      .listFiles('')
      .then((listedFiles) => {
        if (revision !== treeRevision) return;
        treeNodes = buildEditorDirectoryEntries(listedFiles);
        treeError = undefined;
      })
      .catch((error: unknown) => {
        if (revision !== treeRevision) return;
        callbacks.onError(error);
        treeError = 'Could not list workspace files.';
      })
      .finally(() => {
        if (revision !== treeRevision) return;
        treeLoading = false;
        refreshPromise = undefined;
        renderTree();
      });
    return refreshPromise;
  }

  async function save(): Promise<void> {
    const path = openPath;
    const model = path ? models.get(path) : undefined;
    if (!path || !model) return;
    const savedVersion = model.getVersionId();
    try {
      await callbacks.writeFile(path, model.getValue());
      if (model.getVersionId() !== savedVersion) return;
      dirtyPaths.delete(path);
      callbacks.onDirtyChange(path, false);
      renderTree();
    } catch (error) {
      callbacks.onError(error);
    }
  }

  renderTree();

  return {
    element,
    treeElement: treeHost,
    open,
    refresh,

    setTheme(next) {
      theme = next;
      // `monaco.editor.setTheme` is global, not per-instance; applying it here
      // also re-themes the diff viewer, which is the desired behavior since
      // both follow the one host theme.
      monaco?.editor.setTheme(monacoThemeForHostTheme(next));
    },

    layout() {
      // Monaco cannot measure a display:none container, so a tab that was
      // hidden when its content loaded renders at 0×0 until this runs.
      editor?.layout();
    },

    hasUnsavedChanges: () => dirtyPaths.size > 0,
    save,

    dispose() {
      editor?.dispose();
      editor = undefined;
      for (const model of models.values()) model.dispose();
      models.clear();
    },
  };
}
