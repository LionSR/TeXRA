-- Remove description column from remote_agents table
-- Description is now read from YAML files (single source of truth)
ALTER TABLE remote_agents DROP COLUMN IF EXISTS description;
