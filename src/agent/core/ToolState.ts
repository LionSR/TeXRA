// Deprecated compatibility re-export. Prefer importing from './AgentState'.
export {
  ToolResponseState as ToolState,
  createToolResponseState,
  toolResponseStateFromSnapshot,
  toolResponseStateToSnapshot,
  type ToolResponseSnapshot,
  type DocumentAssetSnapshot,
  type ResponseDraftSnapshot,
  type ReasoningTraceSnapshot,
} from './AgentState';
