import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  StreamTabId,
} from '@shared/schemas';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';

/**
 * The run-output accessors shared by the progress-view workflow controllers
 * ({@link ProgressWorkflowRunActionsController} and
 * {@link ProgressWorkflowFileActionsController}). Both wire against the same
 * session-state slice, so the port is declared once and each controller adds
 * its own extra accessor on top. Hosts hydrate the stream before dispatch.
 */
export interface RunOutputsSource {
  getRunMetadata(stream: StreamTabId): RunMetadata;
  getOutputFiles(stream: StreamTabId): ReadonlyRoundIndexed<OutputFileInfo>;
}
