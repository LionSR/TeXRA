# TeXRA Authentication System Architecture

## Overview

Native TypeScript authentication system for the TeXRA VS Code extension, leveraging VS Code's built-in APIs for secure credential storage and session management.

## Design Principles

1. **Don't Rebuild Wheels**: Use VS Code's native APIs (SecretStorage, Memento, AuthenticationProvider)
2. **Security First**: All credentials stored encrypted via VS Code's SecretStorage
3. **Extensible**: Support multiple auth providers (local, OAuth, custom backends)
4. **User-Friendly**: Simple login/logout commands with status indicators
5. **Stateless Where Possible**: Minimize session state, rely on tokens

## Architecture Components

### 1. Authentication Provider (`src/auth/authProvider.ts`)

Core authentication interface implementing VS Code's `AuthenticationProvider` API.

**Responsibilities**:
- User authentication (login/logout)
- Token management
- Session creation and validation
- Event emission for auth state changes

**Key Methods**:
- `getSessions(scopes?: string[]): Promise<AuthSession[]>`
- `createSession(scopes: string[]): Promise<AuthSession>`
- `removeSession(sessionId: string): Promise<void>`

### 2. Session Manager (`src/auth/sessionManager.ts`)

Manages user sessions with persistence across VS Code restarts.

**Storage**:
- **SecretStorage**: Session tokens, refresh tokens
- **GlobalState**: Session metadata (user info, expiry, scopes)

**Features**:
- Session creation and validation
- Token refresh logic
- Session expiration handling
- Multi-account support

**Session Data Structure**:
```typescript
interface AuthSession {
  id: string;           // Unique session ID
  account: {
    id: string;         // User ID
    label: string;      // Display name
    email?: string;     // User email
  };
  scopes: string[];     // Access scopes
  accessToken: string;  // Access token (stored in SecretStorage)
  expiresAt?: number;   // Token expiration timestamp
}
```

### 3. Authentication Commands (`src/commands/auth/`)

User-facing commands for authentication operations.

**Commands**:
- `texra.auth.login` - Initiate login flow
- `texra.auth.logout` - Sign out and clear session
- `texra.auth.switchAccount` - Switch between accounts
- `texra.auth.refreshSession` - Manually refresh session
- `texra.auth.showStatus` - Display authentication status

### 4. Credential Manager (`src/auth/credentialManager.ts`)

Extends existing `SecretManager` with auth-specific credential handling.

**Features**:
- Username/password storage (encrypted)
- OAuth token storage
- API key association with user accounts
- Credential rotation and expiration

**Key Pattern**:
```typescript
// Naming convention for auth secrets
auth.session.{sessionId}.token
auth.session.{sessionId}.refreshToken
auth.credentials.{provider}.{userId}
```

### 5. Auth UI (`src/auth/authUI.ts`)

Handles user interactions for authentication.

**Components**:
- Login input boxes (username, password, MFA)
- OAuth browser redirect handler
- Status bar authentication indicator
- Quick pick menus for account switching

### 6. Auth Strategies (`src/auth/strategies/`)

Pluggable authentication strategies for different providers.

**Built-in Strategies**:

#### Local Strategy (`localStrategy.ts`)
- Simple username/password authentication
- Credentials stored in SecretStorage
- Good for development and testing

#### OAuth Strategy (`oauthStrategy.ts`)
- OAuth 2.0 / OIDC flow
- PKCE support for enhanced security
- Browser-based authentication redirect
- Token refresh handling

#### Custom Backend Strategy (`backendStrategy.ts`)
- Authenticate against custom API endpoint
- JWT token support
- Token validation and refresh

### 7. State Management

**GlobalState Keys** (add to `src/common/state/stateManager.ts`):
```typescript
export enum GlobalStateKey {
  AUTH_CURRENT_SESSION = 'texra.auth.currentSession',
  AUTH_SESSIONS = 'texra.auth.sessions',
  AUTH_ACCOUNTS = 'texra.auth.accounts',
  AUTH_PREFERENCES = 'texra.auth.preferences',
}
```

**SecretStorage Keys**:
```
auth.session.{id}.accessToken
auth.session.{id}.refreshToken
auth.credentials.{provider}.{userId}
auth.apiKeys.{provider}.{userId}
```

## VS Code Persistence APIs Used

### 1. SecretStorage
- **Purpose**: Store sensitive data (tokens, passwords)
- **Encryption**: OS-level encryption (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)
- **Scope**: Global across workspace sessions
- **API**: `context.secrets.store()`, `context.secrets.get()`, `context.secrets.delete()`

### 2. GlobalState (Memento)
- **Purpose**: Store non-sensitive global data
- **Persistence**: Survives VS Code restarts
- **Scope**: Global across all workspaces
- **API**: `context.globalState.update()`, `context.globalState.get()`

### 3. WorkspaceState (Memento)
- **Purpose**: Store workspace-specific auth preferences
- **Persistence**: Per-workspace settings
- **Scope**: Current workspace only
- **API**: `context.workspaceState.update()`, `context.workspaceState.get()`

### 4. AuthenticationProvider API
- **Purpose**: Standardized auth interface for VS Code
- **Features**: Sessions, accounts, scopes
- **Integration**: Works with VS Code's account menu
- **API**: `vscode.authentication.registerAuthenticationProvider()`

## Authentication Flows

### Flow 1: Local Login (Username/Password)

```
User → Command: texra.auth.login
  ↓
AuthUI → Input: Username
  ↓
AuthUI → Input: Password (masked)
  ↓
LocalStrategy → Validate credentials
  ↓
SessionManager → Create session
  ↓
SecretStorage → Store session token
  ↓
GlobalState → Store session metadata
  ↓
StatusBar → Update indicator ✓
```

### Flow 2: OAuth Login

```
User → Command: texra.auth.login
  ↓
OAuthStrategy → Generate PKCE challenge
  ↓
Browser → Redirect to OAuth provider
  ↓
User → Authorize application
  ↓
Redirect → vscode://texra/auth/callback?code=...
  ↓
OAuthStrategy → Exchange code for token
  ↓
SessionManager → Create session
  ↓
SecretStorage → Store tokens
  ↓
StatusBar → Update indicator ✓
```

### Flow 3: Session Restoration (on extension activation)

```
Extension → activate()
  ↓
SessionManager → Load from GlobalState
  ↓
SessionManager → Validate token expiry
  ↓
  [Token Valid] → Restore session
  [Token Expired] → Attempt refresh
    ↓
    [Refresh Success] → Update tokens
    [Refresh Failed] → Clear session
```

## Security Considerations

1. **Never Log Sensitive Data**: Tokens, passwords, secrets
2. **Token Expiration**: All sessions have TTL
3. **Automatic Cleanup**: Remove expired sessions on startup
4. **Secure Transmission**: HTTPS only for backend communication
5. **PKCE for OAuth**: Protect against authorization code interception
6. **Scope Validation**: Check permissions before operations
7. **Rate Limiting**: Prevent brute force attacks (local strategy)
8. **Audit Logging**: Track authentication events (optional)

## Configuration Settings

Add to `package.json` configuration:

```json
{
  "texra.auth.enabled": {
    "type": "boolean",
    "default": false,
    "description": "Enable user authentication"
  },
  "texra.auth.provider": {
    "type": "string",
    "enum": ["local", "oauth", "custom"],
    "default": "local",
    "description": "Authentication provider to use"
  },
  "texra.auth.sessionTimeout": {
    "type": "number",
    "default": 86400,
    "description": "Session timeout in seconds (default: 24 hours)"
  },
  "texra.auth.rememberMe": {
    "type": "boolean",
    "default": true,
    "description": "Remember authentication across VS Code restarts"
  },
  "texra.auth.oauthClientId": {
    "type": "string",
    "default": "",
    "description": "OAuth client ID (for OAuth strategy)"
  },
  "texra.auth.customBackendUrl": {
    "type": "string",
    "default": "",
    "description": "Custom authentication backend URL"
  }
}
```

## Integration with Existing Code

### 1. SecretManager Extension

Extend `src/frontend/secretManager.ts`:

```typescript
// Add user-scoped API keys
public static async getUserApiKey(
  userId: string,
  provider: ApiProvider
): Promise<string> {
  const key = `auth.apiKeys.${provider}.${userId}`;
  return this.get(key);
}
```

### 2. Model Handler Integration

Modify `src/agent/modelHandlers/ModelHandler.ts`:

```typescript
public async getApiKey(): Promise<string> {
  // Check if user is authenticated
  const session = await AuthProvider.getCurrentSession();
  if (session) {
    // Get user-specific API key
    return SecretManager.getUserApiKey(session.account.id, this.provider);
  }
  // Fallback to global API key
  return SecretManager.getApiKey(this.provider);
}
```

### 3. Usage Tracking

Track API usage per user for quota management:

```typescript
// src/auth/usageTracker.ts
export class UsageTracker {
  async trackRequest(userId: string, model: string, tokens: number) {
    // Store usage data in WorkspaceState
  }

  async getUserUsage(userId: string): Promise<Usage> {
    // Retrieve usage stats
  }
}
```

## File Structure

```
src/auth/
├── authProvider.ts          # Main AuthenticationProvider implementation
├── sessionManager.ts        # Session lifecycle management
├── credentialManager.ts     # Credential storage and retrieval
├── authUI.ts               # User interface components
├── usageTracker.ts         # Track API usage per user
├── strategies/
│   ├── baseStrategy.ts     # Abstract base strategy
│   ├── localStrategy.ts    # Local username/password auth
│   ├── oauthStrategy.ts    # OAuth 2.0 flow
│   └── backendStrategy.ts  # Custom backend authentication
└── types.ts                # TypeScript interfaces

src/commands/auth/
├── loginCommand.ts         # Login command
├── logoutCommand.ts        # Logout command
├── switchAccountCommand.ts # Account switching
└── index.ts               # Export all auth commands
```

## Implementation Phases

### Phase 1: Core Infrastructure (MVP)
- [ ] Create auth types and interfaces
- [ ] Implement SessionManager
- [ ] Implement LocalStrategy
- [ ] Create login/logout commands
- [ ] Add status bar indicator

### Phase 2: Enhanced Features
- [ ] Implement OAuthStrategy
- [ ] Add multi-account support
- [ ] Create account switcher UI
- [ ] Add session refresh logic
- [ ] Implement usage tracking

### Phase 3: Backend Integration
- [ ] Implement BackendStrategy
- [ ] Add JWT token support
- [ ] Create user API endpoint integration
- [ ] Add quota/limits enforcement

### Phase 4: Polish
- [ ] Add comprehensive error handling
- [ ] Implement audit logging
- [ ] Add telemetry (privacy-preserving)
- [ ] Write tests
- [ ] Update documentation

## Benefits

1. **Multi-User Support**: Different users can use same VS Code installation with separate API keys
2. **Usage Tracking**: Track API usage per user for billing/limits
3. **Security**: Encrypted credential storage, session management
4. **Flexibility**: Multiple auth strategies (local, OAuth, custom)
5. **Native Integration**: Uses VS Code's built-in authentication UI
6. **Persistence**: Sessions survive VS Code restarts
7. **Extensibility**: Easy to add new auth providers

## Alternative: Lightweight Implementation

If full AuthenticationProvider is overkill, implement a simpler version:

1. **Simple Session Store**: Just track logged-in user in GlobalState
2. **Token Storage**: Use existing SecretManager with user prefix
3. **Basic Commands**: Login (input box) and logout
4. **Status Indicator**: Status bar item showing username

This can be implemented in ~500 lines of code vs ~2000+ for full system.
