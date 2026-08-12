// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared modules
import { themeContext } from '@shared/BaseWebviewApp';
import { commonViewStyles, designTokens } from '@shared/styles';
import {
  DESKTOP_THEME_KIND,
  type Theme,
} from '@shared/schemas/commonViewMessages';
import {
  loadMonaco,
  monacoThemeForHostTheme,
  type MonacoModule,
} from '@shared/monaco/monacoLoader';

// Local imports - shared Web Awesome helpers
import { renderLoadingState } from '@shared/wa/loadingState';

// Local imports - errors
import { extractErrorMessage } from '@utils/errors/errorMessage';

type DiffEditor = ReturnType<MonacoModule['editor']['createDiffEditor']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

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

      :host([fill]) {
        height: 100%;
        min-height: 0;
      }

      .diff-view {
        display: flex;
        min-height: 240px;
        height: 42vh;
        max-height: 640px;
        border: var(--border-thin) solid var(--color-border);
        background: var(--wa-color-surface-default);
      }

      :host([fill]) .diff-view {
        height: 100%;
        min-height: 0;
        max-height: none;
        border: 0;
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
  @property({ type: Boolean, reflect: true }) fill = false;

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  // Kept `string` because themeContext carries a plain string; the value is
  // always one of DESKTOP_THEME_KIND at runtime, asserted at the Monaco
  // boundary below.
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
    // themeContext is typed `string` but only ever carries DESKTOP_THEME_KIND
    // values, so the boundary cast is the invariant we trust here.
    this.monaco?.editor.setTheme(
      monacoThemeForHostTheme(this.hostTheme as Theme),
    );
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
