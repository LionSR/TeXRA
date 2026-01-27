/**
 * MemoryApp component - main container for the agent memory view.
 * Displays saved memories that help the assistant provide contextual help.
 */

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Local imports - shared schemas
import {
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  type MemoryViewItem,
} from '@shared/schemas';

// Local imports - memory view commands
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - memory view components (side-effect: register)
import './components/MemoryToolbar';
import './components/MemoryToggle';
import './components/MemoryList';

@customElement('memory-app')
export class MemoryApp extends BaseWebviewApp {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-view-container {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }

      .memory-description {
        margin: 0 0 var(--spacing-medium) 0;
      }
    `,
  ];

  @state() private items: MemoryViewItem[] = [];
  @state() private enabled = false;
  @state() private toggleDisabled = true;

  protected get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    postMessage(MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA);
    postMessage(MEMORY_VIEW_COMMANDS.GET_MEMORY_ENABLED);
  }

  protected override handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('command' in raw)) {
      return;
    }

    const command = (raw as { command: string }).command;
    if (command === MEMORY_VIEW_COMMANDS.UPDATE_MEMORY) {
      const result = UpdateMemoryMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[MemoryApp] Update memory message validation failed.',
          result.error,
        );
        return;
      }
      this.items = result.data.items ?? [];
      return;
    }

    if (command === MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED) {
      const result = UpdateMemoryEnabledMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[MemoryApp] Update memory enabled message validation failed.',
          result.error,
        );
        return;
      }
      this.enabled = result.data.enabled;
      this.toggleDisabled = false;
    }
  }

  private handleRefresh(): void {
    postMessage(MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA);
  }

  private handleOpenFolder(): void {
    postMessage(MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER);
  }

  private handleToggleEnabled(event: CustomEvent<{ enabled: boolean }>): void {
    postMessage(MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED, {
      enabled: event.detail.enabled,
    });
  }

  private handleOpenItem(event: CustomEvent<{ storagePath: string }>): void {
    postMessage(MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE, {
      storagePath: event.detail.storagePath,
    });
  }

  private handleDeleteItem(
    event: CustomEvent<{ storagePath: string; displayPath?: string }>,
  ): void {
    postMessage(MEMORY_VIEW_COMMANDS.DELETE_MEMORY, {
      storagePath: event.detail.storagePath,
      displayPath: event.detail.displayPath ?? event.detail.storagePath,
    });
  }

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container">
        <memory-toolbar
          @memory-refresh=${this.handleRefresh}
          @memory-open-folder=${this.handleOpenFolder}
        ></memory-toolbar>

        <memory-toggle
          .enabled=${this.enabled}
          .disabled=${this.toggleDisabled}
          @memory-toggle-enabled=${this.handleToggleEnabled}
        ></memory-toggle>

        <p class="text-secondary memory-description">
          The AI assistant can save notes here to remember important information
          across conversations. These notes help the assistant provide more
          contextual and personalized help.
        </p>

        <memory-list
          .items=${this.items}
          @memory-open-item=${this.handleOpenItem}
          @memory-delete-item=${this.handleDeleteItem}
        ></memory-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-app': MemoryApp;
  }
}
