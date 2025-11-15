// Third-party imports
import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

// Local imports
import { SecretManager } from '@frontend/secretManager';
import type { AuthStrategy, AuthSession, UserCredentials } from '../types';
import { AuthError, AuthErrorCode } from '../types';

/**
 * User profile stored in SecretStorage
 */
interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  email?: string;
  displayName?: string;
  createdAt: number;
}

/**
 * Local authentication strategy using username/password
 * Credentials are stored encrypted in VS Code's SecretStorage
 */
export class LocalStrategy implements AuthStrategy {
  public readonly name = 'local';

  private static readonly USERS_KEY = 'auth.local.users';
  private static readonly CREDENTIALS_PREFIX = 'auth.local.credentials';

  /**
   * Authenticate user with username and password
   */
  public async authenticate(scopes: string[]): Promise<AuthSession> {
    // Prompt for username
    const username = await vscode.window.showInputBox({
      prompt: 'Enter your username',
      placeHolder: 'username',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Username is required';
        }
        if (value.length < 3) {
          return 'Username must be at least 3 characters';
        }
        return undefined;
      },
    });

    if (!username) {
      throw new AuthError(
        AuthErrorCode.USER_CANCELLED,
        'Authentication cancelled by user',
      );
    }

    // Prompt for password
    const password = await vscode.window.showInputBox({
      prompt: 'Enter your password',
      placeHolder: 'password',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Password is required';
        }
        return undefined;
      },
    });

    if (!password) {
      throw new AuthError(
        AuthErrorCode.USER_CANCELLED,
        'Authentication cancelled by user',
      );
    }

    // Check if user exists
    const user = await this.getUser(username);

    if (!user) {
      // New user - register
      const email = await this.promptForEmail();
      const newUser = await this.registerUser(username, password, email);

      return {
        id: nanoid(),
        account: {
          id: newUser.id,
          label: newUser.displayName || newUser.username,
          email: newUser.email,
        },
        scopes,
        accessToken: await this.generateToken(newUser.id),
      };
    }

    // Existing user - validate password
    const isValid = await this.validatePassword(password, user.passwordHash);
    if (!isValid) {
      throw new AuthError(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Invalid username or password',
      );
    }

    // Generate access token
    const accessToken = await this.generateToken(user.id);

    return {
      id: nanoid(),
      account: {
        id: user.id,
        label: user.displayName || user.username,
        email: user.email,
      },
      scopes,
      accessToken,
    };
  }

  /**
   * Validate an existing session
   */
  public async validateSession(session: AuthSession): Promise<boolean> {
    try {
      // Check if user still exists
      const users = await this.getAllUsers();
      const user = users.find((u) => u.id === session.account.id);

      if (!user) {
        return false;
      }

      // Validate token format (basic check)
      return Boolean(session.accessToken && session.accessToken.length > 0);
    } catch (error) {
      console.error('Error validating session:', error);
      return false;
    }
  }

  /**
   * Cleanup on logout
   */
  public async cleanup(sessionId: string): Promise<void> {
    // No special cleanup needed for local strategy
    // Session tokens are already removed by SessionManager
  }

  /**
   * Register a new user
   */
  private async registerUser(
    username: string,
    password: string,
    email?: string,
  ): Promise<StoredUser> {
    const users = await this.getAllUsers();

    // Check if username already exists
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new AuthError(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Username already exists',
      );
    }

    // Create new user
    const user: StoredUser = {
      id: nanoid(),
      username,
      passwordHash: await this.hashPassword(password),
      email,
      displayName: username,
      createdAt: Date.now(),
    };

    // Store user
    users.push(user);
    await this.storeAllUsers(users);

    return user;
  }

  /**
   * Get user by username
   */
  private async getUser(username: string): Promise<StoredUser | undefined> {
    const users = await this.getAllUsers();
    return users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
  }

  /**
   * Get all users from SecretStorage
   */
  private async getAllUsers(): Promise<StoredUser[]> {
    const usersJson = await SecretManager.get(LocalStrategy.USERS_KEY);
    if (!usersJson) {
      return [];
    }

    try {
      return JSON.parse(usersJson);
    } catch (error) {
      console.error('Error parsing users:', error);
      return [];
    }
  }

  /**
   * Store all users to SecretStorage
   */
  private async storeAllUsers(users: StoredUser[]): Promise<void> {
    await SecretManager.set(LocalStrategy.USERS_KEY, JSON.stringify(users));
  }

  /**
   * Hash password (simple implementation)
   * Note: In production, use a proper password hashing library like bcrypt
   */
  private async hashPassword(password: string): Promise<string> {
    // For simplicity, using base64 encoding with a salt
    // WARNING: This is NOT secure for production use
    // In production, use bcrypt, argon2, or similar
    const salt = nanoid();
    const combined = `${salt}:${password}`;
    return Buffer.from(combined).toString('base64');
  }

  /**
   * Validate password against hash
   */
  private async validatePassword(
    password: string,
    hash: string,
  ): Promise<boolean> {
    try {
      const decoded = Buffer.from(hash, 'base64').toString('utf-8');
      const [salt, storedPassword] = decoded.split(':');
      return storedPassword === password;
    } catch (error) {
      console.error('Error validating password:', error);
      return false;
    }
  }

  /**
   * Generate access token for user
   */
  private async generateToken(userId: string): Promise<string> {
    // Simple token format: userId:timestamp:random
    // In production, use JWT or similar
    const timestamp = Date.now();
    const random = nanoid();
    return `${userId}:${timestamp}:${random}`;
  }

  /**
   * Prompt for email (optional)
   */
  private async promptForEmail(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: 'Enter your email (optional)',
      placeHolder: 'user@example.com',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value && value.trim().length > 0) {
          // Basic email validation
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(value)) {
            return 'Please enter a valid email address';
          }
        }
        return undefined;
      },
    });
  }

  /**
   * Delete a user (for admin/testing purposes)
   */
  public async deleteUser(userId: string): Promise<void> {
    const users = await this.getAllUsers();
    const filtered = users.filter((u) => u.id !== userId);
    await this.storeAllUsers(filtered);
  }

  /**
   * Get all registered users (for admin/testing purposes)
   */
  public async getUsers(): Promise<
    Array<{ id: string; username: string; email?: string }>
  > {
    const users = await this.getAllUsers();
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
    }));
  }
}
