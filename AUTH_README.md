# TeXRA Authentication System

A native TypeScript authentication system for the TeXRA VS Code extension, providing secure user login, session management, and multi-account support.

## Features

- **Secure Credential Storage**: All credentials stored encrypted via VS Code's SecretStorage API
- **Session Management**: Persistent sessions across VS Code restarts
- **Multi-Account Support**: Switch between multiple logged-in accounts
- **Local Authentication**: Username/password authentication (extensible to OAuth and custom backends)
- **Status Bar Integration**: Visual indicator showing current authentication status
- **VS Code Native**: Uses VS Code's AuthenticationProvider API for seamless integration

## Getting Started

### Enable Authentication

1. Open VS Code Settings (`Cmd/Ctrl + ,`)
2. Search for "TeXRA Authentication"
3. Enable `texra.auth.enabled`

### Login

**Via Command Palette**:
1. Press `Cmd/Ctrl + Shift + P`
2. Type "TeXRA: Login"
3. Enter your username
4. Enter your password
5. Optionally enter your email

**First-time users**: If the username doesn't exist, a new account will be automatically created.

### View Authentication Status

Click the authentication status bar item (bottom-left) showing `$(account) username` or use:
- Command Palette → "TeXRA: Show Authentication Status"

### Logout

**Single Account**:
- Command Palette → "TeXRA: Logout"

**Multiple Accounts**:
- Choose "Logout current account" or "Logout all accounts"

### Switch Between Accounts

- Command Palette → "TeXRA: Switch Account"
- Select the account you want to switch to

## Commands

| Command | Description |
|---------|-------------|
| `TeXRA: Login` | Authenticate and create a new session |
| `TeXRA: Logout` | Sign out from current or all accounts |
| `TeXRA: Switch Account` | Switch between logged-in accounts |
| `TeXRA: Show Authentication Status` | Display current auth status and accounts |

## Configuration

### Settings

```json
{
  // Enable the authentication system
  "texra.auth.enabled": false,

  // Show authentication status in the status bar
  "texra.auth.showStatusBar": true,

  // Session timeout in seconds (0 = no timeout)
  "texra.auth.sessionTimeout": 86400,

  // Remember sessions across VS Code restarts
  "texra.auth.rememberMe": true
}
```

### Configuration Options Explained

**texra.auth.enabled** (default: `false`)
- Master switch for the authentication system
- Set to `true` to enable authentication features

**texra.auth.showStatusBar** (default: `true`)
- Shows/hides the authentication status bar item
- Displays current username and account count

**texra.auth.sessionTimeout** (default: `86400` = 24 hours)
- How long a session remains valid in seconds
- Set to `0` for sessions that never expire
- Expired sessions are automatically cleaned up on extension activation

**texra.auth.rememberMe** (default: `true`)
- Persist sessions across VS Code restarts
- When disabled, you'll need to login each time you open VS Code

## Architecture

### Components

```
src/auth/
├── types.ts                 # TypeScript interfaces and types
├── sessionManager.ts        # Session lifecycle management
├── authProvider.ts          # Main authentication provider
├── authStatusBar.ts         # Status bar integration
├── strategies/
│   └── localStrategy.ts     # Local username/password authentication
└── index.ts                 # Module exports

src/commands/auth/
├── loginCommand.ts          # Login command implementation
├── logoutCommand.ts         # Logout command implementation
├── switchAccountCommand.ts  # Account switching
├── authStatusCommand.ts     # Status display
├── registerAuthCommands.ts  # Command registration
└── index.ts                 # Command exports
```

### Storage

**SecretStorage** (Encrypted):
- Session access tokens
- User credentials (passwords)
- Keys: `auth.session.{id}.accessToken`, `auth.local.users`

**GlobalState** (Memento):
- Session metadata (account info, scopes, timestamps)
- Current active session ID
- Keys: `texra.auth.sessions`, `texra.auth.currentSession`

### Authentication Flow

```
1. User runs "TeXRA: Login" command
   ↓
2. Input dialog prompts for username
   ↓
3. Input dialog prompts for password (masked)
   ↓
4. LocalStrategy checks if user exists
   ↓
   [New User] → Create account, store encrypted password
   [Existing User] → Validate password
   ↓
5. SessionManager creates session
   ↓
6. Access token stored in SecretStorage (encrypted)
   ↓
7. Session metadata stored in GlobalState
   ↓
8. AuthProvider fires session change event
   ↓
9. Status bar updates to show logged-in user
```

## Security

### Password Storage

⚠️ **Development Notice**: The current implementation uses a simple encoding for password storage. This is **NOT suitable for production use**.

For production deployments, replace the password hashing in `src/auth/strategies/localStrategy.ts` with a proper cryptographic library like:
- **bcrypt** - Industry standard password hashing
- **argon2** - Modern, memory-hard password hashing (recommended)

### Credential Protection

- ✅ All credentials stored via VS Code's SecretStorage API
- ✅ OS-level encryption (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)
- ✅ Passwords masked in input dialogs
- ✅ No plaintext storage in files or logs
- ✅ Automatic cleanup of expired sessions

### Session Security

- Sessions have configurable expiration (default: 24 hours)
- Expired sessions automatically removed on startup
- Token validation before each use
- Scoped access control support

## Extending Authentication

### Adding OAuth Support

1. Create `src/auth/strategies/oauthStrategy.ts`
2. Implement the `AuthStrategy` interface
3. Configure OAuth provider settings in `package.json`
4. Update `authProvider.ts` to use OAuth strategy

See `ARCHITECTURE_AUTH.md` for detailed OAuth implementation guide.

### Adding Custom Backend

1. Create `src/auth/strategies/backendStrategy.ts`
2. Implement authentication against your API endpoint
3. Handle JWT token refresh
4. Configure backend URL in settings

## Troubleshooting

### Issue: "Not logged in" even after login

**Solution**:
1. Check that `texra.auth.enabled` is `true`
2. Try logging out and back in
3. Check VS Code Developer Tools (Help → Toggle Developer Tools) for errors

### Issue: Sessions not persisting across restarts

**Solution**:
1. Verify `texra.auth.rememberMe` is `true`
2. Check GlobalState is not being cleared by other extensions
3. Try creating a new session

### Issue: Authentication commands not appearing

**Solution**:
1. Reload VS Code window (`Cmd/Ctrl + R`)
2. Verify extension is activated
3. Check Command Palette for "TeXRA: " prefix

### Issue: Password validation failing

**Solution**:
1. Ensure you're entering the same password used during registration
2. Try creating a new account with a different username
3. For testing, check stored users via Developer Tools Console:
   ```javascript
   // In VS Code Developer Tools Console
   vscode.workspace.getConfiguration('texra')
   ```

## API Integration

### Getting Current User Session

```typescript
import { TeXRAAuthProvider } from '@auth/index';

const authProvider = new TeXRAAuthProvider();
const session = await authProvider.getCurrentSession();

if (session) {
  console.log('Logged in as:', session.account.label);
  console.log('User ID:', session.account.id);
  console.log('Access token:', session.accessToken);
}
```

### Checking Authentication Status

```typescript
const sessions = await authProvider.getSessions();
const isAuthenticated = sessions.length > 0;

if (isAuthenticated) {
  console.log(`${sessions.length} account(s) logged in`);
}
```

### Getting User-Specific API Keys

Extend `SecretManager` to associate API keys with users:

```typescript
// In src/frontend/secretManager.ts
public static async getUserApiKey(
  userId: string,
  provider: ApiProvider
): Promise<string> {
  const key = `auth.apiKeys.${provider}.${userId}`;
  return this.get(key);
}
```

## Future Enhancements

Potential additions to the authentication system:

- [ ] OAuth 2.0 / OIDC support
- [ ] Multi-factor authentication (MFA)
- [ ] Password reset functionality
- [ ] Account profile management
- [ ] Usage quotas per user
- [ ] Team/organization accounts
- [ ] API key management UI
- [ ] Audit logging
- [ ] Session activity tracking
- [ ] Password strength validation
- [ ] Proper password hashing (bcrypt/argon2)

## License

See main TeXRA LICENSE file.

## Support

For issues or questions:
1. Check this documentation
2. Review `ARCHITECTURE_AUTH.md` for technical details
3. Open an issue on the TeXRA repository
