# Supabase Auth Operations

This note records the operational checks for TeXRA's hosted Supabase auth
project. It is intended for maintainers who can inspect the Supabase dashboard
for `remote.texra.ai`.

## Email sign-up and recovery outage

Email/password sign-up and password recovery both depend on the Supabase Auth
mailer. GoTrue sends the confirmation or recovery message before it commits the
auth transaction. If SMTP is misconfigured or the mailer hangs, the public API
can return `504 upstream request timeout` and the transaction can roll back. In
that failure mode no `auth.users` row is created, even though the user submitted
a valid sign-up form.

This can look like an auth hook problem, but the recovery endpoint is a useful
control case: `POST /auth/v1/recover` for an existing user sends email and does
not involve the Before User Created hook. If both sign-up and recovery hang, the
mailer should be checked before changing hook code.

## OAuth provider sign-up outage

OAuth providers can fail before Supabase sees the user. The June 2026 outage had
this shape for Google: existing users who had already granted consent could
continue logging in, but new users were blocked on Google's side because the
OAuth app was in Testing mode. Supabase had little useful evidence because the
failure happened before the normal user-creation path.

Diagnose OAuth outages by splitting sign-ups by provider, not only by the total
number of new users. A provider-specific zero with other providers still working
usually points to that identity provider's configuration.

For Google, check:

1. **Google Cloud Console** -> **Google Auth Platform** -> **Audience**:
   publishing status should be **In production**, not **Testing**.
2. **Google Cloud Console** -> **APIs & Services** -> **Credentials**: verify the
   OAuth client ID and client secret used by Supabase.
3. **Supabase Dashboard** -> **Authentication** -> **Providers** -> **Google**:
   verify the stored client ID and secret.
4. **Supabase Dashboard** -> **Authentication** -> **URL Configuration**: verify
   the redirect URL allow-list still covers the extension and CLI flows.
5. Auth logs around the failure window: if `/auth/v1/authorize` redirects to
   Google but no user appears, inspect the provider console and consent-screen
   status before assuming a Supabase hook or database problem.

## Email first response checklist

1. In Supabase Dashboard, open **Project Settings** -> **Authentication** ->
   **SMTP**.
2. Verify the SMTP host, port, username, password, sender address, reply-to
   address, and TLS/security mode against the provider's current settings.
3. Save the SMTP settings and use an owned canary address for validation.
4. Check **Authentication** -> **Hooks** and confirm that **Before User Created**
   points to `https://remote.texra.ai/functions/v1/before-user-created`.
5. If the hook was disabled during diagnosis, re-enable it after SMTP is known
   to work.
6. Inspect Auth and Edge Function logs. A quick hook response together with
   hanging sign-up and recovery requests points to email delivery, not hook
   execution.

Use only owned maintainer or canary accounts for probes. Do not use arbitrary
third-party email addresses when testing auth flows.

## Verification

After changing SMTP or hook settings, verify all of the following:

1. Password recovery for an existing canary user returns promptly and delivers a
   recovery email.
2. Email/password sign-up for a fresh canary address returns promptly, creates
   an `auth.users` row, and delivers the confirmation email.
3. Google sign-up for a fresh canary account that has not already granted consent
   completes end to end.
4. The Before User Created hook is enabled and its logs show a normal allow or
   deny response.
5. Existing OAuth sign-in still works.
6. GitHub sign-up through `supabase/functions/auth-github/index.ts` still works.
   That path uses `admin.createUser({ email_confirm: true })`, so it is not a
   substitute for testing the email mailer path.

Clean up disposable canary users after the test if they are not meant to remain
in the project.

## Distinguishing likely causes

| Observation                                                                                                      | Most likely cause                                                     |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/auth/v1/signup` hangs, no `auth.users` row appears, and `/auth/v1/recover` also hangs                          | SMTP or email delivery misconfiguration                               |
| `/auth/v1/signup` fails quickly, `/auth/v1/recover` succeeds, and the Edge Function logs show a rejection        | Before User Created policy rejected the user                          |
| `/auth/v1/signup` returns `401` or signature errors appear in Edge Function logs                                 | Hook secret or webhook signature configuration                        |
| OAuth sign-in works while email sign-up and recovery fail                                                        | OAuth path bypasses confirmation email; check SMTP                    |
| New Google users fail before any Supabase user row or hook log appears, while existing Google users still log in | Google OAuth publishing status, consent screen, or client credentials |
| One OAuth provider has zero new users while other providers still create users                                   | Provider-specific OAuth configuration or provider outage              |

## Sign-up funnel alert

The outage classes above can be silent: failed email sign-ups can roll back and
leave no user row, and provider-side OAuth failures can happen before Supabase
records a flow. A low-volume project should still alert when the sign-up funnel
goes to zero while it previously had traffic.

If an auth audit export is available, alert on zero `user_signedup` events over
24 hours. Otherwise, use `auth.users.created_at` as a durable proxy:

```sql
WITH windows AS (
  SELECT
    COUNT(*) FILTER (
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    ) AS users_24h,
    COUNT(*) FILTER (
      WHERE created_at >= NOW() - INTERVAL '8 days'
        AND created_at < NOW() - INTERVAL '24 hours'
    ) / 7.0 AS prior_daily_avg
  FROM auth.users
)
SELECT
  users_24h,
  prior_daily_avg,
  users_24h = 0 AND prior_daily_avg >= 1 AS alert
FROM windows;
```

For very low-volume periods, tune the baseline threshold rather than disabling
the alert. The important invariant is that a completely inactive sign-up funnel
is noticed within one day.

Also keep a provider-split view, because an aggregate alert can miss the case
where only one provider is broken:

```sql
WITH users_by_provider AS (
  SELECT
    COALESCE(raw_app_meta_data ->> 'provider', 'email') AS provider,
    created_at
  FROM auth.users
),
provider_windows AS (
  SELECT
    provider,
    COUNT(*) FILTER (
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    ) AS users_24h,
    COUNT(*) FILTER (
      WHERE created_at >= NOW() - INTERVAL '8 days'
        AND created_at < NOW() - INTERVAL '24 hours'
    ) / 7.0 AS prior_daily_avg
  FROM users_by_provider
  GROUP BY provider
)
SELECT
  provider,
  users_24h,
  prior_daily_avg,
  users_24h = 0 AND prior_daily_avg >= 1 AS alert
FROM provider_windows
ORDER BY provider;
```

## Hook behavior

The Before User Created hook lives in
`supabase/functions/before-user-created/index.ts`. It is a synchronous gate for
new users. Policy denials should be explicit and quick. Transient GitHub lookup
failures are allowed rather than blocking real sign-ups when the external
dependency is unavailable.

The hook should not be treated as the mailer health check. Use the recovery
endpoint and an email sign-up canary to verify SMTP.
