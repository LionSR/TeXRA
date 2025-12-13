-- Migration: Flexible Permissions & Agent Categories
-- 1. Adds permissions array to profiles (visibility values user can access)
-- 2. Changes visibility to array (agent can be visible to multiple groups)
-- 3. Adds agent_category to remote_agents (workflow/toolUse)
-- 4. Adds tier constraint (free/Max/Ultra) for future API key access

-- ============================================================================
-- STEP 1: Add permissions column to profiles
-- ============================================================================
-- Permissions are visibility values: 'researcher', 'math', 'cs', etc.
-- User can see agents where visibility && permissions (array overlap)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS permissions TEXT[] DEFAULT '{}';

-- ============================================================================
-- STEP 2: Migrate existing tier='researcher' to permissions FIRST
-- ============================================================================
-- Before changing tier constraint, migrate researcher users to have 'researcher' permission
UPDATE profiles
SET permissions = ARRAY['researcher']
WHERE tier = 'researcher' AND (permissions IS NULL OR permissions = '{}');

-- Now reset tier to 'free' for all researcher users (permission is what matters now)
UPDATE profiles
SET tier = 'free'
WHERE tier = 'researcher';

-- ============================================================================
-- STEP 3: Update tier constraint to support free/Max/Ultra
-- ============================================================================
-- Tier is for future server-side API key access levels
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tier_check;
ALTER TABLE profiles
ADD CONSTRAINT profiles_tier_check CHECK (tier IN ('free', 'Max', 'Ultra'));

-- ============================================================================
-- STEP 4: Drop old constraints for extensibility
-- ============================================================================
ALTER TABLE remote_agents DROP CONSTRAINT IF EXISTS remote_agents_visibility_check;
ALTER TABLE remote_agents DROP CONSTRAINT IF EXISTS remote_agents_agent_type_check;

-- ============================================================================
-- STEP 5: Convert visibility from TEXT to TEXT[] (array)
-- ============================================================================
-- This allows agents to be visible to multiple user groups
-- First, rename old column
ALTER TABLE remote_agents RENAME COLUMN visibility TO visibility_old;

-- Add new array column
ALTER TABLE remote_agents
ADD COLUMN visibility TEXT[] DEFAULT ARRAY['public'];

-- Migrate existing values (single value to array)
UPDATE remote_agents
SET visibility = ARRAY[visibility_old]
WHERE visibility_old IS NOT NULL;

-- Drop old column
ALTER TABLE remote_agents DROP COLUMN visibility_old;

-- ============================================================================
-- STEP 6: Add agent_category column
-- ============================================================================
ALTER TABLE remote_agents
ADD COLUMN IF NOT EXISTS agent_category TEXT DEFAULT 'workflow'
CHECK (agent_category IN ('workflow', 'toolUse'));

-- Migrate existing agent_type='toolUse' to agent_category='toolUse'
UPDATE remote_agents
SET agent_category = 'toolUse'
WHERE agent_type = 'toolUse';

-- ============================================================================
-- STEP 7: Create helper function for permission checks
-- ============================================================================
CREATE OR REPLACE FUNCTION user_has_visibility_access(required_visibility TEXT[])
RETURNS BOOLEAN AS $$
  SELECT 'public' = ANY(required_visibility) OR EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND required_visibility && permissions  -- array overlap
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- STEP 8: Update remote_agents RLS policy
-- ============================================================================
-- Drop ALL existing policies to ensure clean state
DROP POLICY IF EXISTS "Users can view allowed agents" ON remote_agents;
DROP POLICY IF EXISTS "Users can view public agents" ON remote_agents;
DROP POLICY IF EXISTS "Researchers can view researcher agents" ON remote_agents;

CREATE POLICY "Users can view allowed agents"
  ON remote_agents FOR SELECT
  USING (
    -- Public agents (visibility array contains 'public')
    'public' = ANY(visibility) OR
    -- Permission-based access (visibility overlaps with user's permissions)
    visibility && (SELECT permissions FROM profiles WHERE user_id = auth.uid()) OR
    -- Whitelist access
    EXISTS (
      SELECT 1 FROM agent_whitelist
      WHERE agent_id = id AND user_id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 9: Update storage RLS policy
-- ============================================================================
-- Drop ALL existing storage policies
DROP POLICY IF EXISTS "Researcher access users can read agent configs" ON storage.objects;
DROP POLICY IF EXISTS "Users can read allowed agent configs" ON storage.objects;
DROP POLICY IF EXISTS "Users can read public agent configs" ON storage.objects;

CREATE POLICY "Users can read allowed agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    -- Public folder
    (storage.foldername(name))[1] = 'public' OR
    -- Folder matches any of user's permissions
    (storage.foldername(name))[1] = ANY((SELECT permissions FROM profiles WHERE user_id = auth.uid())) OR
    -- Whitelist access
    EXISTS (
      SELECT 1 FROM agent_whitelist aw
      JOIN remote_agents ra ON aw.agent_id = ra.id
      WHERE aw.user_id = auth.uid()
        AND ra.storage_path = name
    )
  )
);

-- ============================================================================
-- STEP 10: Verify
-- ============================================================================
SELECT email, tier, permissions FROM profiles LIMIT 10;
SELECT name, visibility, agent_category FROM remote_agents LIMIT 10;

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================

-- Grant user access to 'researcher' visibility agents:
-- UPDATE profiles SET permissions = array_append(permissions, 'researcher')
-- WHERE email = 'user@example.com';

-- Grant access to multiple visibility levels:
-- UPDATE profiles SET permissions = ARRAY['researcher', 'math', 'cs']
-- WHERE email = 'user@example.com';

-- Add agent visible to BOTH math and cs groups:
-- INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category)
-- VALUES ('proof-assistant', 'Helps with proofs', 'math/proof.yaml', ARRAY['math', 'cs'], 'workflow');

-- Add agent visible to everyone (public):
-- INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category)
-- VALUES ('basic-assistant', 'Basic help', 'public/basic.yaml', ARRAY['public'], 'workflow');

-- Tier values (for future API key access):
-- 'free' - default, no API key access
-- 'Max' - mid-tier API key access
-- 'Ultra' - full API key access
-- UPDATE profiles SET tier = 'Max' WHERE email = 'user@example.com';
