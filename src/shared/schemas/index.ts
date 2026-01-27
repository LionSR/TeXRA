// =============================================================================
// Layer 1: Base types (no dependencies on other schema files)
// =============================================================================
export * from './identifiers';
export * from './agent';
export * from './errors';
export * from './usage';
export * from './proposalFields';
export * from './contextManagement';

// =============================================================================
// Layer 2: Depends on layer 1 only
// =============================================================================
export * from './stream'; // imports from agent, identifiers
export * from './output'; // imports from identifiers

// =============================================================================
// Layer 3: Depends on layer 2
// =============================================================================
export * from './log'; // imports TaskGroupStatus from stream
export * from './taskGroup'; // imports from stream, identifiers
export * from './todo'; // imports from identifiers
export * from './prompts'; // imports from agent, proposalFields, errors, identifiers
export * from './diffResult'; // imports from output

// =============================================================================
// Layer 4: MainView schemas
// =============================================================================
export * as mainViewMessages from './mainViewMessages';
export type {
  MainViewMessage,
  ModelOptionData,
  AgentOptionData,
} from './mainViewMessages';
export * from './mainViewState'; // imports from mainViewMessages
export * from './mainViewEvents'; // imports from mainViewState

// =============================================================================
// Layer 5: View message schemas
// =============================================================================
export * from './progressViewMessages';
export * from './progressViewData';
export * from './memoryViewMessages';
export * from './historyViewMessages';
export * from './profileViewMessages';

// =============================================================================
// Layer 6: Composite schemas (depend on multiple layers)
// =============================================================================
export * from './streamState';
