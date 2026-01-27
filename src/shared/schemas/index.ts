// Layer 1: Base types (no dependencies on other schema files)
export * from './identifiers';
export * from './agent';
export * from './errors';
export * from './usage';
export * from './proposalFields';
export * from './contextManagement';

// Layer 2: Depends on layer 1 only
export * from './stream';
export * from './output';

// Layer 3: Depends on layer 2
export * from './log';
export * from './taskGroup';
export * from './todo';
export * from './prompts';
export * from './diffResult';

// Layer 4: MainView schemas
export * as mainViewMessages from './mainViewMessages';
export type {
  MainViewMessage,
  ModelOptionData,
  AgentOptionData,
} from './mainViewMessages';
export * from './mainViewState';
export * from './mainViewEvents';

// Layer 5: View message schemas
export * as commonViewMessages from './commonViewMessages';
export { ThemeSchema, type Theme } from './commonViewMessages';
export * from './progressViewMessages';
export * from './progressViewInboundMessages';
export * from './progressViewData';
export * from './mainViewInboundMessages';
export * from './memoryViewMessages';
export * from './historyViewMessages';
export * from './profileViewMessages';

// Layer 6: Composite schemas (depend on multiple layers)
export * from './streamState';
