// Minimal IDE pane: workspace file tree + Monaco editor.
//
// The desktop app is not VS Code, so users have no other way to see what is in
// the working directory or read a file an agent just rewrote. This is
// deliberately minimal — open, read, edit, save. No debugger, no extensions, no
// multi-root workspaces.
//
// Monaco arrives through the shared @ui/monaco/monacoLoader so the worker
// setup is identical to the diff viewer's (that config is a module global; two
// copies would race).
//
// File I/O goes over IPC to the main process, which owns the only trustworthy
// view of the filesystem: the renderer is sandboxed with no node integration.
// Each file's reads and writes take that file's lane in turn, and a newer
// request supersedes an older one by interrupting it, so no result needs
// checking for staleness after it arrives.

import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberSet,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import { html, nothing, render, type TemplateResult } from 'lit';

import { ensureError } from '@texra-ai/harness/schemas';
import type { Theme } from '@texra/shared/ipc';
import { loadMonaco, type MonacoModule } from '@ui/monaco/monacoLoader';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import { renderEmptyState } from '@ui/wa/emptyState';
import { renderLoadingState } from '@ui/wa/loadingState';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { applyMonacoTheme } from './monacoTheme';
import { monacoPresentationOptions } from './monacoOptions';
import { installMonacoCommandDescriptions } from './monacoCommandDescriptions';
import { monacoLanguageForPath } from '../shared/monacoLanguage';

import { createEditorFileNotice } from './editorFileNotice';
import {
  buildEditorDirectoryEntries,
  type EditorFileEntry,
  type EditorTreeDirectory,
  type EditorTreeNode,
} from './editorTree';

type CodeEditor = ReturnType<MonacoModule['editor']['create']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

/** Everything the pane tracks for one workspace path. */
interface FileState {
  // One model per opened file so switching tabs preserves each file's undo
  // history and cursor — recreating a model on every switch would lose both.
  model?: TextModel;
  viewState?: NonNullable<ReturnType<CodeEditor['saveViewState']>>;
  /** The file's reads and writes, one at a time in the order asked: a
   *  read never lands between a save's write and its bookkeeping, and each
   *  save sends the base the one before it wrote. */
  readonly lane: Semaphore.Semaphore;
  /** What this pane last read from or wrote to the file: a save lands only
   *  while the file still holds it. */
  disk?: string;
  syncing: boolean;
}

/** What the file tree shows, as one value: every change replaces it and
 *  the tree renders the new one. */
interface TreeState {
  /** The top-level listing. */
  readonly nodes: readonly EditorTreeNode[];
  readonly loading: boolean;
  readonly error: string | undefined;
  /** The file the editor shows. */
  readonly openPath: string | undefined;
  /** Files with edits not yet saved. */
  readonly dirty: ReadonlySet<string>;
  readonly expanded: ReadonlySet<string>;
  /** Each listed folder's entries. */
  readonly children: ReadonlyMap<string, readonly EditorTreeNode[]>;
  readonly listing: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
}

const FRESH_TREE: TreeState = {
  nodes: [],
  loading: true,
  error: undefined,
  openPath: undefined,
  dirty: new Set(),
  expanded: new Set(),
  children: new Map(),
  listing: new Set(),
  failed: new Set(),
};

/** `set` with `key` present or absent. */
function withMember<K>(
  set: ReadonlySet<K>,
  key: K,
  present: boolean,
): ReadonlySet<K> {
  if (set.has(key) === present) return set;
  const next = new Set(set);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

interface EditorPaneCallbacks {
  /** Lists the direct children of one workspace directory for the tree. */
  listFiles(
    directory: string,
  ): Effect.Effect<readonly EditorFileEntry[], Error>;
  readFile(path: string): Effect.Effect<string, Error>;
  /** Writes `contents` while the file still holds `base` (null: whatever
   *  it holds); `changedOnDisk` when something else rewrote it. */
  writeFile(
    path: string,
    contents: string,
    base: string | null,
  ): Effect.Effect<'saved' | 'changedOnDisk', Error>;
  isReadOnly?(path: string): boolean;
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

interface EditorPane {
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
  setTheme(theme: Theme): void;
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
  const disposeCommandTooltips = installMonacoCommandDescriptions(editorHost);
  const notice = createEditorFileNotice({
    onError: callbacks.onError,
    retrySave: (path) => void save(path),
  });
  element.append(notice.element, editorHost);

  let disposed = false;
  let monaco: MonacoModule | undefined;
  let editor: CodeEditor | undefined;
  let theme: Theme = 'dark';
  // Everything the pane runs lives in its scope: disposing the pane
  // interrupts whatever is still in flight.
  const scope = Scope.makeUnsafe();
  const { tree, opening, listing, directoryLoads } = Effect.runSync(
    Effect.gen(function* () {
      const tree = yield* SubscriptionRef.make(FRESH_TREE);
      // The tree renders every value it takes, for the pane's lifetime.
      yield* Effect.forkIn(
        Stream.runForEach(SubscriptionRef.changes(tree), (state) =>
          Effect.sync(() => render(treeTemplate(state), treeHost)),
        ),
        scope,
      );
      return {
        tree,
        /** The open that chooses which file is visible: a newer open
         *  interrupts it. */
        opening: yield* FiberHandle.make<void>(),
        /** The tree's top-level listing: a newer refresh interrupts it. */
        listing: yield* FiberHandle.make<void>(),
        /** The folders being listed; a refresh interrupts them all. */
        directoryLoads: yield* FiberSet.make<void>(),
      };
    }).pipe(Scope.provide(scope)),
  );
  /** Run `program` in the pane's scope; the promise resolves when it ends,
   *  however it ends (each program reports its own failures). */
  const run = (program: Effect.Effect<void>): Promise<void> =>
    disposed
      ? Promise.resolve()
      : Effect.runPromise(
          Effect.forkIn(program, scope).pipe(
            Effect.flatMap(Fiber.await),
            Effect.asVoid,
          ),
        );
  /** Run `program` as the fiber `handle` holds, and wait for it. */
  const runAs = (
    handle: FiberHandle.FiberHandle<void>,
    program: Effect.Effect<void>,
  ): Promise<void> =>
    Effect.runPromise(
      FiberHandle.run(handle, program).pipe(
        Effect.flatMap(Fiber.await),
        Effect.asVoid,
      ),
    );
  const files = new Map<string, FileState>();
  /** Change the tree's state from outside an Effect. */
  const setTree = (change: (state: TreeState) => TreeState): void =>
    Effect.runSync(SubscriptionRef.update(tree, change));
  /** Record whether `path` has unsaved edits, and tell the tab strip. */
  function setDirty(path: string, dirty: boolean): void {
    setTree((state) => ({
      ...state,
      dirty: withMember(state.dirty, path, dirty),
    }));
    callbacks.onDirtyChange(path, dirty);
  }
  const isDirty = (path: string): boolean =>
    SubscriptionRef.getUnsafe(tree).dirty.has(path);

  function fileState(path: string): FileState {
    let file = files.get(path);
    if (!file) {
      file = {
        lane: Semaphore.makeUnsafe(1),
        syncing: false,
      };
      files.set(path, file);
    }
    return file;
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

  function treeTemplate(state: TreeState): TemplateResult {
    if (state.error) {
      return html`
        <wa-callout class="desktop-editor-tree-empty" variant="danger">
          ${waIcon('triangle-exclamation', { slot: 'icon' })} ${state.error}
        </wa-callout>
      `;
    }
    if (state.loading) {
      return renderLoadingState('Loading project files…');
    }
    if (state.nodes.length === 0) {
      return renderEmptyState({
        icon: 'folder-open',
        title: 'No files found in this workspace.',
        // h2, not h3: the surrounding "Project" label (desktopShell.ts) is a
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
        ${state.nodes.map((node) => treeNodeTemplate(state, node))}
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
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('wa-tree-item');
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
    setTree((state) => ({
      ...state,
      expanded: withMember(state.expanded, directory.path, expanded),
    }));
    if (expanded) {
      void run(
        FiberSet.run(directoryLoads, loadDirectory(directory)).pipe(
          Effect.asVoid,
        ),
      );
    }
  }

  /** List one folder for the tree. A refresh interrupts it, and clears
   *  what it would have written. */
  function loadDirectory(directory: EditorTreeDirectory): Effect.Effect<void> {
    const { path } = directory;
    return Effect.suspend(() => {
      const state = SubscriptionRef.getUnsafe(tree);
      if (state.children.has(path) || state.listing.has(path)) {
        return Effect.void;
      }
      setTree((current) => ({
        ...current,
        listing: withMember(current.listing, path, true),
        failed: withMember(current.failed, path, false),
      }));
      return callbacks.listFiles(path).pipe(
        Effect.match({
          onSuccess: (entries) => (current: TreeState) => ({
            ...current,
            children: new Map(current.children).set(
              path,
              buildEditorDirectoryEntries(entries),
            ),
          }),
          onFailure: (error) => {
            callbacks.onError(error);
            return (current: TreeState) => ({
              ...current,
              failed: withMember(current.failed, path, true),
            });
          },
        }),
        Effect.flatMap((change) =>
          SubscriptionRef.update(tree, (current) => ({
            ...change(current),
            listing: withMember(current.listing, path, false),
          })),
        ),
      );
    });
  }

  function treeNodeTemplate(
    state: TreeState,
    node: EditorTreeNode,
  ): TemplateResult {
    if (node.kind === 'directory') {
      const expanded = state.expanded.has(node.path);
      const loaded = state.children.has(node.path);
      const children = state.children.get(node.path) ?? [];
      const loading = state.listing.has(node.path);
      const failed = state.failed.has(node.path);
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
          ${children.map((child) => treeNodeTemplate(state, child))}
        </wa-tree-item>
      `;
    }

    const isOpen = node.path === state.openPath;
    const dirty = state.dirty.has(node.path);
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
        ${dirty ? html`<span class="status-dot desktop-editor-dirty-dot"></span>` : nothing}
      </wa-tree-item>
    `;
  }

  /** Monaco and the pane's editor, made once; a load that failed is tried
   *  again by the next open. */
  const [editorOnce, forgetEditor] = Effect.runSync(
    Effect.cachedInvalidateWithTTL(
      Effect.tryPromise({ try: () => loadMonaco(), catch: ensureError }).pipe(
        Effect.map((loadedMonaco) => {
          monaco = loadedMonaco;
          editor = loadedMonaco.editor.create(editorHost, {
            ...monacoPresentationOptions(document.body),
            theme: applyMonacoTheme(loadedMonaco, theme, document.body),
            // Monaco measures its own container, and the pane is resized by
            // splits and divider drags, not only by the window.
            automaticLayout: true,
            // Papers and proofs have paragraph-length lines, so wrapping beats
            // a horizontal scrollbar — but wrap on word boundaries, not
            // anywhere.
            wordWrap: 'bounded',
            wordWrapColumn: 120,
            wrappingStrategy: 'simple',
            folding: true,
          });
          return { monaco: loadedMonaco, editor };
        }),
      ),
      Duration.infinity,
    ),
  );
  const ensureEditor = editorOnce.pipe(Effect.tapError(() => forgetEditor));

  /** Put `contents` in `model` without marking the file dirty. */
  function setClean(file: FileState, model: TextModel, contents: string): void {
    file.disk = contents;
    if (model.getValue() === contents) return;
    file.syncing = true;
    try {
      model.setValue(contents);
    } finally {
      file.syncing = false;
    }
  }

  /** The file's model, read from disk on its lane the first time, or
   *  brought up to date with disk while it has no edits. */
  function currentModel(
    path: string,
    file: FileState,
    loadedMonaco: MonacoModule,
  ): Effect.Effect<TextModel, Error> {
    return file.lane.withPermit(
      Effect.suspend(() => {
        const { model } = file;
        if (model) return Effect.as(syncClean(path, file, model), model);
        return Effect.map(callbacks.readFile(path), (contents) => {
          file.disk = contents;
          const created = loadedMonaco.editor.createModel(
            contents,
            monacoLanguageForPath(path),
          );
          // Track dirty per file. `onDidChangeContent` fires for programmatic
          // edits too, which is correct here: only reads and saves are
          // programmatic, and both reset the flag explicitly.
          created.onDidChangeContent(() => {
            if (file.syncing || isDirty(path)) return;
            setDirty(path, true);
          });
          file.model = created;
          return created;
        });
      }),
    );
  }

  /** Re-read a model that has no edits. Run on the file's lane. */
  function syncClean(
    path: string,
    file: FileState,
    model: TextModel,
  ): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      if (isDirty(path)) return Effect.void;
      const version = model.getVersionId();
      return Effect.map(callbacks.readFile(path), (contents) => {
        // Typing while the read was in flight is newer than it.
        if (isDirty(path) || model.getVersionId() !== version) return;
        // Only a read that is accepted retires an earlier notice, so a save
        // that failed before it keeps its warning.
        notice.clear(path);
        setClean(file, model, contents);
      });
    });
  }

  /** Discard this file's edits for what is on disk now (a save found it
   *  rewritten and the user chose the disk's version). */
  function reload(path: string): Promise<void> {
    const file = files.get(path);
    const model = file?.model;
    if (!file || !model) return Promise.resolve();
    const version = model.getVersionId();
    return run(
      file.lane
        .withPermit(
          Effect.map(callbacks.readFile(path), (contents) => {
            // Typing since the choice is newer than it: keep it, and the
            // file's base, so its save asks again.
            if (file.model !== model || model.getVersionId() !== version)
              return;
            setClean(file, model, contents);
            setDirty(path, false);
            notice.clear(path);
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => notice.report(path, 'reload', error)),
          ),
        ),
    );
  }

  function open(path: string): Promise<void> {
    if (disposed) return Promise.resolve();
    // Several tree clicks can race the first Monaco load and the reads: the
    // newest open interrupts the one before, so only it chooses which file
    // is visible.
    return runAs(
      opening,
      Effect.gen(function* () {
        const loaded = yield* ensureEditor.pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.sync(() => notice.report(undefined, 'load', error)),
              undefined,
            ),
          ),
        );
        if (!loaded) return;
        const target = loaded.editor;
        const file = fileState(path);
        const model = yield* currentModel(path, file, loaded.monaco);
        const { openPath } = SubscriptionRef.getUnsafe(tree);
        if (target.getModel() !== model) {
          if (openPath) {
            const state = target.saveViewState();
            if (state) fileState(openPath).viewState = state;
          }
          target.setModel(model);
          const state = file.viewState;
          if (state) target.restoreViewState(state);
        }
        yield* SubscriptionRef.update(tree, (state) => ({
          ...state,
          openPath: path,
        }));
        target.updateOptions({
          readOnly: callbacks.isReadOnly?.(path) ?? false,
          readOnlyMessage: {
            value:
              'This definition is read-only. Use **Customize** in Settings to edit a copy.',
          },
        });
        notice.clear(path);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => notice.report(path, 'open', error)),
        ),
      ),
    );
  }

  /** The tree's top-level listing, from scratch. Each run asks anew: a
   *  listing request is made when `listFiles` is called, and an interrupted
   *  one's late answer must not satisfy the next. */
  const listTree = SubscriptionRef.update(tree, (state) => ({
    ...state,
    loading: true,
  })).pipe(
    Effect.andThen(() => callbacks.listFiles('')),
    Effect.match({
      onSuccess: (listedFiles) => ({
        nodes: buildEditorDirectoryEntries(listedFiles),
        error: undefined,
      }),
      onFailure: (error) => {
        callbacks.onError(error);
        return { error: 'Could not list workspace files.' };
      },
    }),
    Effect.flatMap((listed) =>
      SubscriptionRef.update(tree, (state) => ({
        ...state,
        ...listed,
        loading: false,
      })),
    ),
  );

  /** Re-read the tree and every open file from disk. A refresh during
   *  another interrupts its listing and folder loads; each file's re-read
   *  queues on its lane, behind a first read still in flight. */
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    const relist = FiberSet.clear(directoryLoads).pipe(
      Effect.andThen(
        SubscriptionRef.update(tree, (state) => ({
          ...state,
          expanded: FRESH_TREE.expanded,
          children: FRESH_TREE.children,
          listing: FRESH_TREE.listing,
          failed: FRESH_TREE.failed,
        })),
      ),
      Effect.andThen(FiberHandle.run(listing, listTree)),
      Effect.flatMap(Fiber.await),
    );
    const fileRefreshes = [...files].map(([path, file]) =>
      file.lane
        .withPermit(
          Effect.suspend(() =>
            file.model ? syncClean(path, file, file.model) : Effect.void,
          ),
        )
        .pipe(
          // A failed re-read leaves the editor on the last version read, still
          // clean, so a later save would overwrite whatever the agent wrote
          // (or recreate a file it removed): say so.
          Effect.catch((error) =>
            Effect.sync(() => notice.report(path, 'reload', error)),
          ),
        ),
    );
    return run(
      Effect.all([relist, ...fileRefreshes], {
        concurrency: 'unbounded',
        discard: true,
      }),
    );
  }

  /** Save `path`'s buffer. `overwrite`: replace whatever the file holds now,
   *  the user's answer to a save that found it rewritten. A notice's action
   *  names its own file, never whichever one is open by then. */
  function save(path: string | undefined, overwrite = false): Promise<void> {
    const file = path ? files.get(path) : undefined;
    const model = file?.model;
    if (!path || !file || !model || callbacks.isReadOnly?.(path))
      return Promise.resolve();
    return run(
      file.lane
        .withPermit(
          Effect.suspend(() => {
            const savedVersion = model.getVersionId();
            const contents = model.getValue();
            return Effect.map(
              callbacks.writeFile(
                path,
                contents,
                overwrite ? null : (file.disk ?? null),
              ),
              (outcome) => {
                if (outcome === 'changedOnDisk') {
                  notice.changedOnDisk(path, {
                    overwrite: () => void save(path, true),
                    reload: () => void reload(path),
                  });
                  return;
                }
                file.disk = contents;
                // Typing during the write is not saved.
                if (
                  file.model !== model ||
                  model.getVersionId() !== savedVersion
                )
                  return;
                setDirty(path, false);
                notice.clear(path);
              },
            );
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => notice.report(path, 'save', error)),
          ),
        ),
    );
  }

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
      if (monaco) applyMonacoTheme(monaco, next, document.body);
    },

    layout() {
      // Monaco cannot measure a display:none container, so a tab that was
      // hidden when its content loaded renders at 0×0 until this runs.
      editor?.layout();
    },

    hasUnsavedChanges: () => SubscriptionRef.getUnsafe(tree).dirty.size > 0,
    // A plain save never overwrites: only the conflict notice's answer does.
    save: () => save(SubscriptionRef.getUnsafe(tree).openPath),

    dispose() {
      disposed = true;
      disposeCommandTooltips();
      Effect.runFork(Scope.close(scope, Exit.void));
      editor?.dispose();
      editor = undefined;
      for (const file of files.values()) {
        file.model?.dispose();
        file.model = undefined;
        file.viewState = undefined;
      }
    },
  };
}
