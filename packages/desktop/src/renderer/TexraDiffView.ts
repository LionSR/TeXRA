// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// Local imports - shared modules
import { extractErrorMessage } from '@texra-ai/harness/schemas';
import {
  loadMonaco,
  type MonacoModule,
} from '@texra/shared/monaco/monacoLoader';
import { DESKTOP_THEME_KIND, type Theme } from '@texra/shared/ipc';
import { commonViewStyles, designTokens } from '@ui/styles';

// Local imports - shared Web Awesome helpers
import { renderLoadingState } from '@ui/wa/loadingState';
import { applyMonacoTheme } from '@ui/wa/monacoTheme';
import { monacoPresentationOptions } from '@ui/wa/monacoOptions';
import { installMonacoCommandDescriptions } from '@ui/wa/monacoCommandDescriptions';

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
  /** The Monaco load in flight, when one is: the one fact "loading" and
   *  "which load is current" both read, so neither can outlive the other. */
  @state() private editorLoad: Promise<void> | undefined;
  @state() private errorMessage = '';

  private editor?: DiffEditor;
  private monaco?: MonacoModule;
  private originalModel?: TextModel;
  private proposedModel?: TextModel;
  private resizeObserver?: ResizeObserver;
  private readonly editorContainer = document.createElement('div');
  private disposeCommandTooltips: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    // Monaco and its popups share the document stylesheet with the source
    // editor. The component's slot retains the diff frame and sizing.
    this.editorContainer.className = 'desktop-diff-editor';
    this.append(this.editorContainer);
    // A re-opened view (the pane drops the element when its last diff
    // closes) has no editor and gets no `firstUpdated`: load it again here.
    if (this.hasUpdated && !this.editor) this.ensureEditor();
  }

  override disconnectedCallback(): void {
    // Disconnecting abandons the load in flight: no longer current, its
    // completion changes nothing.
    this.editorLoad = undefined;
    this.resizeObserver?.disconnect();
    this.disposeMonacoObjects();
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    this.ensureEditor();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (
      changed.has('originalText') ||
      changed.has('proposedText') ||
      changed.has('language')
    ) {
      // If a prior editor load failed, retry it when new diff content
      // arrives instead of staying stuck on the error message for the rest
      // of the session — the element is reused across re-opens.
      if (this.editor) this.syncModels();
      else this.ensureEditor();
    }
    if (changed.has('hostTheme')) {
      this.applyTheme();
    }
  }

  override render(): TemplateResult {
    if (this.errorMessage) {
      return html`<div class="error">${this.errorMessage}</div>`;
    }
    const loading = this.editorLoad !== undefined;
    return html`
      ${loading ? renderLoadingState('Loading diff...') : nothing}
      <div class="diff-view" ?hidden=${loading}>
        <slot></slot>
      </div>
    `;
  }

  /** Start the editor's load unless one is in flight or it is built. */
  private ensureEditor(): void {
    if (this.editor || this.editorLoad) return;
    const load = this.loadEditor(() => this.editorLoad === load);
    this.editorLoad = load;
  }

  /** `current`: whether this load is still the element's; a disconnect in
   *  the meantime abandoned it, and a reconnect may have started another. */
  private async loadEditor(current: () => boolean): Promise<void> {
    this.errorMessage = '';
    try {
      const monaco = await loadMonaco();
      if (!current() || !this.isConnected) return;
      const container = this.editorContainer;
      this.disposeCommandTooltips = installMonacoCommandDescriptions(container);

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
      if (current())
        this.errorMessage =
          extractErrorMessage(error) ?? 'Failed to load diff editor.';
    } finally {
      if (current()) this.editorLoad = undefined;
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
    this.disposeCommandTooltips?.();
    this.disposeCommandTooltips = undefined;
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
