CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, started_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL);
INSERT INTO sessions VALUES ('hermes-example', 'hermes-model', 10, 4, 0, 0, 1763642400);
INSERT INTO messages VALUES (1, 'hermes-example', 'user', 'Inspect the native store.', NULL, NULL, NULL, 1763642401);
INSERT INTO messages VALUES (2, 'hermes-example', 'assistant', 'Reading.', NULL, '[{"id":"call-1","name":"Read","arguments":{"file_path":"/work/README.md"}}]', NULL, 1763642402);
INSERT INTO messages VALUES (3, 'hermes-example', 'tool', 'README', 'call-1', NULL, NULL, 1763642403);
