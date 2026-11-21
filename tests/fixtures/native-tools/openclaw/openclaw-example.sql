CREATE TABLE session_windows (session_id TEXT PRIMARY KEY);
CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY, session_id TEXT, event_json TEXT, event_zstd BLOB);
INSERT INTO session_windows VALUES ('openclaw-example');
INSERT INTO transcript_events VALUES (1, 'openclaw-example', '{"type":"message","id":"user-1","timestamp":"2026-11-20T10:00:00.000Z","message":{"role":"user","content":"Inspect the native store."}}', NULL);
INSERT INTO transcript_events VALUES (2, 'openclaw-example', '{"type":"message","id":"assistant-1","timestamp":"2026-11-20T10:00:01.000Z","message":{"role":"assistant","provider":"openclaw","model":"openclaw-model","usage":{"input":10,"output":4},"content":[{"type":"text","text":"Reading."},{"type":"toolCall","id":"call-1","name":"Read","arguments":{"file_path":"/work/README.md"}}]}}', NULL);
INSERT INTO transcript_events VALUES (3, 'openclaw-example', '{"type":"message","id":"tool-1","timestamp":"2026-11-20T10:00:02.000Z","message":{"role":"toolResult","toolCallId":"call-1","content":"README"}}', NULL);
