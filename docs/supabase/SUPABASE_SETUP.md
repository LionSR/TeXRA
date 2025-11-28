# Supabase Setup Guide for TeXRA Remote Agents

This guide walks you through setting up Supabase for TeXRA's authentication and remote agents feature.

## Overview

TeXRA uses Supabase for:

- **User Authentication** - OAuth login (GitHub, Google, GitLab)
- **Remote Agents** - Secure storage and access control for agent configurations
- **Permissions** - Tier-based access (free vs researcher access program)

**Important**: Users authenticate to **TeXRA's official Supabase service**, not their own. This guide is for **extension maintainers** who need to set up the TeXRA backend.

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
   - **Publishable key** (recommended): Starts with `sb_publishable_...`
   - **OR anon key** (legacy): JWT starting with `eyJ...`

**These will be hardcoded in the extension (see Part 6).**

---

## Understanding API Keys

Supabase provides two types of public keys for client-side applications:

### Publishable Key (Recommended)

- **Format**: `sb_publishable_...`
- **Advantages**:
  - Easy rotation without downtime
  - Shorter, simpler format
  - Independent of JWT secret
  - Browser-use detection for secret keys
- **Use**: New projects should use publishable keys

### Anon Key (Legacy)

- **Format**: JWT starting with `eyJ...`
- **Disadvantages**:
  - Rotating requires JWT secret rotation (causes downtime)
  - 10-year expiry embedded in token
  - Large, complex format
- **Use**: Still works, but consider migrating to publishable keys

### Both Keys Are Safe for Client Code

Both the publishable and anon keys are designed to be embedded in client-side code. They do **not** protect your data directly. Instead, Row Level Security (RLS) policies on your database tables control actual data access.

**Important**:
- Never expose `service_role` or secret keys (`sb_secret_...`) in client code
- These elevated keys bypass RLS and should only be used in server-side code (Edge Functions)

### Migrating from Anon to Publishable Key

1. Go to **Settings** → **API Keys** in Supabase dashboard
2. Create a new publishable key
3. Replace the `publicKey` value in `src/auth/config.ts` with your publishable key
4. Build and test the extension
5. (Optional) Deactivate the old anon key once migration is complete

The Supabase client initialization code remains identical - just swap the key value.

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
   ```
   vscode://texra-ai.texra/auth-callback
   vscode-insiders://texra-ai.texra/auth-callback
   ```
3. Click "Save"

**Why this is needed**: When users authenticate via GitHub/Google, the OAuth flow redirects back to VS Code using the `vscode://` URI scheme. Without adding these URLs to the allowed list, Supabase will redirect to `localhost:3000` which won't work in the VS Code extension.

**Common mistakes**:

- ❌ Using `vscode://LionSR.texra/auth-callback` (wrong extension ID)
- ❌ Only adding `localhost:3000` (this is for web apps, not VS Code extensions)
- ❌ Forgetting to add both `vscode://` and `vscode-insiders://` variants

---

## Part 3: Set Up Database

### 1. Create Tables and Policies

Go to **SQL Editor** in Supabase dashboard and run this SQL:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles table (user metadata)
CREATE TABLE profiles (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'researcher')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Remote agents metadata table
CREATE TABLE remote_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  storage_path TEXT NOT NULL,
  visibility TEXT DEFAULT 'researcher' CHECK (visibility IN ('public', 'researcher', 'whitelist')),
  tags TEXT[],
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
CREATE INDEX idx_remote_agents_visibility ON remote_agents(visibility);

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

-- Users can view agents based on visibility and tier
CREATE POLICY "Users can view allowed agents"
  ON remote_agents FOR SELECT
  USING (
    visibility = 'public' OR
    (visibility = 'researcher' AND EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid() AND tier = 'researcher'
    )) OR
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

1. Click on the `agent-configs` bucket
2. Go to **Policies** tab
3. Click "New Policy"
4. Choose "Create a policy from scratch"
5. Paste this policy:

```sql
CREATE POLICY "Researcher access users can read agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    -- Public agents (in public/ folder)
    (storage.foldername(name))[1] = 'public' OR
    -- Researcher access agents (requires researcher tier)
    (
      (storage.foldername(name))[1] = 'researcher' AND
      EXISTS (
        SELECT 1 FROM profiles
        WHERE user_id = auth.uid() AND tier = 'researcher'
      )
    ) OR
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

### 3. Create Edge Function

```bash
supabase functions new get-agent-config
```

### 4. Edit the Function

Edit `supabase/functions/get-agent-config/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    // Verify user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get agent name from request
    const { agentName } = await req.json();
    if (!agentName) {
      return new Response(JSON.stringify({ error: 'agentName required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch agent metadata (RLS enforces access control)
    const { data: agent, error: agentError } = await supabase
      .from('remote_agents')
      .select('id, name, description, storage_path')
      .eq('name', agentName)
      .single();

    if (agentError || !agent) {
      return new Response(
        JSON.stringify({
          error: 'Agent not found or access denied',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Fetch YAML from storage (RLS policy enforces access)
    const { data: fileData, error: storageError } = await supabase.storage
      .from('agent-configs')
      .download(agent.storage_path);

    if (storageError || !fileData) {
      console.error('Storage error:', storageError);
      return new Response(
        JSON.stringify({
          error: 'Failed to load agent configuration',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Read file content (in memory only, never persisted)
    const yamlContent = await fileData.text();

    return new Response(
      JSON.stringify({
        config: yamlContent,
        name: agent.name,
        description: agent.description,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
```

### 5. Deploy Edge Function

```bash
supabase functions deploy get-agent-config
```

### 6. Get Edge Function URL

After deployment, your function will be available at:

```
https://your-project-id.supabase.co/functions/v1/get-agent-config
```

---

## Part 6: Configure Extension Source Code

**This is for extension maintainers/developers**, not end users.

### 1. Update Hardcoded Credentials

Edit `src/auth/config.ts`:

```typescript
export const SUPABASE_CONFIG: SupabaseConfig = {
  url: 'https://your-actual-project-id.supabase.co', // Replace with your project URL
  publicKey: 'sb_publishable_...', // Replace with your publishable key (or anon JWT)
  edgeFunctionUrl:
    'https://your-actual-project-id.supabase.co/functions/v1/get-agent-config',
};
```

### 2. Build Extension

```bash
npm run build
```

The extension will now use the configured credentials. Users don't need to configure anything - they just sign in!

---

## Part 7: Add Remote Agents

### 1. Upload Agent YAML to Storage

1. Create your agent YAML file locally (e.g., `advanced-researcher.yaml`)
2. In Supabase dashboard, go to **Storage** → `agent-configs`
3. Create folder structure:
   - `public/` - for free agents
   - `researcher/` - for researcher access program agents
   - `whitelist/` - for whitelisted agents
4. Upload your YAML file to the appropriate folder (e.g., `researcher/advanced-researcher.yaml`)

### 2. Add Agent Metadata to Database

In **SQL Editor**, run:

```sql
INSERT INTO remote_agents (name, description, storage_path, visibility, tags)
VALUES (
  'advanced-researcher',
  'AI-powered research assistant for academic papers',
  'researcher/advanced-researcher.yaml',
  'researcher',
  ARRAY['research', 'academic', 'writing']
);
```

---

## Part 8: User Management

### 1. Grant User Researcher Access

In **SQL Editor**:

```sql
-- Get user's ID first
SELECT user_id, email FROM profiles;

-- Grant specific user researcher access
UPDATE profiles
SET tier = 'researcher'
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

1. **No configuration needed** - credentials are hardcoded in the extension
2. **Sign in**: Run `TeXRA: Sign In` command
3. **Authenticate** via browser (GitHub/Google)
4. **View profile**: Run `TeXRA: View Profile` to browse remote agents
5. **Use agents**: Click **Use** on any agent in the Remote Agents table

That's it! No Supabase URLs, API keys, or other configuration.

---

## Troubleshooting

### "Supabase authentication provider registered" doesn't appear in logs

- Check that `texra.auth.enabled` is true in settings
- Verify credentials in `src/auth/config.ts` are correct
- Check browser console in VS Code Developer Tools

### "Agent not found" Error

- Verify agent exists in `remote_agents` table
- Check that `storage_path` matches the actual file in storage
- Ensure user has correct tier or is whitelisted

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

## Next Steps

- [ ] Set up automated backups in Supabase
- [ ] Configure additional OAuth providers (Google, GitLab)
- [ ] Create admin dashboard for managing users and agents
- [ ] Implement usage quotas and rate limiting
- [ ] Add email notifications for important events

---

## Support

- **Supabase Docs**: https://supabase.com/docs
- **TeXRA GitHub**: https://github.com/LionSR/TeXRA
- **Issues**: https://github.com/LionSR/TeXRA/issues
