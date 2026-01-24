// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { provide } from '@lit/context';

// Local imports - progress view context
import {
  commandsContext,
  streamContext,
  type CommandsContextValue,
  type StreamContextValue,
} from './context';

// Local imports - progress view controllers
import { MessageController } from './controllers/MessageController';

// Local imports - progress view components
import './components';

// Local imports - webview API
import { postMessage } from './vscode';

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      height: 100vh;
    }

    .main-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 12px;
      padding: 12px;
      box-sizing: border-box;
    }

    .header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
    }

    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .stream-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .stream-tab {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .stream-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .stream-tab small {
      opacity: 0.7;
    }

    .status-pill {
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.ghost {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .content {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      flex: 1;
      min-height: 0;
    }

    .panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: auto;
    }

    .panel h3 {
      margin: 0;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--vscode-descriptionForeground);
    }

    .log-entry {
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .log-entry:last-child {
      border-bottom: none;
    }

    .log-entry__meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .file-entry {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .file-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .todo-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .todo-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .prompt-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 24px;
      z-index: 1000;
      overflow: auto;
    }

    .prompt-card {
      width: min(720px, 100%);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .prompt-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    textarea {
      width: 100%;
      min-height: 80px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      resize: vertical;
    }

    .empty-state {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  `;

  private readonly messageController: MessageController;

  @provide({ context: commandsContext })
  private commandsContextValue!: CommandsContextValue;

  @provide({ context: streamContext })
  private streamContextValue!: StreamContextValue;

  constructor() {
    super();
    this.messageController = new MessageController(
      this,
      this.handleStateChange,
    );

    this.commandsContextValue = { postCommand: this.postCommand };
    this.streamContextValue = this.buildStreamContext();
  }

  private get activeStream() {
    return this.messageController.getActiveStream();
  }

  private get activeStreamState() {
    return this.messageController.getActiveStreamState();
  }

  private handleStateChange = (): void => {
    this.streamContextValue = this.buildStreamContext();
    this.requestUpdate();
  };

  private buildStreamContext(): StreamContextValue {
    return {
      streams: this.messageController.streams,
      activeStreamId: this.messageController.activeStreamId,
      activeStatus: this.messageController.activeStatus,
      streamFilter: this.messageController.streamFilter,
      activeStream: this.activeStream,
      activeState: this.activeStreamState,
      toolEditBypass: this.messageController.toolEditBypass,
    };
  }

  private postCommand = (
    command: string,
    payload: Record<string, unknown> = {},
  ): void => {
    postMessage({ command, ...payload });
  };

  protected render(): TemplateResult {
    return html`
      <progress-split-layout>
        <progress-header slot="header"></progress-header>
        <prompt-container
          slot="prompt"
          .toolEditPrompts=${this.messageController.toolEditPrompts}
          .bashPrompts=${this.messageController.bashPrompts}
          .retryPrompts=${this.messageController.retryPrompts}
          .proposalPrompts=${this.messageController.proposalPrompts}
        ></prompt-container>
        <instruction-panel slot="instruction"></instruction-panel>
        <content-area slot="content"></content-area>
        <progress-footer slot="footer"></progress-footer>
      </progress-split-layout>
    `;
  }
}
