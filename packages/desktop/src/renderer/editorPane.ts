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
import { html, render, type TemplateResult } from 'lit';

import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  loadMonaco,
  monacoLanguageForPath,
  monacoThemeForHostTheme,
  type MonacoModule,
} from '@shared/monaco/monacoLoader';
import type { DesktopThemeKind } from '@shared/schemas/commonViewMessages';

import { getDesktopChromeFontSize } from './desktopTypography';

type CodeEditor = ReturnType<MonacoModule['editor']['create']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

export interface EditorFileEntry {
  /** Workspace-relative path, used as the tree label and the open key. */
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface EditorPaneCallbacks {
  /** Lists workspace files for the tree. */
  listFiles(): Promise<readonly EditorFileEntry[]>;
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
  let files: readonly EditorFileEntry[] = [];
  let openPath: string | undefined;
  let theme: DesktopThemeKind = 'dark';
  let treeError: string | undefined;
  let treeLoading = true;
  let refreshPromise: Promise<void> | undefined;
  // One model per opened file so switching tabs preserves each file's undo
  // history and cursor — recreating a model on every switch would lose both.
  const models = new Map<string, TextModel>();
  const dirtyPaths = new Set<string>();

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
    const path = row?.dataset.path;
    if (path && row?.dataset.kind === 'file') callbacks.onRequestOpen(path);
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
      return html`
        <div class="desktop-editor-tree-empty" role="status">
          <p>Loading project files…</p>
        </div>
      `;
    }
    if (files.length === 0) {
      return html`
        <div class="desktop-editor-tree-empty">
          <p>No files found in this workspace.</p>
        </div>
      `;
    }
    return html`
      <div class="desktop-editor-tree-header">
        <span>Files</span>
        ${renderIconActionButton({
          id: 'editor-tree-refresh',
          icon: 'refresh',
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
        ${files.map((entry) => fileRowTemplate(entry))}
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

  function fileRowTemplate(entry: EditorFileEntry): TemplateResult {
    const isOpen = entry.path === openPath;
    const isDirty = dirtyPaths.has(entry.path);
    return html`
      <wa-tree-item
        class="desktop-editor-tree-row"
        data-path=${entry.path}
        data-kind=${entry.isDirectory ? 'directory' : 'file'}
        .selected=${isOpen}
        title=${entry.path}
      >
        ${waIcon(entry.isDirectory ? 'folder' : 'file-lines', {
          className: 'desktop-editor-tree-icon',
        })}
        <span class="desktop-editor-tree-label">${entry.path}</span>
        ${isDirty ? html`<span class="desktop-editor-dirty-dot"></span>` : ''}
      </wa-tree-item>
    `;
  }

  async function ensureEditor(): Promise<CodeEditor | undefined> {
    if (editor) return editor;
    try {
      monaco = await loadMonaco();
    } catch (error) {
      callbacks.onError(error);
      render(
        html`<wa-callout class="desktop-editor-tree-empty" variant="danger">
          ${waIcon('triangle-exclamation', { slot: 'icon' })} The editor failed
          to load.
        </wa-callout>`,
        editorHost,
      );
      return undefined;
    }
    const editorFontSize = getDesktopChromeFontSize();
    editor = monaco.editor.create(editorHost, {
      theme: monacoThemeForHostTheme(theme),
      // Monaco measures its own container, and the pane is resized by splits and
      // divider drags, not only by the window.
      automaticLayout: true,
      // A minimap on a prose-shaped document is noise; the file tree already
      // names the file. Line numbers stay because errors are reported by line.
      minimap: { enabled: false },
      fontSize: editorFontSize,
      lineHeight: Math.round(editorFontSize * 1.5),
      // Papers and proofs have paragraph-length lines, so wrapping beats a
      // horizontal scrollbar — but wrap on word boundaries, not anywhere.
      // Monaco's default `wordWrapBreakAfterCharacters` splits inside a control
      // sequence, turning `\documentclass{article}` into two lines mid-token.
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
  }

  async function open(path: string): Promise<void> {
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
          if (dirtyPaths.has(path)) return;
          dirtyPaths.add(path);
          callbacks.onDirtyChange(path, true);
          renderTree();
        });
        models.set(path, model);
      }
      target.setModel(model);
      openPath = path;
      renderTree();
    } catch (error) {
      callbacks.onError(error);
    }
  }

  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    treeLoading = true;
    renderTree();
    refreshPromise = callbacks
      .listFiles()
      .then((listedFiles) => {
        files = listedFiles;
        treeError = undefined;
      })
      .catch((error: unknown) => {
        callbacks.onError(error);
        treeError = 'Could not list workspace files.';
      })
      .finally(() => {
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
    try {
      await callbacks.writeFile(path, model.getValue());
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

    save,

    dispose() {
      editor?.dispose();
      editor = undefined;
      for (const model of models.values()) model.dispose();
      models.clear();
    },
  };
}
