-- Migration: Flexible Permissions & Agent Categories
-- 1. Adds permissions array to profiles (visibility values user can access)
-- 2. Adds agent_category to remote_agents (workflow/toolUse)
-- 3. Removes agent_type, drops visibility CHECK constraint

-- ============================================================================
-- STEP 1: Add permissions column to profiles
-- ============================================================================
-- Permissions are just visibility values: 'researcher', 'math', 'cs', etc.
-- User can see agents where visibility = ANY(permissions)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS permissions TEXT[] DEFAULT '{}';

-- ============================================================================
-- STEP 2: Drop constraints for extensibility
-- ============================================================================
ALTER TABLE remote_agents DROP CONSTRAINT IF EXISTS remote_agents_visibility_check;
ALTER TABLE remote_agents DROP CONSTRAINT IF EXISTS remote_agents_agent_type_check;

-- ============================================================================
-- STEP 3: Add agent_category, drop agent_type
-- ============================================================================
ALTER TABLE remote_agents
ADD COLUMN IF NOT EXISTS agent_category TEXT DEFAULT 'workflow'
CHECK (agent_category IN ('workflow', 'toolUse'));

-- Migrate existing agent_type='toolUse' to agent_category='toolUse'
UPDATE remote_agents
SET agent_category = 'toolUse'
WHERE agent_type = 'toolUse';

-- Drop agent_type column (optional - can keep for backwards compat)
-- ALTER TABLE remote_agents DROP COLUMN IF EXISTS agent_type;

-- ============================================================================
-- STEP 4: Migrate existing tier='researcher' to permissions
-- ============================================================================
UPDATE profiles
SET permissions = ARRAY['researcher']
WHERE tier = 'researcher' AND (permissions IS NULL OR permissions = '{}');

-- ============================================================================
-- STEP 5: Create helper function for permission checks
-- ============================================================================
CREATE OR REPLACE FUNCTION user_has_visibility_access(required_visibility TEXT)
RETURNS BOOLEAN AS $$
  SELECT required_visibility = 'public' OR EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = auth.uid()
      AND required_visibility = ANY(permissions)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- STEP 6: Update remote_agents RLS policy
-- ============================================================================
DROP POLICY IF EXISTS "Users can view allowed agents" ON remote_agents;

CREATE POLICY "Users can view allowed agents"
  ON remote_agents FOR SELECT
  USING (
    visibility = 'public' OR
    visibility = ANY((SELECT permissions FROM profiles WHERE user_id = auth.uid())) OR
    EXISTS (
      SELECT 1 FROM agent_whitelist
      WHERE agent_id = id AND user_id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 7: Update storage RLS policy
-- ============================================================================
DROP POLICY IF EXISTS "Researcher access users can read agent configs" ON storage.objects;
DROP POLICY IF EXISTS "Users can read allowed agent configs" ON storage.objects;

CREATE POLICY "Users can read allowed agent configs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'agent-configs' AND
  (
    (storage.foldername(name))[1] = 'public' OR
    (storage.foldername(name))[1] = ANY((SELECT permissions FROM profiles WHERE user_id = auth.uid())) OR
    EXISTS (
      SELECT 1 FROM agent_whitelist aw
      JOIN remote_agents ra ON aw.agent_id = ra.id
      WHERE aw.user_id = auth.uid()
        AND ra.storage_path = name
    )
  )
);

-- ============================================================================
-- STEP 8: Verify
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

-- Add a new agent for mathematicians:
-- INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category)
-- VALUES ('proof-assistant', 'Helps with proofs', 'math/proof.yaml', 'math', 'workflow');
-- Then grant users: UPDATE profiles SET permissions = array_append(permissions, 'math') WHERE ...

-- Note: 'tier' column is reserved for future server-side API key access
