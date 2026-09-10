import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';
import type { RunMetadata } from '@transcript/RunSnapshotStore';

/**
 * The run-output accessors shared by the progress-view workflow controllers
 * ({@link ProgressWorkflowRunActionsController} and
 * {@link ProgressWorkflowFileActionsController}). Both wire against the same
 * session-state slice, so the port is declared once and each controller adds
 * its own extra accessor on top. Hosts hydrate the stream before dispatch.
 */
export interface RunOutputsSource {
  getRunMetadata(stream: RunId): RunMetadata;
  getOutputFiles(stream: RunId): ReadonlyRoundIndexed<OutputFileInfo>;
}
