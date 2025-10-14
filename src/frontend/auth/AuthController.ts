// Third-party imports
import * as vscode from 'vscode';
import type { Session } from '@supabase/supabase-js';

// Local imports - auth helpers
import {
  applySupabaseSession,
  clearSupabaseState,
  ensureSupabaseClient,
  onEntitlementsChanged,
  refreshEntitlements,
  restoreSupabaseState,
  type SupabaseEntitlements,
} from '@common/auth/supabaseClient';
import { scheduleRefresh, type StoredSupabaseSession } from './sessionStorage';
import * as logger from '@logger/logUtils';

const CHANNEL = 'SupabaseAuthController';
logger.initialize(CHANNEL);

export interface AuthStatePayload {
  signedIn: boolean;
  proxyEnabled: boolean;
  proxyExpiresAt?: string;
  remoteAgents: SupabaseEntitlements['remoteAgents'];
  quotaRemainingUsd?: number;
}

export class AuthController {
  private readonly stateEmitter = new vscode.EventEmitter<AuthStatePayload>();
  private state: AuthStatePayload = {
    signedIn: false,
    proxyEnabled: false,
    remoteAgents: [],
  };
  private entitlementSubscription?: vscode.Disposable;
  private refreshTimer?: vscode.Disposable;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public get onDidChangeState(): vscode.Event<AuthStatePayload> {
    return this.stateEmitter.event;
  }

  public getState(): AuthStatePayload {
    return this.state;
  }

  private updateStateFromEntitlements(
    entitlements: SupabaseEntitlements | undefined,
  ): void {
    const proxy = entitlements?.proxy;
    const proxyEnabled = Boolean(proxy?.enabled && proxy?.sessionToken);
    const proxyExpiresAt = proxy?.expiresAt;

    this.state = {
      signedIn: Boolean(entitlements),
      proxyEnabled,
      proxyExpiresAt,
      remoteAgents: entitlements?.remoteAgents ?? [],
      quotaRemainingUsd: entitlements?.quota?.remainingUsd,
    };

    this.stateEmitter.fire(this.state);

    if (this.refreshTimer) {
      this.refreshTimer.dispose();
      this.refreshTimer = undefined;
    }

    if (proxyEnabled && proxyExpiresAt) {
      this.refreshTimer = scheduleRefresh(async () => {
        await this.refreshSession();
      }, proxyExpiresAt);
      if (this.refreshTimer) {
        this.context.subscriptions.push(this.refreshTimer);
      }
    }
  }

  private async handleSupabaseSession(session: Session | null): Promise<void> {
    if (!session) {
      await applySupabaseSession(undefined);
      this.updateStateFromEntitlements(undefined);
      return;
    }

    const tokens: StoredSupabaseSession = {
      accessToken: session.access_token,
      refreshToken: session.refresh_token ?? undefined,
      expiresAt: session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : undefined,
    };

    const entitlements = await applySupabaseSession(tokens);
    this.updateStateFromEntitlements(entitlements);
  }

  public async initialize(): Promise<void> {
    await ensureSupabaseClient();
    const entitlements = await restoreSupabaseState();
    this.updateStateFromEntitlements(entitlements);

    this.entitlementSubscription = onEntitlementsChanged((value) => {
      this.updateStateFromEntitlements(value);
    });
    this.context.subscriptions.push(this.stateEmitter);
    if (this.entitlementSubscription) {
      this.context.subscriptions.push(this.entitlementSubscription);
    }
  }

  public async signIn(): Promise<void> {
    const client = await ensureSupabaseClient();
    if (!client) {
      void vscode.window.showErrorMessage(
        'Supabase credentials are not configured. Set texra.auth.supabaseUrl and texra.auth.supabaseAnonKey.',
      );
      return;
    }

    const email = await vscode.window.showInputBox({
      title: 'TeXRA Sign In',
      placeHolder: 'name@example.com',
      prompt: 'Enter the email associated with your TeXRA account.',
      validateInput: (value) => {
        return value && value.includes('@')
          ? undefined
          : 'Enter a valid email address.';
      },
    });

    if (!email) {
      return;
    }

    const password = await vscode.window.showInputBox({
      title: 'TeXRA Sign In',
      prompt: 'Enter your password.',
      password: true,
    });

    if (!password) {
      return;
    }

    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) {
      logger.warn(CHANNEL, `Supabase sign-in failed: ${result.error.message}`);
      void vscode.window.showErrorMessage(
        `Unable to sign in: ${result.error.message}`,
      );
      return;
    }

    await this.handleSupabaseSession(result.data.session);
    void vscode.window.showInformationMessage(
      'Signed in to TeXRA successfully.',
    );
  }

  public async signOut(): Promise<void> {
    const client = await ensureSupabaseClient();
    try {
      await client?.auth.signOut();
    } catch (err) {
      logger.warn(
        CHANNEL,
        `Error signing out from Supabase: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await clearSupabaseState();
    this.updateStateFromEntitlements(undefined);
    void vscode.window.showInformationMessage('Signed out of TeXRA.');
  }

  public async refreshSession(): Promise<void> {
    const entitlements = await refreshEntitlements();
    if (!entitlements) {
      logger.warn(CHANNEL, 'No Supabase session available to refresh.');
      return;
    }

    this.updateStateFromEntitlements(entitlements);
  }

  public dispose(): void {
    this.entitlementSubscription?.dispose();
    this.refreshTimer?.dispose();
    this.stateEmitter.dispose();
  }
}
