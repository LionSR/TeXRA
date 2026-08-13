-- Migration: Add transcribe_audio as a remote agent
--
-- Prerequisites:
-- 1. Upload the transcribe_audio.yaml file to Supabase Storage:
--    - Copy from: resources/agents/transcribe_audio.yaml
--    - Upload to: Storage > agent-configs > researcher/transcribe_audio.yaml
--
-- Then run this SQL in Supabase SQL Editor:

-- Insert the transcribe_audio agent metadata
INSERT INTO remote_agents (name, description, storage_path, visibility, agent_type)
VALUES (
  'transcribe_audio',
  'Transcribes audio with speaker identification and LaTeX math formatting',
  'researcher/transcribe_audio.yaml',
  'researcher',
  'CoT'
);

-- Verify the insertion
SELECT id, name, description, visibility, agent_type, storage_path
FROM remote_agents
WHERE name = 'transcribe_audio';
