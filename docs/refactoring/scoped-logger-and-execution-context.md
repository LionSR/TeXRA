# Scoped Logger and Execution Context

This document describes the new `ScopedAgentLogger` and `ExecutionContext` abstractions introduced to simplify logging and context management in TeXRA.

## Problem Statement

Previously, managing log groups and execution context required:

1. **Manual group ID threading**: Passing `groupId` through 10+ method layers
2. **Repeated `getActiveGroupId()` calls**: Fetching the active group before every log operation
3. **Scattered execution state**: Multiple separate parameters (executionId, streamTabId, logger, modelHandler, etc.)
4. **Error-prone code**: Easy to forget `groupId` parameter, causing logs to appear outside groups

Example of the old pattern:

```typescript
// Old pattern - verbose and error-prone
public async processData(logger: AgentLogger): Promise<void> {
  const groupId = await logger.startGroup('Processing');

  try {
    const activeGroupId = logger.getActiveGroupId(); // Must fetch explicitly
    logger.info('Starting', activeGroupId);

    await this.subTask(logger, activeGroupId); // Must pass through

    logger.info('Done', activeGroupId);
    logger.endGroup(groupId);
  } catch (error) {
    logger.endGroup(groupId, 'error');
    throw error;
  }
}

private async subTask(logger: AgentLogger, groupId: string): Promise<void> {
  logger.debug('SubTask running', groupId); // Easy to forget groupId
}
```

## Solution: ScopedAgentLogger

The `ScopedAgentLogger` extends `AgentLogger` with automatic scope management:

- **Automatic scope tracking**: Maintains internal scope stack
- **Nested groups**: Automatically manages parent-child relationships
- **Cleaner syntax**: No need to pass `groupId` to every log call
- **Error handling**: Automatically ends groups with correct status

### Basic Usage

```typescript
import { ScopedAgentLogger } from '@logger/ScopedAgentLogger';

const logger = new ScopedAgentLogger(channelId);

// Simple group with automatic scope
await logger.withGroup('Processing', async () => {
  logger.info('Starting'); // Automatically uses 'Processing' group
  logger.debug('Details'); // Also in 'Processing' group
});
```

### Nested Groups

```typescript
await logger.withGroup('Outer', async () => {
  logger.info('Outer message');

  await logger.withGroup('Inner', async () => {
    logger.info('Inner message'); // Uses 'Inner' group
  });

  logger.info('Back to outer'); // Back to 'Outer' group
});
```

### Error Handling

Groups are automatically ended with error status when exceptions occur:

```typescript
await logger.withGroup('RiskyOperation', async () => {
  logger.info('Starting');
  throw new Error('Something went wrong');
  // Group automatically ended with 'error' status
});
```

### Conditional Group Creation

```typescript
await logger.withGroupConditional(
  'OptionalGroup',
  async (groupId) => {
    // groupId is undefined if skip=true
    logger.info('Processing');
  },
  { skip: shouldSkip },
);
```

### Explicit Group Override

You can still provide explicit `groupId` when needed:

```typescript
await logger.withGroup('MainGroup', async () => {
  logger.info('Auto scoped'); // Uses 'MainGroup'
  logger.info('Explicitly scoped', 'other-group-id'); // Uses specified group
});
```

### Migration Example

```typescript
// Before
public async processFiles(logger: AgentLogger): Promise<void> {
  const groupId = await logger.startGroup('File Processing');
  try {
    const activeGroupId = logger.getActiveGroupId();
    logger.info('Loading files', activeGroupId);

    for (const file of files) {
      await this.processFile(file, logger, activeGroupId);
    }

    logger.info('Done', activeGroupId);
    logger.endGroup(groupId);
  } catch (error) {
    logger.endGroup(groupId, 'error');
    throw error;
  }
}

// After
public async processFiles(logger: ScopedAgentLogger): Promise<void> {
  await logger.withGroup('File Processing', async () => {
    logger.info('Loading files');

    for (const file of files) {
      await this.processFile(file, logger);
    }

    logger.info('Done');
  });
}
```

## Solution: ExecutionContext

The `ExecutionContext` provides a unified container for execution-scoped dependencies:

```typescript
export interface ExecutionContext<C = unknown> {
  // Identifiers
  readonly executionId: ExecutionId;
  readonly streamTabId: StreamTabId;

  // Core dependencies
  readonly logger: ScopedAgentLogger;
  readonly modelHandler: IModelHandler<any, any, any, any, C>;
  readonly agentConfig: AgentConfig;
  readonly agentSetting: AgentSetting;

  // Utility methods
  withGroup<T>(name: string, callback: () => Promise<T>): Promise<T>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  getCurrentGroupId(): string | undefined;
}
```

### Creating an ExecutionContext

```typescript
import { ExecutionContextFactory } from '@agent/core/ExecutionContext';
import { ScopedAgentLogger } from '@logger/ScopedAgentLogger';

const logger = new ScopedAgentLogger(streamTabId);

const context = ExecutionContextFactory.create({
  executionId,
  streamTabId,
  logger,
  modelHandler,
  agentConfig,
  agentSetting,
});
```

### Using ExecutionContext

```typescript
async function processData(context: ExecutionContext): Promise<void> {
  await context.withGroup('Processing', async () => {
    context.log('info', 'Starting processing');

    // Access dependencies
    const config = context.agentConfig;
    const handler = context.modelHandler;

    context.log('info', 'Processing complete');
  });
}
```

### Migration Example

```typescript
// Before - many parameters
public async createResponse(
  executionId: ExecutionId,
  streamTabId: StreamTabId,
  logger: AgentLogger,
  modelHandler: IModelHandler,
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  messages: Message[],
): Promise<Response> {
  const groupId = await logger.startGroup('API Call');
  try {
    logger.info('Making request', groupId);
    const response = await modelHandler.createResponse(messages);
    logger.info('Request complete', groupId);
    logger.endGroup(groupId);
    return response;
  } catch (error) {
    logger.endGroup(groupId, 'error');
    throw error;
  }
}

// After - single context parameter
public async createResponse(
  context: ExecutionContext,
  messages: Message[],
): Promise<Response> {
  return context.withGroup('API Call', async () => {
    context.log('info', 'Making request');
    const response = await context.modelHandler.createResponse(messages);
    context.log('info', 'Request complete');
    return response;
  });
}
```

## Integration with Existing Code

Both new abstractions are designed for gradual adoption:

### ScopedAgentLogger

`ScopedAgentLogger` extends `AgentLogger`, so it can be used anywhere `AgentLogger` is expected:

```typescript
// Backward compatible
function processWithLogger(logger: AgentLogger) {
  logger.info('Message', groupId); // Still works
}

const scopedLogger = new ScopedAgentLogger(channelId);
processWithLogger(scopedLogger); // Works fine

// Can also use new features
await scopedLogger.withGroup('Task', async () => {
  scopedLogger.info('Message'); // No groupId needed
});
```

### ExecutionContext in AgentCycleOptions

The `executionContext` field was added as optional to `AgentCycleBaseOptions`:

```typescript
export interface AgentCycleBaseOptions<C = unknown> {
  // Existing fields (unchanged)
  modelHandler: IModelHandler<any, any, any, any, C>;
  agentSetting: AgentSetting;
  logger: AgentLogger;
  executionId?: ExecutionId;
  // ... other fields

  // New optional field
  executionContext?: ExecutionContext<C>;
}
```

This allows code to gradually migrate:

```typescript
async function processCycle(options: AgentCycleBaseOptions) {
  if (options.executionContext) {
    // Use new unified context
    await options.executionContext.withGroup('Processing', async () => {
      options.executionContext.log('info', 'Using new context');
    });
  } else {
    // Fallback to old pattern
    const groupId = await options.logger.startGroup('Processing');
    options.logger.info('Using old pattern', groupId);
    options.logger.endGroup(groupId);
  }
}
```

## Benefits

### Reduced Boilerplate

- **Before**: ~200+ lines of manual group ID management
- **After**: Automatic scope management eliminates most of these lines

### Improved Type Safety

```typescript
// Before - easy to make mistakes
logger.info('Message'); // Oops, forgot groupId - logs appear outside any group

// After - automatic scope
await logger.withGroup('Task', async () => {
  logger.info('Message'); // Always scoped correctly
});
```

### Simpler Method Signatures

```typescript
// Before
async processData(
  executionId: ExecutionId,
  logger: AgentLogger,
  handler: IModelHandler,
  config: AgentConfig,
  setting: AgentSetting,
  groupId: string,
): Promise<void>

// After
async processData(context: ExecutionContext): Promise<void>
```

### Better Error Handling

```typescript
// Before - manual try/catch/finally
const groupId = await logger.startGroup('Task');
try {
  // ... work
  logger.endGroup(groupId);
} catch (error) {
  logger.endGroup(groupId, 'error');
  throw error;
}

// After - automatic cleanup
await logger.withGroup('Task', async () => {
  // ... work
  // Group automatically ended with correct status
});
```

## API Reference

### ScopedAgentLogger

#### Methods

- `withGroup<T>(name: string, callback: () => Promise<T>, parentId?: string): Promise<T>`
  - Execute callback within a log group scope
  - Automatically manages group lifecycle

- `withGroupConditional<T>(name: string, callback: (groupId?) => Promise<T>, options?): Promise<T>`
  - Conditional group creation with flexible options

- `getCurrentScope(): string | undefined`
  - Get the current active group ID

- `getScopeDepth(): number`
  - Get the current nesting depth

- `hasActiveScope(): boolean`
  - Check if currently within a group

- `withTemporaryScope<T>(groupId: string | undefined, callback: () => Promise<T>): Promise<T>`
  - Temporarily switch to a different group scope

All standard logging methods (`debug`, `info`, `warn`, `error`, `fileList`, etc.) automatically use the current scope.

### ExecutionContext

#### Properties

- `executionId: ExecutionId` - Unique execution identifier
- `streamTabId: StreamTabId` - UI tab identifier
- `logger: ScopedAgentLogger` - Scoped logger instance
- `modelHandler: IModelHandler` - Model handler
- `agentConfig: AgentConfig` - Agent configuration
- `agentSetting: AgentSetting` - Agent settings

#### Methods

- `withGroup<T>(name: string, callback: () => Promise<T>): Promise<T>`
  - Execute callback within a log group (delegates to logger)

- `log(level: string, message: string, messageType?: MessageType, data?: unknown): void`
  - Log a message (delegates to logger with current scope)

- `getCurrentGroupId(): string | undefined`
  - Get current active group ID

### ExecutionContextFactory

#### Methods

- `create<C>(params: {...}): ExecutionContext<C>`
  - Create a new ExecutionContext instance

## Testing

Tests are provided in `/src/test/logger/ScopedAgentLogger.test.ts` covering:

- Basic logging with automatic scope
- Nested group management
- Error handling with automatic cleanup
- Conditional group execution
- Specialized logging methods (fileList, statistics, etc.)
- Scope depth tracking
- Temporary scope switching

Run tests with:

```bash
npm test -- ScopedAgentLogger
```

## Future Work

Potential future enhancements:

1. **Full migration**: Gradually migrate all agent code to use `ScopedAgentLogger` and `ExecutionContext`
2. **Performance logging**: Add automatic timing for groups
3. **Structured context**: Add ability to attach key-value context to groups
4. **Context propagation**: Explore async context propagation mechanisms
5. **Deprecation**: Eventually deprecate manual `groupId` parameter passing

## Questions?

For questions or issues with these new abstractions, see:

- Source: `/src/logger/ScopedAgentLogger.ts`
- Source: `/src/agent/core/ExecutionContext.ts`
- Tests: `/src/test/logger/ScopedAgentLogger.test.ts`
