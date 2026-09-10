/**
 * Host transcript reads from the canonical session event fold.
 * Channel traces publish through their owning session; transcript history is
 * read from the committed event prefix.
 */
export { RunLogStore } from './StreamLogStore';
export { createRunTrace, type RunTrace } from './runTrace';
export { RunSnapshotStore } from './StreamSnapshotStore';
export { assembleTrace, type AssembleTraceResult } from './traceAssembler';
export type { TraceDocument } from './traceDocumentSchema';
export {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
} from './completedRunArchive';
export { injectStandaloneTrace } from './standaloneTraceHtml';
