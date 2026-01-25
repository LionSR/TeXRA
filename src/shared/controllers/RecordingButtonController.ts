// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Third-party imports
import type { ReactiveController, ReactiveControllerHost } from 'lit';

export interface RecordingButtonConfig {
  startCommand: string;
  stopCommand: string;
  startTitle?: string;
  stopTitle?: string;
  startIcon?: string;
  stopIcon?: string;
  recordingClass?: string;
}

/**
 * Lit reactive controller for managing a recording toggle button.
 */
export class RecordingButtonController implements ReactiveController {
  private button: HTMLElement | null = null;
  private isRecording = false;
  private handleClick = () => {
    const nextState = !this.isRecording;
    postMessage(nextState ? this.config.startCommand : this.config.stopCommand);
  };

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly config: RecordingButtonConfig,
  ) {
    this.host.addController(this);
  }

  hostDisconnected(): void {
    this.detach();
  }

  attach(button: HTMLElement | null): void {
    if (this.button === button) {
      return;
    }
    this.detach();
    this.button = button;
    if (!this.button) {
      return;
    }
    this.button.addEventListener('click', this.handleClick);
    this.updateButton();
  }

  setRecording(recording: boolean): void {
    this.isRecording = Boolean(recording);
    this.updateButton();
  }

  private detach(): void {
    if (this.button) {
      this.button.removeEventListener('click', this.handleClick);
    }
    this.button = null;
  }

  private updateButton(): void {
    if (!this.button) return;

    const iconName = this.isRecording
      ? (this.config.stopIcon ?? 'stop-circle')
      : (this.config.startIcon ?? 'mic');
    const title = this.isRecording
      ? (this.config.stopTitle ?? 'Stop recording')
      : (this.config.startTitle ?? 'Record with microphone');
    const tagName = this.button.tagName.toLowerCase();
    const isVsCodeButton =
      tagName === 'vscode-button' || tagName === 'vscode-toolbar-button';

    if (isVsCodeButton) {
      this.button.setAttribute('icon', iconName);
      if (tagName === 'vscode-button') {
        (this.button as HTMLButtonElement & { iconOnly?: boolean }).iconOnly =
          true;
      }
      if (tagName === 'vscode-toolbar-button') {
        this.button.setAttribute('label', title);
      }
      this.button.setAttribute('aria-label', title);
      (this.button as HTMLButtonElement).title = title;
    } else {
      this.button.innerHTML = '';
      const icon = document.createElement('i');
      icon.className = `codicon codicon-${iconName}`;
      this.button.appendChild(icon);
      (this.button as HTMLButtonElement).title = title;
    }

    const recordingClass = this.config.recordingClass ?? 'recording';
    this.button.classList.toggle(recordingClass, this.isRecording);
  }
}
