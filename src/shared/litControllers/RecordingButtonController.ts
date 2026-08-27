import { postMessage } from '@shared/hostBridge';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

interface RecordingButtonConfig {
  startCommand: string;
  stopCommand: string;
  startTitle?: string;
  stopTitle?: string;
  startIcon?: TeXRAIconName;
  stopIcon?: TeXRAIconName;
  recordingClass?: string;
}

/**
 * Computed state for recording button (used in templates).
 */
interface RecordingButtonState {
  /** Current icon name */
  icon: TeXRAIconName;
  /** Current title/tooltip text */
  title: string;
  /** Whether currently recording */
  recording: boolean;
  /** CSS class for recording state (e.g., 'recording') */
  recordingClass: string;
}

/**
 * Lit reactive controller for managing a recording toggle button.
 *
 * Exposes computed state that the host component can use in templates:
 * ```typescript
 * // In host component
 * render() {
 *   const { icon, title, recording, recordingClass } = this.recordingController.state;
 *   return html`
 *     <vscode-toolbar-button
 *       icon=${icon}
 *       label=${title}
 *       title=${title}
 *       class=${classMap({ [recordingClass]: recording })}
 *       @click=${this.recordingController.handleClick}
 *     ></vscode-toolbar-button>
 *   `;
 * }
 * ```
 */
export class RecordingButtonController implements ReactiveController {
  private _recording = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly config: RecordingButtonConfig,
  ) {
    this.host.addController(this);
  }

  // Satisfies ReactiveController's structural requirement; state is driven via
  // setRecording(), not host lifecycle callbacks.
  hostConnected(): void {}

  /**
   * Get computed state for use in templates (Lit-native approach).
   * The host component should use these values in its template bindings.
   */
  get state(): RecordingButtonState {
    const recording = this._recording;
    const icon = recording
      ? (this.config.stopIcon ?? 'circle-stop')
      : (this.config.startIcon ?? 'microphone');
    const title = recording
      ? (this.config.stopTitle ?? 'Stop recording')
      : (this.config.startTitle ?? 'Record with microphone');
    return {
      icon,
      title,
      recording,
      recordingClass: this.config.recordingClass ?? 'recording',
    };
  }

  /**
   * Handle button click - toggles recording state and sends command.
   * Bind this to the button's @click handler in templates.
   */
  handleClick = (): void => {
    postMessage(
      this._recording ? this.config.stopCommand : this.config.startCommand,
    );
  };

  /**
   * Update recording state and trigger host re-render.
   */
  setRecording(recording: boolean): void {
    if (this._recording !== recording) {
      this._recording = recording;
      this.host.requestUpdate();
    }
  }
}
