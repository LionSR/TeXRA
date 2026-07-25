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

import { html, render, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  loadMonaco,
  monacoLanguageForPath,
  monacoThemeForHostTheme,
  type MonacoModule,
} from '@shared/monaco/monacoLoader';
import type { DesktopThemeKind } from '@shared/schemas/commonViewMessages';

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
  onError(error: unknown): void;
}

export interface EditorPane {
  readonly element: HTMLElement;
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

  const treeHost = document.createElement('div');
  treeHost.className = 'desktop-editor-tree';
  const editorHost = document.createElement('div');
  editorHost.className = 'desktop-editor-surface';
  element.append(treeHost, editorHost);

  let monaco: MonacoModule | undefined;
  let editor: CodeEditor | undefined;
  let files: readonly EditorFileEntry[] = [];
  let openPath: string | undefined;
  let theme: DesktopThemeKind = 'dark';
  let treeError: string | undefined;
  // One model per opened file so switching tabs preserves each file's undo
  // history and cursor — recreating a model on every switch would lose both.
  const models = new Map<string, TextModel>();
  const dirtyPaths = new Set<string>();

  function renderTree(): void {
    render(treeTemplate(), treeHost);
  }

  function treeTemplate(): TemplateResult {
    if (treeError) {
      return html`
        <div class="desktop-editor-tree-empty" role="alert">
          <p>${treeError}</p>
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
        <button
          type="button"
          class="desktop-editor-tree-refresh"
          aria-label="Refresh file list"
          title="Refresh file list"
          @click=${() => void refresh()}
        >
          ${waIcon('refresh')}
        </button>
      </div>
      <ul class="desktop-editor-tree-list" role="tree">
        ${files.map((entry) => fileRowTemplate(entry))}
      </ul>
    `;
  }

  function fileRowTemplate(entry: EditorFileEntry): TemplateResult {
    const isOpen = entry.path === openPath;
    const isDirty = dirtyPaths.has(entry.path);
    return html`
      <li role="treeitem" aria-selected=${isOpen ? 'true' : 'false'}>
        <button
          type="button"
          class="desktop-editor-tree-row"
          data-open=${isOpen ? 'true' : 'false'}
          title=${entry.path}
          @click=${() => void open(entry.path)}
        >
          ${waIcon(entry.isDirectory ? 'folder' : 'file-lines', {
            className: 'desktop-editor-tree-icon',
          })}
          <span class="desktop-editor-tree-label">${entry.path}</span>
          ${isDirty ? html`<span class="desktop-editor-dirty-dot"></span>` : ''}
        </button>
      </li>
    `;
  }

  async function ensureEditor(): Promise<CodeEditor | undefined> {
    if (editor) return editor;
    try {
      monaco = await loadMonaco();
    } catch (error) {
      callbacks.onError(error);
      render(
        html`<div class="desktop-editor-tree-empty" role="alert">
          <p>The editor failed to load.</p>
        </div>`,
        editorHost,
      );
      return undefined;
    }
    editor = monaco.editor.create(editorHost, {
      theme: monacoThemeForHostTheme(theme),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      // Papers and proofs are prose-shaped; soft wrap avoids horizontal
      // scrolling through a paragraph-length line.
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
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

  async function refresh(): Promise<void> {
    try {
      files = await callbacks.listFiles();
      treeError = undefined;
    } catch (error) {
      callbacks.onError(error);
      treeError = 'Could not list workspace files.';
    }
    renderTree();
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
