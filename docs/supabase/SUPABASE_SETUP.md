# Supabase Setup Guide for TeXRA Remote Agents

This guide walks you through setting up Supabase for TeXRA's authentication and remote agents feature.

## Overview

TeXRA uses Supabase for:

- **User Authentication** - OAuth login (GitHub, Google)
- **Remote Agents** - Secure storage and access control for agent configurations
- **Permissions** - Flexible visibility-based access (users see agents matching their permissions)

**Important**: Users authenticate to **TeXRA's official Supabase service**, not their own. This guide is for **extension maintainers** who need to set up the TeXRA backend.

For production auth operations, including SMTP outage diagnosis, Before User Created
hook checks, and sign-up funnel alerting, see
[`AUTH_OPERATIONS.md`](./AUTH_OPERATIONS.md).

---

## Part 1: Create Supabase Project

### 1. Sign up for Supabase

1. Go to [supabase.com](https://supabase.com)
2. Click "Start your project"
3. Sign in with GitHub (recommended)

### 2. Create a New Project

1. Click "New Project"
2. Choose an organization (or create one)
3. Set project details:
   - **Name**: `texra-production` (or your choice)
   - **Database Password**: Generate a strong password and **save it securely**
   - **Region**: Choose closest to your primary user base
4. Click "Create new project"
5. Wait 2-3 minutes for setup to complete

### 3. Get Project Credentials

Once your project is ready:

1. Go to **Settings** → **API** (or **Settings** → **API Keys** for newer dashboard)
2. **IMPORTANT**: Copy these values:
   - **Project URL**: `https://your-project-id.supabase.co`
   - **Publishable key**: Starts with `sb_publishable_...`

**These are compiled into the clients (see Part 6).**

---

## Understanding API Keys

The client ships a publishable key (`sb_publishable_...`,
`src/auth/config.ts`). It is designed to be embedded in client code: it does
**not** protect data by itself. Row Level Security (RLS) policies on the
database tables control actual data access.

Never expose `service_role` or secret keys (`sb_secret_...`) in client code.
These elevated keys bypass RLS and belong only in server-side code (Edge
Functions).

---

## Part 2: Configure OAuth Providers

### GitHub OAuth (Recommended for Developers)

#### Step 1: Create GitHub OAuth App

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: `TeXRA Extension`
   - **Homepage URL**: `https://your-project-id.supabase.co`
   - **Authorization callback URL**: `https://your-project-id.supabase.co/auth/v1/callback`
4. Click "Register application"
5. Click "Generate a new client secret"
6. **Copy both Client ID and Client Secret** (save securely)

#### Step 2: Configure in Supabase

1. In Supabase dashboard, go to **Authentication** → **Providers**
2. Find "GitHub" and click to expand
3. Enable GitHub provider
4. Enter:
   - **Client ID**: (from GitHub app)
   - **Client Secret**: (from GitHub app)
5. Click "Save"

### Google OAuth (Optional, for General Users)

#### Step 1: Create Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable "Google+ API"
4. Go to **APIs & Services** → **Credentials**
5. Click "Create Credentials" → "OAuth client ID"
6. Choose "Web application"
7. Add **Authorized redirect URIs**:
   - `https://your-project-id.supabase.co/auth/v1/callback`
8. Click "Create"
9. **Copy Client ID and Client Secret**

#### Step 2: Configure in Supabase

1. In Supabase dashboard, go to **Authentication** → **Providers**
2. Find "Google" and click to expand
3. Enable Google provider
4. Enter:
   - **Client ID**: (from Google Cloud)
   - **Client Secret**: (from Google Cloud)
5. Click "Save"

### ⚠️ CRITICAL: Configure VS Code Redirect URLs

For the VS Code extension OAuth flow to work, you **MUST** add the VS Code URI scheme to Supabase's allowed redirect URLs:

1. In Supabase dashboard, go to **Authentication** → **URL Configuration**
2. In the **Redirect URLs** section, add these URLs:

   **Desktop IDE schemes** (custom protocols):

   ```
   vscode://texra-ai.texra/auth-callback
   vscode-insiders://texra-ai.texra/auth-callback
   cursor://texra-ai.texra/auth-callback
   windsurf://texra-ai.texra/auth-callback
   ```

   **Web/Remote environments** (HTTPS - use wildcards):

   ```
   https://*.github.dev/**
   https://*.gitpod.io/**
   https://vscode.dev/**
   https://*.vscode.dev/**
   ```

3. Click "Save"

**Why this is needed**: When users authenticate via GitHub/Google, the OAuth flow redirects back to the IDE. The extension uses `vscode.env.asExternalUri()` which returns:

- Custom URI schemes for desktop (e.g., `cursor://...`)
- HTTPS URLs for web environments (e.g., `https://abc.github.dev/...`)

Without adding these URLs to the allowed list, Supabase will show an error "The redirect_uri is not associated with this application".

**Supported IDEs and their URI schemes**:

- **VS Code**: `vscode://`
- **VS Code Insiders**: `vscode-insiders://`
- **Cursor**: `cursor://`
- **Windsurf**: `windsurf://`
- **GitHub Codespaces**: `https://*.github.dev/`
- **Gitpod**: `https://*.gitpod.io/`
- **vscode.dev**: `https://vscode.dev/`

**Common mistakes**:

- ❌ Using `vscode://LionSR.texra/auth-callback` (wrong extension ID)
- ❌ Only adding `localhost:3000` (this is for web apps, not VS Code extensions)
- ❌ Forgetting to add all IDE variants (vscode, vscode-insiders, cursor, windsurf)
- ❌ Forgetting web environment wildcards (Codespaces, Gitpod, vscode.dev)

---

## Part 3: Set Up Database

### 1. Create Tables and Policies

Go to **SQL Editor** in Supabase dashboard and run this SQL:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles table (user metadata)
-- permissions: array of visibility values user can access (e.g., 'researcher', 'math', 'cs')
CREATE TABLE profiles (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  permissions TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Remote agents metadata table
-- visibility: array of group names that can access the agent (e.g., ARRAY['math', 'cs'])
-- agent_category: 'workflow' (multi-turn) or 'toolUse' (single-turn with tools)
-- tools: cached tool names from YAML for tool-use agents (e.g., ARRAY['web_search', 'arxiv_search'])
CREATE TABLE remote_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  storage_path TEXT NOT NULL,
  visibility TEXT[] DEFAULT ARRAY['public'],
  agent_category TEXT NOT NULL DEFAULT 'workflow' CHECK (agent_category IN ('workflow', 'toolUse')),
  tools TEXT[] DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Whitelist table (for specific user access)
CREATE TABLE agent_whitelist (
  agent_id UUID REFERENCES remote_agents ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE,
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (agent_id, user_id)
);

-- Usage logs table (for tracking API usage)
CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users,
  agent_name TEXT,
  model_provider TEXT,
  model_name TEXT,
  response_id TEXT,
  execution_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_usage_logs_user ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_response ON usage_logs(response_id);
CREATE INDEX idx_remote_agents_visibility ON remote_agents USING GIN(visibility);
CREATE INDEX idx_profiles_permissions ON profiles USING GIN(permissions);

-- Enable Row Level Security (RLS)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_whitelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Users can view their own profile
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can view agents based on visibility and permissions
-- Uses array overlap (&&) to check if any visibility matches any permission
CREATE POLICY "Users can view allowed agents"
  ON remote_agents FOR SELECT
  USING (
    'public' = ANY(visibility) OR
    visibility && (SELECT permissions FROM profiles WHERE user_id = auth.uid()) OR
    EXISTS (
      SELECT 1 FROM agent_whitelist
      WHERE agent_id = id AND user_id = auth.uid()
    )
  );

-- Users can view their own usage logs
CREATE POLICY "Users can view own usage logs"
  ON usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own usage logs
CREATE POLICY "Users can insert own usage logs"
  ON usage_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own whitelist entries
CREATE POLICY "Users can view own whitelist entries"
  ON agent_whitelist FOR SELECT
  USING (auth.uid() = user_id);

-- Auto-create profile when user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email)
  VALUES (new.id, new.email);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

### 2. Verify Tables

1. Go to **Table Editor** in Supabase
2. You should see: `profiles`, `remote_agents`, `agent_whitelist`, `usage_logs`

---

## Part 4: Set Up Storage

### 1. Create Storage Bucket

1. Go to **Storage** in Supabase dashboard
2. Click "Create a new bucket"
3. Settings:
   - **Name**: `agent-configs`
   - **Public bucket**: **OFF** (keep it private)
4. Click "Create bucket"

### 2. Configure Storage RLS Policies

> **Note:** This storage policy is defense-in-depth only. Primary access control is on the
> `remote_agents` table (using array overlap `&&`). The Edge Function verifies access via
> remote_agents RLS first, then uses an admin client to bypass storage RLS. Store agents
> in a folder matching their primary visibility level (e.g., `researcher/agent.yaml` for
> an agent with `visibility = ['researcher', 'math']`).

1. Click on the `agent-configs` bucket
2. Go to **Policies** tab
3. Click "New Policy"
4. Choose "Create a policy from scratch"
5. Paste this policy:

```sql
CREATE POLICY "Users can read allowed agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    -- Public agents (in public/ folder)
    (storage.foldername(name))[1] = 'public' OR
    -- Defense-in-depth: check if user has permission for folder
    -- Primary access control is on remote_agents table via Edge Function
    (SELECT permissions FROM profiles WHERE user_id = auth.uid()) @> ARRAY[(storage.foldername(name))[1]] OR
    -- Whitelisted agents
    EXISTS (
      SELECT 1 FROM agent_whitelist aw
      JOIN remote_agents ra ON aw.agent_id = ra.id
      WHERE aw.user_id = auth.uid()
        AND ra.storage_path = name
    )
  )
);
```

---

## Part 5: Create Edge Function

### 1. Install Supabase CLI

```bash
npm install -g supabase
```

### 2. Login and Link Project

```bash
supabase login
supabase link --project-ref your-project-id
```

### 3. The function source

The function lives in this repository at
`supabase/functions/get-agent-config/index.ts` (with its shared helpers under
`supabase/functions/_shared/`). Deploy it from a checkout rather than copying
it into a new function.

### 4. Deploy Edge Function

```bash
supabase functions deploy get-agent-config --no-verify-jwt
```

Deploy with `--no-verify-jwt`: the function verifies the user's JWT internally,
so the gateway check must stay off (it would otherwise reject the request before
the function runs). All TeXRA edge functions are deployed this way.

### 5. Get Edge Function URL

After deployment, your function will be available at:

```
https://your-project-id.supabase.co/functions/v1/get-agent-config
```

---

## Part 6: Client configuration

The project URL, publishable key, and edge function URL are compiled into the
clients from `src/auth/config.ts`. Users configure nothing; they just sign in.

---

## Part 7: Updating the hosted catalog

Keeping generated SQL in the repo drifts from the YAML. The catalog is only:

- `prompts/agents/remote/**/*.yaml` — prompt, tools, category
- `prompts/agents/remote/catalog.json` — storage folder and visibility

Preview the generated SQL (stdout only; nothing is written):

```bash
npm run sync:remote-agents
```

Apply it with:

```bash
npm run sync:remote-agents -- --apply
```

Needs a `supabase link`ed checkout, or `SUPABASE_DB_URL`, or `SUPABASE_ACCESS_TOKEN` plus `SUPABASE_PROJECT_REF`. With `SUPABASE_PROJECT_REF` the script passes that ref to the CLI through `SUPABASE_PROJECT_ID`, leaving the checkout's linked project untouched.

`--apply` requires Supabase CLI **v2.79.0 or newer**: v2.79.0 added `supabase db query`, whose `--linked` mode resolves the target project from `SUPABASE_PROJECT_ID` before the checkout's link file. Older CLIs lack `db query` entirely, so a too-old CLI fails loudly with an `unknown command` error before touching any project instead of silently retargeting the run. Check your local version with `supabase --version`; CI pins 2.106.0 (`.github/workflows/remote-agents-sync.yml`).

Before writing any metadata, `--apply` verifies that every catalog `storage_path` already exists as an object in the `agent-configs` bucket; if any are missing it aborts and lists them, and no metadata is published. The preflight checks object existence, not freshness, so a green preflight does not prove the uploaded bodies are current. YAML bodies are still uploaded separately from metadata, so upload new, moved, or changed agents **before** applying (or before merging to `main`):

```bash
# <source> is the YAML path under prompts/agents/remote/, including any
# subdirectory (for example "workflow/apply.yaml" or "tool_use/Lean4/lean.yaml").
# <folder> must match the agent's "folder" in prompts/agents/remote/catalog.json.
supabase storage cp "prompts/agents/remote/<source>" "ss:///agent-configs/<folder>/<agent>.yaml" --project-ref <PROJECT-REF>
```

The same apply command (including the storage check) runs on merge to `main` when those files change (`.github/workflows/remote-agents-sync.yml`). PRs run `npm run sync:remote-agents` (generate only) and do not write production.

---

## Part 8: User Management

### 1. Grant User Access to Visibility Groups

Users can see agents where `visibility` matches any value in their `permissions` array.

In **SQL Editor**:

```sql
-- View all users
SELECT user_id, email, permissions FROM profiles;

-- Grant user access to 'researcher' visibility agents
UPDATE profiles
SET permissions = array_append(permissions, 'researcher')
WHERE email = 'user@example.com';

-- Grant multiple visibility levels at once
UPDATE profiles
SET permissions = ARRAY['researcher', 'math', 'cs']
WHERE email = 'user@example.com';
```

### 2. Whitelist User for Specific Agent

```sql
-- Get agent ID
SELECT id, name FROM remote_agents;

-- Get user ID
SELECT user_id, email FROM profiles WHERE email = 'user@example.com';

-- Add to whitelist
INSERT INTO agent_whitelist (agent_id, user_id)
VALUES ('agent-uuid-here', 'user-uuid-here');
```

---

## End User Experience

For end users, the process is simple:

1. **No configuration needed** - the Supabase endpoints are compiled in
2. **Sign in**: Run `TeXRA: Sign In` command
3. **Authenticate** via browser (GitHub/Google)
4. **Use agents**: remote agents the account can access appear in the agent
   catalog; see the [Remote Agents guide](../guide/remote-agents.md)

---

## Troubleshooting

### "Supabase authentication provider registered" doesn't appear in logs

- Verify credentials in `src/auth/config.ts` are correct
- Check browser console in VS Code Developer Tools

### "Agent not found" Error

- Verify agent exists in `remote_agents` table
- Check that `storage_path` matches the actual file in storage
- Ensure the user's `permissions` overlap the agent's `visibility`, or the user is whitelisted

### Edge Function Not Working

- Check function logs in Supabase dashboard: **Edge Functions** → your function → **Logs**
- Verify `SUPABASE_SERVICE_ROLE_KEY` is set (it's automatic in deployed functions)
- Test function in Supabase dashboard using the "Invoke" button

---

## Security Best Practices

1. **Never commit real credentials to git** - Use environment variables for development
2. **Use Row Level Security (RLS)** - Always enable RLS on tables containing user data
3. **Rotate secrets regularly** - Periodically regenerate OAuth client secrets
4. **Monitor usage** - Check usage logs for suspicious activity
5. **Backup database** - Enable automatic backups in Supabase project settings

---

## Support

- **Supabase Docs**: https://supabase.com/docs
- **TeXRA GitHub**: https://github.com/LionSR/TeXRA
- **Issues**: https://github.com/LionSR/TeXRA/issues
