# ProgressView Refactoring Proposal

## Current Issues

After analyzing the codebase, I've identified several issues with the current TypeScript structure that violate the design principles outlined in AGENTS.md:

### 1. **Monolithic ProgressViewProvider Class**
- The `ProgressViewProvider` class has grown to 999 lines and handles too many responsibilities
- It directly manages state, DOM updates, message handling, and business logic
- Contains 30+ public methods mixing different concerns (stream management, file operations, usage tracking, etc.)
- Violates the "deep modules" principle by exposing too many implementation details

### 2. **Shallow ProgressStateManager**
- The `ProgressStateManager` is mostly a data container with getters/setters
- It lacks meaningful abstraction and just passes data through
- Storage operations are tightly coupled to the manager itself
- No clear separation between state management and persistence

### 3. **Inconsistency with JavaScript Architecture**
- JavaScript modules follow a clean separation of concerns with focused manager classes
- TypeScript code doesn't follow the same modular pattern seen in `progressViewState.js`, `domHandlers.js`, etc.
- Missing the organized structure of UI managers, task managers, and usage managers

### 4. **Information Leakage Between Modules**
- Event bus listeners are directly coupled to provider methods
- State management logic is scattered across provider and state manager
- No clear interface boundaries between different responsibilities

## Proposed Refactoring

Following the principles from "A Philosophy of Software Design" and the patterns established in the JavaScript modules, I propose restructuring the TypeScript code into focused, deep modules:

### 1. **Core State Management Layer**

```typescript
// src/progressView/state/ProgressViewState.ts
export class ProgressViewState {
  private _streamTabs: StreamTabsManager;
  private _taskGroups: TaskGroupsManager;
  private _outputFiles: OutputFilesManager;
  private _usageStats: UsageStatsManager;
  private _activeStream: string;

  constructor(persistenceManager: StatePersistenceManager) {
    this._streamTabs = new StreamTabsManager(persistenceManager);
    this._taskGroups = new TaskGroupsManager(persistenceManager);
    this._outputFiles = new OutputFilesManager(persistenceManager);
    this._usageStats = new UsageStatsManager(persistenceManager);
  }

  // Simple, focused interface
  get streamTabs() { return this._streamTabs; }
  get taskGroups() { return this._taskGroups; }
  get outputFiles() { return this._outputFiles; }
  get usageStats() { return this._usageStats; }
  
  get activeStream() { return this._activeStream; }
  set activeStream(stream: string) { this._activeStream = stream; }
}
```

### 2. **Focused Manager Classes**

```typescript
// src/progressView/managers/StreamTabsManager.ts
export class StreamTabsManager {
  private _tabs: Map<string, LogMessageData[]> = new Map();
  
  constructor(private persistence: StatePersistenceManager) {}
  
  add(stream: string, message: LogMessageData): void
  get(stream: string): LogMessageData[] | undefined
  has(stream: string): boolean
  delete(stream: string): void
  clear(): void
  keys(): string[]
}

// src/progressView/managers/TaskGroupsManager.ts
export class TaskGroupsManager {
  private _groups: Map<string, Map<string, TaskGroup>> = new Map();
  
  constructor(private persistence: StatePersistenceManager) {}
  
  addGroup(stream: string, groupId: string, group: TaskGroup): void
  updateGroup(stream: string, groupId: string, updates: Partial<TaskGroup>): void
  getGroup(stream: string, groupId: string): TaskGroup | undefined
  getStreamGroups(stream: string): Map<string, TaskGroup>
  deleteStream(stream: string): void
}

// Similar focused managers for OutputFiles, UsageStats, etc.
```

### 3. **Clean Persistence Layer**

```typescript
// src/progressView/persistence/StatePersistenceManager.ts
export class StatePersistenceManager {
  constructor(private workspaceState: vscode.Memento) {}
  
  async load<T>(key: string, defaultValue: T): Promise<T>
  async save<T>(key: string, value: T): Promise<void>
  async delete(key: string): Promise<void>
  
  // Workspace-specific key generation
  private getWorkspaceKey(key: string): string
}
```

### 4. **Event Handling Layer**

```typescript
// src/progressView/events/ProgressEventHandler.ts
export class ProgressEventHandler {
  constructor(
    private state: ProgressViewState,
    private webviewUpdater: WebviewUpdater
  ) {}
  
  setupEventListeners(): vscode.Disposable[] {
    return [
      onProgress('setActiveStream', this.handleSetActiveStream.bind(this)),
      onProgress('addLogMessage', this.handleAddLogMessage.bind(this)),
      onProgress('updateStreamStatus', this.handleUpdateStreamStatus.bind(this)),
      // ... other focused event handlers
    ];
  }
  
  private handleSetActiveStream(stream: string): void
  private handleAddLogMessage(data: {stream: string, logMessage: LogMessageData}): void
  // ... other focused handlers
}
```

### 5. **Webview Management Layer**

```typescript
// src/progressView/webview/WebviewUpdater.ts
export class WebviewUpdater {
  constructor(private getWebview: () => vscode.Webview | undefined) {}
  
  updateStreams(streams: string[], activeStream: string): void
  updateLogContent(stream: string, messages: LogMessageData[]): void
  updateFiles(stream: string, files: OutputFileInfo[]): void
  updateUsage(usage: TokenUsageStats): void
  updateStatus(status: StatusType): void
}
```

### 6. **Simplified ProgressViewProvider**

```typescript
// src/progressView/ProgressViewProvider.ts
export class ProgressViewProvider implements vscode.WebviewViewProvider {
  private state: ProgressViewState;
  private eventHandler: ProgressEventHandler;
  private webviewUpdater: WebviewUpdater;
  private contentProvider: ProgressViewContentProvider;
  private messageHandler: ProgressViewMessageHandler;
  
  constructor(context: vscode.ExtensionContext, title: string = 'Tasks') {
    const persistenceManager = new StatePersistenceManager(context.workspaceState);
    this.state = new ProgressViewState(persistenceManager);
    this.webviewUpdater = new WebviewUpdater(() => this._view?.webview);
    this.eventHandler = new ProgressEventHandler(this.state, this.webviewUpdater);
    this.contentProvider = new ProgressViewContentProvider(context);
    this.messageHandler = new ProgressViewMessageHandler(this.state);
  }
  
  async initialize(): Promise<void> {
    await this.state.load();
    this._disposables.push(...this.eventHandler.setupEventListeners());
  }
  
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Simplified - just setup and delegate
    this._view = webviewView;
    this.setupWebview(webviewView);
    this.webviewUpdater.updateAll(this.state);
  }
}
```

## Benefits of This Approach

### 1. **Deep Modules with Clear Interfaces**
- Each manager class has a focused responsibility and hides implementation details
- Clean separation between state management, persistence, and presentation
- Follows the same pattern as JavaScript modules (`TaskGroups`, `UsageSummary`, etc.)

### 2. **Reduced Complexity**
- No more 999-line monolithic class
- Each module can be understood and tested independently
- Clear dependency injection pattern prevents circular dependencies

### 3. **Consistency with JavaScript Architecture**
- TypeScript structure mirrors the JavaScript modular approach
- Same naming conventions and organization patterns
- Easier for developers to navigate between client and server code

### 4. **Better Separation of Concerns**
- State management is separate from persistence
- Event handling is separate from business logic
- Webview updates are separate from state changes
- Follows the "avoid backward compatibility pass-through methods" guideline

### 5. **Improved Maintainability**
- Each class has a single reason to change
- Dependencies are explicit and injectable
- Easier to add new features without modifying existing code

## Migration Strategy

1. **Phase 1**: Create new manager classes alongside existing code
2. **Phase 2**: Migrate state operations to use new managers
3. **Phase 3**: Refactor event handling to use new structure
4. **Phase 4**: Simplify ProgressViewProvider to use new architecture
5. **Phase 5**: Remove old code and update tests

This approach ensures the system will have the structure it would have had if designed from the start with proper separation of concerns, following the design philosophy outlined in AGENTS.md.