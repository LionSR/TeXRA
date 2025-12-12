-- Migration: Flexible Permissions (Simplified)
-- Adds permissions array directly to profiles table
-- No new tables needed - just one column addition

-- ============================================================================
-- STEP 1: Add permissions column to profiles
-- ============================================================================
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS permissions TEXT[] DEFAULT '{}';

-- ============================================================================
-- STEP 2: Migrate existing tiers to permissions
-- ============================================================================
UPDATE profiles
SET permissions = ARRAY['access_remote_agents', 'access_researcher_visibility']
WHERE tier = 'researcher' AND (permissions IS NULL OR permissions = '{}');

-- ============================================================================
-- STEP 3: Create helper function for permission checks
-- ============================================================================
CREATE OR REPLACE FUNCTION user_has_permission(required_permission TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND required_permission = ANY(permissions)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- STEP 4: Update remote_agents RLS policy
-- ============================================================================
DROP POLICY IF EXISTS "Users can view allowed agents" ON remote_agents;

-- Dynamic permission check: visibility -> 'access_{visibility}_visibility'
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
-- STEP 5: Update storage RLS policy
-- ============================================================================
DROP POLICY IF EXISTS "Researcher access users can read agent configs" ON storage.objects;
DROP POLICY IF EXISTS "Users can read allowed agent configs" ON storage.objects;

CREATE POLICY "Users can read allowed agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    (storage.foldername(name))[1] = 'public' OR
    user_has_permission('access_' || (storage.foldername(name))[1] || '_visibility') OR
    EXISTS (
      SELECT 1 FROM agent_whitelist aw
      JOIN remote_agents ra ON aw.agent_id = ra.id
      WHERE aw.user_id = auth.uid()
        AND ra.storage_path = name
    )
  )
);

-- ============================================================================
-- STEP 6: Verify
-- ============================================================================
SELECT email, tier, permissions FROM profiles LIMIT 10;

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================

-- Grant a user access to remote agents:
-- UPDATE profiles SET permissions = array_append(permissions, 'access_remote_agents')
-- WHERE email = 'user@example.com';

-- Grant multiple permissions:
-- UPDATE profiles SET permissions = permissions || ARRAY['access_remote_agents', 'access_researcher_visibility']
-- WHERE email = 'user@example.com';

-- Revoke a permission:
-- UPDATE profiles SET permissions = array_remove(permissions, 'access_remote_agents')
-- WHERE email = 'user@example.com';

-- Add a new visibility level (e.g., 'enterprise'):
-- 1. Set agent visibility: UPDATE remote_agents SET visibility = 'enterprise' WHERE name = 'my-agent';
-- 2. Grant permission: UPDATE profiles SET permissions = array_append(permissions, 'access_enterprise_visibility')
--    WHERE email = 'user@example.com';
-- No code changes needed!
