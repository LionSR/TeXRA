-- Migration: Add apply and apply_multiple as remote agents
--
-- Prerequisites:
-- 1. Upload the YAML files to Supabase Storage:
--    - Copy from: prompts/agents/remote/apply.yaml
--    - Upload to: Storage > agent-configs > researcher/apply.yaml
--
--    - Copy from: prompts/agents/remote/apply_multiple.yaml
--    - Upload to: Storage > agent-configs > researcher/apply_multiple.yaml
--
-- Then run this SQL in Supabase SQL Editor:

-- Insert the apply agent metadata
INSERT INTO remote_agents (name, description, storage_path, visibility, agent_type)
VALUES (
  'apply',
  'Implements suggestions from review agents (criticize, enhance, logic, notation, etc.). Reads inline annotations, works through the issues, and applies corrections.',
  'researcher/apply.yaml',
  ARRAY['researcher'],
  'CoT'
);

-- Insert the apply_multiple agent metadata
INSERT INTO remote_agents (name, description, storage_path, visibility, agent_type)
VALUES (
  'apply_multiple',
  'Implements suggestions from review agents across multiple documents. Reads inline annotations, works through issues, and applies corrections while maintaining cross-document consistency.',
  'researcher/apply_multiple.yaml',
  ARRAY['researcher'],
  'CoT'
);

-- Verify the insertions
SELECT id, name, description, visibility, agent_type, storage_path
FROM remote_agents
WHERE name IN ('apply', 'apply_multiple');
