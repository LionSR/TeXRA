/**
 * Barrel export for all command modules.
 *
 * Commands are organized by domain:
 * - agent: Agent execution, creation, and management
 * - api: API key management
 * - auth: Authentication and profile management
 * - files: File selection and opening
 * - git: Git integration
 * - history: Execution history and state restoration
 * - housekeeping: Cleanup and maintenance
 * - latex: LaTeX operations (diff, figures, linting, etc.)
 * - memory: Memory view commands
 * - progress: Progress view management
 * - system: Help, settings, tests, and utilities
 * - tests: Connection tests
 * - wolfram: Wolfram Alpha integration
 */

// Agent commands
export * from './agent';

// API key management
export * from './api';

// Authentication
export * from './auth';

// File operations
export * from './files';

// Git integration
export * from './git';

// History and state restoration
export * from './history';

// Housekeeping and maintenance
export * from './housekeeping';

// LaTeX operations
export * from './latex';

// Memory view
export * from './memory';

// Progress view
export * from './progress';

// System utilities
export * from './system';

// Connection tests
export * from './tests';

// Wolfram integration
export * from './wolfram';
