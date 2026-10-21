import {
  type ReadonlyRoundIndexed,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * The run-output accessors shared by the progress-view controllers
 * ({@link ProgressWorkflowFileActionsController} and
 * {@link ProgressFollowUpController}). Both wire against the same
 * `RunView` slice, so the port is declared once and each controller adds
 * its own extra accessor on top.
 */
export interface RunOutputsSource {
  getOutputFiles(runId: RunId): ReadonlyRoundIndexed<OutputFileInfo>;
}
