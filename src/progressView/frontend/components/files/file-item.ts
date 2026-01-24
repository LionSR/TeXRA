// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import type { OutputFileInfo } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Renders a single output file entry.
 */
@customElement('file-item')
export class FileItem extends LitElement {
  @property({ type: Object })
  file!: OutputFileInfo;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  protected createRenderRoot() {
    return this;
  }

  private get displayPath(): string {
    const location = this.file.location;
    return location.kind === 'workspace' || location.kind === 'runStorage'
      ? location.relativePath || location.absolutePath
      : location.absolutePath;
  }

  private handleOpen(): void {
    const filePath = this.file.location.absolutePath;
    if (!filePath) return;
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.OPEN_FILE, {
      file: filePath,
    });
  }

  private handleCompareOriginal(): void {
    const filePath = this.file.location.absolutePath;
    const base = this.file.lineage?.original?.absolutePath;
    if (!filePath) return;
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL, {
      file: filePath,
      base,
    });
  }

  private handleComparePrevious(): void {
    const filePath = this.file.location.absolutePath;
    const base = this.file.lineage?.original?.absolutePath;
    const prev = this.file.lineage?.diffBase?.absolutePath;
    if (!filePath) return;
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS, {
      file: filePath,
      base,
      prev,
    });
  }

  render() {
    return html`
      <div class="file-entry">
        <strong>${this.displayPath}</strong>
        <div class="file-actions">
          <button class="secondary" @click=${this.handleOpen}>Open</button>
          <button class="ghost" @click=${this.handleCompareOriginal}>
            Compare Original
          </button>
          <button class="ghost" @click=${this.handleComparePrevious}>
            Compare Previous
          </button>
        </div>
      </div>
    `;
  }
}
