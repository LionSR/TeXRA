-- Migration: Rename 'premium' tier to 'researcher'
-- This script updates the database schema and data to replace 'premium' with 'researcher'

-- Step 1: Update existing data in profiles table
UPDATE profiles
SET tier = 'researcher'
WHERE tier = 'premium';

-- Step 2: Update existing data in remote_agents table
UPDATE remote_agents
SET visibility = 'researcher'
WHERE visibility = 'premium';

-- Step 3: Drop old constraints
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tier_check;
ALTER TABLE remote_agents DROP CONSTRAINT IF EXISTS remote_agents_visibility_check;

-- Step 4: Add new constraints with updated values
ALTER TABLE profiles
ADD CONSTRAINT profiles_tier_check
CHECK (tier IN ('free', 'researcher'));

ALTER TABLE remote_agents
ADD CONSTRAINT remote_agents_visibility_check
CHECK (visibility IN ('public', 'researcher', 'whitelist'));

-- Step 5: Update storage RLS policy (run in Supabase SQL Editor)
-- You'll need to manually update the storage policy or recreate it:
DROP POLICY IF EXISTS "Premium users can read agent configs" ON storage.objects;
DROP POLICY IF EXISTS "Researcher access users can read agent configs" ON storage.objects;

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

-- Step 6: Rename storage folder (MANUAL STEP)
-- In Supabase Storage UI:
-- 1. Go to Storage > agent-configs
-- 2. Download all files from premium/ folder
-- 3. Create researcher/ folder if it doesn't exist
-- 4. Upload files to researcher/ folder
-- 5. Update remote_agents table storage paths:

UPDATE remote_agents
SET storage_path = REPLACE(storage_path, 'premium/', 'researcher/')
WHERE storage_path LIKE 'premium/%';

-- Step 7: Verify the migration
SELECT tier, COUNT(*) as count FROM profiles GROUP BY tier;
SELECT visibility, COUNT(*) as count FROM remote_agents GROUP BY visibility;
SELECT storage_path FROM remote_agents WHERE storage_path LIKE '%researcher%' OR storage_path LIKE '%premium%';
