-- Migration: Add tools column to remote_agents table
-- Purpose: Store tool names for tool-use agents so orchestrator agents can see
-- what tools remote agents have without needing to fetch the full YAML config.
--
-- The column is a TEXT[] array of tool name strings (e.g. ARRAY['web_search', 'arxiv_search']).
-- NULL means no tools (workflow agents) or not yet populated.

ALTER TABLE remote_agents
ADD COLUMN IF NOT EXISTS tools TEXT[] DEFAULT NULL;

-- Update the comment on the table to reflect the new column
COMMENT ON COLUMN remote_agents.tools IS
  'Cached tool names from agent YAML. Populated when uploading agent configs. '
  'Allows orchestrator agents to see remote agent capabilities without fetching YAML.';
