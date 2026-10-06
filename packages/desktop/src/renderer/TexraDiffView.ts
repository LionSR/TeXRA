// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// Local imports - shared modules
import { DESKTOP_THEME_KIND, type Theme } from '@shared/schemas';
import { loadMonaco, type MonacoModule } from '@shared/monaco/monacoLoader';
import { commonViewStyles, designTokens } from '@ui/styles';

// Local imports - shared Web Awesome helpers
import { renderLoadingState } from '@ui/wa/loadingState';
import { applyMonacoTheme } from '@ui/wa/monacoTheme';
import { monacoPresentationOptions } from '@ui/wa/monacoOptions';

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

      ::slotted(.desktop-diff-editor) {
        flex: 1;
        width: 100%;
        height: 100%;
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

  @property({ attribute: false })
  hostTheme: Theme = DESKTOP_THEME_KIND.DARK;
  @state() private loading = false;
  @state() private errorMessage = '';

  private editor?: DiffEditor;
  private monaco?: MonacoModule;
  private originalModel?: TextModel;
  private proposedModel?: TextModel;
  private resizeObserver?: ResizeObserver;
  private loadGeneration = 0;
  private readonly editorContainer = document.createElement('div');

  override connectedCallback(): void {
    super.connectedCallback();
    // Monaco and its popups share the document stylesheet with the source
    // editor. The component's slot retains the diff frame and sizing.
    this.editorContainer.className = 'desktop-diff-editor';
    this.append(this.editorContainer);
  }

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
        <slot></slot>
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
      const container = this.editorContainer;

      this.monaco = monaco;
      this.applyTheme();
      this.editor = monaco.editor.createDiffEditor(container, {
        ...monacoPresentationOptions(this),
        automaticLayout: false,
        enableSplitViewResizing: true,
        originalEditable: false,
        readOnly: true,
        renderOverviewRuler: true,
        renderSideBySide: true,
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
    const layout = () => {
      const { clientWidth: width, clientHeight: height } = container;
      if (width > 0 && height > 0) this.editor?.layout({ width, height });
    };
    if (typeof ResizeObserver === 'undefined') {
      layout();
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(layout);
    this.resizeObserver.observe(container);
    layout();
  }

  private applyTheme(): void {
    if (this.monaco) applyMonacoTheme(this.monaco, this.hostTheme, this);
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
