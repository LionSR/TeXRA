// Subagent progress/result/error blocks (produced by src/tools/subagentResults.ts)
// are FollowUpQueue messages addressed to the orchestrator *model*, injected
// into the conversation as user turns. Rendering the raw XML in the human
// transcript is noise — the orchestrator's own prose already narrates the
// outcome — so collapse each block to a terse status line. Text that is not a
// subagent block passes through unchanged.
//
// The parsing/formatting/decoding lives in the host-neutral @shared module so
// the CLI transcript and the extension ProgressView bubble share one source of
// truth. Re-exported here to keep the TUI's import path stable.

export {
  decodeXmlEntities,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
