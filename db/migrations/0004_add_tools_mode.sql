-- Add per-client tool-use policy. Default REJECT preserves MVP behavior.
ALTER TABLE client_policies ADD COLUMN tools_mode TEXT NOT NULL DEFAULT 'REJECT' CHECK (tools_mode IN ('REJECT', 'ALLOW'));
