// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared modules
import { themeContext } from '@shared/BaseWebviewApp';
import { commonViewStyles, designTokens } from '@shared/styles';
import { DESKTOP_THEME_KIND } from '@shared/schemas/commonViewMessages';

// Local imports - shared Web Awesome helpers
import { renderLoadingState } from '@shared/wa/loadingState';

// Local imports - errors
import { extractErrorMessage } from '@utils/errors/errorMessage';

type MonacoModule = typeof import('monaco-editor/editor/editor.api.js');
type MonacoWorkerModule = { default: new () => Worker };
type DiffEditor = ReturnType<MonacoModule['editor']['createDiffEditor']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;
type MonacoEnvironmentHost = typeof self & {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
};

interface MonacoWorkerConstructors {
  editor: new () => Worker;
  json: new () => Worker;
  css: new () => Worker;
  html: new () => Worker;
  ts: new () => Worker;
}

let monacoLoad: Promise<MonacoModule> | undefined;
let workersConfigured = false;

function setupMonacoWorkers(workers: MonacoWorkerConstructors): void {
  if (workersConfigured) return;
  (self as MonacoEnvironmentHost).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new workers.json();
        case 'css':
        case 'scss':
        case 'less':
          return new workers.css();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new workers.html();
        case 'typescript':
        case 'javascript':
          return new workers.ts();
        default:
          return new workers.editor();
      }
    },
  };
  workersConfigured = true;
}

async function loadMonaco(): Promise<MonacoModule> {
  monacoLoad ??= Promise.all([
    import('monaco-editor/editor/editor.api.js'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
  ])
    .then(
      ([monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker]) => {
        setupMonacoWorkers({
          editor: (editorWorker as MonacoWorkerModule).default,
          json: (jsonWorker as MonacoWorkerModule).default,
          css: (cssWorker as MonacoWorkerModule).default,
          html: (htmlWorker as MonacoWorkerModule).default,
          ts: (tsWorker as MonacoWorkerModule).default,
        });
        return monaco;
      },
    )
    .catch((error: unknown) => {
      monacoLoad = undefined;
      throw error;
    });
  return monacoLoad;
}

function monacoThemeForHostTheme(
  themeKind: string,
): 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' {
  if (themeKind === DESKTOP_THEME_KIND.LIGHT) return 'vs';
  if (themeKind === DESKTOP_THEME_KIND.HIGH_CONTRAST) return 'hc-black';
  return 'vs-dark';
}

@customElement('texra-diff-view')
export class TexraDiffView extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
        min-height: 240px;
      }

      .diff-view {
        display: flex;
        min-height: 240px;
        height: 42vh;
        max-height: 640px;
        border: var(--border-thin) solid var(--color-border);
        background: var(--wa-color-surface-default);
      }

      .editor {
        flex: 1;
        min-width: 0;
        min-height: 0;
      }

      .error {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 240px;
        padding: var(--wa-space-xs);
        border: var(--border-thin) solid var(--color-border);
        color: var(--color-error);
        background: var(--color-bg-secondary);
      }

      .loading-state {
        min-height: 240px;
        border: var(--border-thin) solid var(--color-border);
        background: var(--color-bg-secondary);
      }
    `,
  ];

  @property({ attribute: false }) originalText = '';
  @property({ attribute: false }) proposedText = '';
  @property() language = 'plaintext';

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  hostTheme: string = DESKTOP_THEME_KIND.DARK;
  @state() private loading = false;
  @state() private errorMessage = '';

  private editor?: DiffEditor;
  private monaco?: MonacoModule;
  private originalModel?: TextModel;
  private proposedModel?: TextModel;
  private resizeObserver?: ResizeObserver;
  private loadGeneration = 0;

  override disconnectedCallback(): void {
    this.loadGeneration += 1;
    this.resizeObserver?.disconnect();
    this.disposeMonacoObjects();
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    void this.ensureEditor();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (
      changed.has('originalText') ||
      changed.has('proposedText') ||
      changed.has('language')
    ) {
      // If a prior editor load failed (or never completed), retry it when new
      // diff content arrives instead of staying stuck on the error message for
      // the rest of the session — the element is reused across re-opens. The
      // `!this.loading` guard avoids a second concurrent load during the initial
      // firstUpdated()+updated() cycle (firstUpdated sets loading synchronously).
      if (!this.editor && !this.loading) {
        void this.ensureEditor();
      } else {
        this.syncModels();
      }
    }
    if (changed.has('hostTheme')) {
      this.applyTheme();
    }
  }

  override render(): TemplateResult {
    if (this.errorMessage) {
      return html`<div class="error">${this.errorMessage}</div>`;
    }
    return html`
      ${this.loading ? renderLoadingState('Loading diff...') : nothing}
      <div class="diff-view" ?hidden=${this.loading}>
        <div class="editor"></div>
      </div>
    `;
  }

  private async ensureEditor(): Promise<void> {
    if (this.editor) return;
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.errorMessage = '';

    try {
      const monaco = await loadMonaco();
      if (!this.isConnected || generation !== this.loadGeneration) return;
      const container = this.renderRoot.querySelector<HTMLElement>('.editor');
      if (!container) return;

      this.monaco = monaco;
      this.applyTheme();
      this.editor = monaco.editor.createDiffEditor(container, {
        automaticLayout: false,
        enableSplitViewResizing: true,
        originalEditable: false,
        readOnly: true,
        renderOverviewRuler: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
      });
      this.syncModels();
      this.observeResize(container);
    } catch (error) {
      this.errorMessage =
        extractErrorMessage(error) ?? 'Failed to load diff editor.';
    } finally {
      if (generation === this.loadGeneration) this.loading = false;
    }
  }

  private syncModels(): void {
    if (!this.monaco || !this.editor) return;
    this.originalModel?.dispose();
    this.proposedModel?.dispose();
    this.originalModel = this.monaco.editor.createModel(
      this.originalText,
      this.language,
    );
    this.proposedModel = this.monaco.editor.createModel(
      this.proposedText,
      this.language,
    );
    this.editor.setModel({
      original: this.originalModel,
      modified: this.proposedModel,
    });
  }

  private observeResize(container: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') {
      this.editor?.layout();
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.editor?.layout());
    this.resizeObserver.observe(container);
    this.editor?.layout();
  }

  private applyTheme(): void {
    this.monaco?.editor.setTheme(monacoThemeForHostTheme(this.hostTheme));
  }

  private disposeMonacoObjects(): void {
    this.editor?.dispose();
    this.editor = undefined;
    this.originalModel?.dispose();
    this.originalModel = undefined;
    this.proposedModel?.dispose();
    this.proposedModel = undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'texra-diff-view': TexraDiffView;
  }
}
