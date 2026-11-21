Traces 3 requires Agent Eval 2 for its public analyst types and its per-question budget accounting. Applications that use the standalone CLI can update normally. TypeScript applications that exchange Agent Eval values with Traces should upgrade that dependency to the range in the Traces package manifest. Applications pinned to Traces 2 can continue using that release.

Harness selection follows the native readers registered in Agent SDK. OpenClaw and NanoClaw resolve their own sessions. Hermes and Prime are available from the CLI and SDK. Existing Kimi and Factory names remain valid.

A copied SQLite store can be selected by its contents and an exact native session ID, including committed changes in its write-ahead log. An unrelated database under another harness's directory stays unclaimed. Ambiguous selections identify the sessions available to choose from.

The observer uses Agent Eval's per-question budget accounting. A shared study budget now preserves each individual question's limit. Unknown provider charges remain unknown.
