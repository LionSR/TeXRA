// Layer 0: Storage utilities (no dependencies)
export * from './storage';

// Layer 1: Base types (no dependencies on other schema files)
export * from './identifiers';
export * from './agent';
export * from './fileFields';
export * from './proposalFields';
export * from './toolConfig';
export * from './settingsConfiguration';
export * from './errors';
export * from './usage';
export * from './contextManagement';

// Layer 2: Depends on layer 1 only
export * from './stream';
export * from './output';

// Layer 3: Depends on layer 2
export * from './log';
export * from './taskGroup';
export * from './todo';
export * from './todoDisplay';
export * from './plan';
export * from './workPlan';
export * from './subagentProgress';
export * from './inquiry';
export * from './prompts';
export * from './diffResult';

// Layer 4: MainView schemas (consolidated)
export * from './mainView';
export * as mainViewMessages from './mainView';

// Layer 5: ProgressView schemas (consolidated)
export * from './progressView';

// Layer 6: Other view message schemas
export * as commonViewMessages from './commonViewMessages';
export { ThemeSchema, type Theme } from './commonViewMessages';
export * from './memoryViewMessages';
export * from './odysseyViewMessages';
export * from './historyViewMessages';
export * from './profileViewMessages';
export * from './settingsViewMessages';

// Layer 7: Composite schemas (depend on multiple layers)
export * from './streamState';
export * from './streamRestoration';
