-- Migration: Flexible User Groups
-- This script migrates from hardcoded tiers to a permission-based user groups system
-- Run in Supabase SQL Editor

-- ============================================================================
-- STEP 1: Create user_groups table
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,           -- Internal name: 'free', 'researcher', 'enterprise'
  display_name TEXT NOT NULL,          -- User-facing: 'Free Tier', 'Researcher Access'
  description TEXT,                    -- Optional description
  permissions TEXT[] DEFAULT '{}',     -- Array of permission strings
  priority INT DEFAULT 0,              -- Higher = more privileges (used for display/ordering)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- STEP 2: Create user_group_memberships table (many-to-many)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_group_memberships (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE,
  group_id UUID REFERENCES user_groups ON DELETE CASCADE,
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  granted_by UUID REFERENCES auth.users,  -- Optional: who granted the membership
  expires_at TIMESTAMP WITH TIME ZONE,    -- Optional: for time-limited access
  PRIMARY KEY (user_id, group_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_group_memberships_user ON user_group_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_user_group_memberships_group ON user_group_memberships(group_id);

-- ============================================================================
-- STEP 3: Create helper functions for permission checks
-- ============================================================================

-- Check if current user has a specific permission
CREATE OR REPLACE FUNCTION user_has_permission(required_permission TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_group_memberships ugm
    JOIN user_groups ug ON ugm.group_id = ug.id
    WHERE ugm.user_id = auth.uid()
      AND (ugm.expires_at IS NULL OR ugm.expires_at > NOW())
      AND required_permission = ANY(ug.permissions)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Check if current user is member of a specific group (by name)
CREATE OR REPLACE FUNCTION user_in_group(group_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_group_memberships ugm
    JOIN user_groups ug ON ugm.group_id = ug.id
    WHERE ugm.user_id = auth.uid()
      AND (ugm.expires_at IS NULL OR ugm.expires_at > NOW())
      AND ug.name = group_name
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Get all permissions for current user (flattened)
CREATE OR REPLACE FUNCTION get_user_permissions()
RETURNS TEXT[] AS $$
  SELECT COALESCE(
    array_agg(DISTINCT perm),
    '{}'::TEXT[]
  )
  FROM user_group_memberships ugm
  JOIN user_groups ug ON ugm.group_id = ug.id
  CROSS JOIN LATERAL unnest(ug.permissions) AS perm
  WHERE ugm.user_id = auth.uid()
    AND (ugm.expires_at IS NULL OR ugm.expires_at > NOW());
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Get highest priority group for current user (for backwards compatibility)
CREATE OR REPLACE FUNCTION get_user_primary_group()
RETURNS TEXT AS $$
  SELECT ug.name
  FROM user_group_memberships ugm
  JOIN user_groups ug ON ugm.group_id = ug.id
  WHERE ugm.user_id = auth.uid()
    AND (ugm.expires_at IS NULL OR ugm.expires_at > NOW())
  ORDER BY ug.priority DESC
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- STEP 4: Seed default user groups
-- ============================================================================
INSERT INTO user_groups (name, display_name, description, permissions, priority) VALUES
  ('free', 'Free', 'Default tier for all users', '{}', 0),
  ('researcher', 'Researcher Access', 'Access to premium remote agents',
   '{"access_remote_agents", "access_researcher_visibility"}', 10)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions,
  priority = EXCLUDED.priority;

-- ============================================================================
-- STEP 5: Migrate existing users from profiles.tier to group memberships
-- ============================================================================
INSERT INTO user_group_memberships (user_id, group_id)
SELECT p.user_id, ug.id
FROM profiles p
JOIN user_groups ug ON ug.name = p.tier
WHERE p.tier IS NOT NULL
ON CONFLICT (user_id, group_id) DO NOTHING;

-- Also add 'free' group membership for all users (everyone starts with free)
INSERT INTO user_group_memberships (user_id, group_id)
SELECT p.user_id, ug.id
FROM profiles p
CROSS JOIN user_groups ug
WHERE ug.name = 'free'
ON CONFLICT (user_id, group_id) DO NOTHING;

-- ============================================================================
-- STEP 6: Enable RLS on new tables
-- ============================================================================
ALTER TABLE user_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_group_memberships ENABLE ROW LEVEL SECURITY;

-- Everyone can view user groups (they're public metadata)
CREATE POLICY "Anyone can view user groups"
  ON user_groups FOR SELECT
  USING (true);

-- Users can view their own memberships
CREATE POLICY "Users can view own memberships"
  ON user_group_memberships FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================================
-- STEP 7: Update remote_agents RLS policy to use permissions
-- ============================================================================

-- Drop old policy
DROP POLICY IF EXISTS "Users can view allowed agents" ON remote_agents;

-- Create new permission-based policy
-- visibility values map to permissions: 'researcher' -> 'access_researcher_visibility'
CREATE POLICY "Users can view allowed agents"
  ON remote_agents FOR SELECT
  USING (
    visibility = 'public' OR
    user_has_permission('access_' || visibility || '_visibility') OR
    EXISTS (
      SELECT 1 FROM agent_whitelist
      WHERE agent_id = id AND user_id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 8: Update storage RLS policy
-- ============================================================================
DROP POLICY IF EXISTS "Researcher access users can read agent configs" ON storage.objects;

CREATE POLICY "Users can read allowed agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    -- Public agents (in public/ folder)
    (storage.foldername(name))[1] = 'public' OR
    -- Permission-based access (folder name maps to permission)
    user_has_permission('access_' || (storage.foldername(name))[1] || '_visibility') OR
    -- Whitelisted agents
    EXISTS (
      SELECT 1 FROM agent_whitelist aw
      JOIN remote_agents ra ON aw.agent_id = ra.id
      WHERE aw.user_id = auth.uid()
        AND ra.storage_path = name
    )
  )
);

-- ============================================================================
-- STEP 9: Update trigger to auto-add free group to new users
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  free_group_id UUID;
BEGIN
  -- Create profile
  INSERT INTO public.profiles (user_id, email)
  VALUES (new.id, new.email);

  -- Add to 'free' group
  SELECT id INTO free_group_id FROM user_groups WHERE name = 'free';
  IF free_group_id IS NOT NULL THEN
    INSERT INTO user_group_memberships (user_id, group_id)
    VALUES (new.id, free_group_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STEP 10: Verification queries
-- ============================================================================
-- Run these to verify the migration worked:

-- Check user groups exist
SELECT name, display_name, permissions, priority FROM user_groups ORDER BY priority;

-- Check memberships were migrated
SELECT
  p.email,
  p.tier as old_tier,
  array_agg(ug.name) as new_groups
FROM profiles p
LEFT JOIN user_group_memberships ugm ON p.user_id = ugm.user_id
LEFT JOIN user_groups ug ON ugm.group_id = ug.id
GROUP BY p.user_id, p.email, p.tier;

-- Test permission function
SELECT get_user_permissions();
SELECT get_user_primary_group();

-- ============================================================================
-- OPTIONAL: Remove tier column from profiles (run after verifying migration)
-- ============================================================================
-- WARNING: Only run this after confirming the migration worked!
-- ALTER TABLE profiles DROP COLUMN tier;
-- DROP CONSTRAINT IF EXISTS profiles_tier_check ON profiles;

-- ============================================================================
-- ADDING NEW GROUPS (Example)
-- ============================================================================
-- To add a new group, just INSERT:
-- INSERT INTO user_groups (name, display_name, permissions, priority) VALUES
--   ('enterprise', 'Enterprise', '{"access_remote_agents", "access_researcher_visibility", "access_enterprise_visibility", "priority_support"}', 20);
--
-- To grant a user access:
-- INSERT INTO user_group_memberships (user_id, group_id)
-- SELECT p.user_id, ug.id
-- FROM profiles p, user_groups ug
-- WHERE p.email = 'user@example.com' AND ug.name = 'enterprise';
