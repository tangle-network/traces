# Native tool-call excerpts

These excerpts preserve the native call and result envelopes from recordings. Factory and Grok each contributed one completed call. The Pi and both Kimi wire formats each contributed one call. The OpenCode SQLite input retains two tool parts associated with their recorded assistant messages. The test restores the SQL fixture to a temporary SQLite database. The database holds the three tables the session reader queries.

All identifiers, dates, paths, tool names, arguments and return content are fixture values. The original recordings stay with their owners. Pi, Kimi and OpenCode use the [Harness Sessions corpus](https://github.com/tangle-network/agent-sdk/tree/bd34889c0687e892ae18fd8039be4206d053fdc6/packages/harness-sessions/test/fixtures). The same behavior integration reads the existing Claude, Codex, Codex exec and Sandbox recordings.

Hermes, OpenClaw and Prime are small populated stores in their real native formats, with one recorded-form call each. NanoClaw is a metadata-only outbound message store and deliberately has no call. These four are format fixtures written for integration coverage, not live-agent recordings; the tests restore each SQL fixture to a temporary database and read it through the public SDK reader.
