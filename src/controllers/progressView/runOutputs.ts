import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';

/**
 * The run-output accessors shared by the progress-view workflow controllers
 * ({@link ProgressWorkflowRunActionsController} and
 * {@link ProgressWorkflowFileActionsController}). Both wire against the same
 * `RunView` slice, so the port is declared once and each controller adds
 * its own extra accessor on top.
 */
export interface RunOutputsSource {
  getOutputFiles(runId: RunId): ReadonlyRoundIndexed<OutputFileInfo>;
}
