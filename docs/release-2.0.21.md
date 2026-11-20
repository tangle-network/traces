traces installs beside agent-eval 2. Its agent-eval range is `^1.0.32 || ^2.0.0`, with agent-runtime `^10.0.10` and agent-interface `^5.10.28`. Runtime 10.0.10 is the first Runtime release whose agent-eval peer admits 2, so an install that pairs agent-eval 2 with Runtime 10.0.9 no longer resolves. This release is locked to and tested with agent-eval 2.0.1, agent-runtime 10.0.10 and agent-knowledge 23.0.7. Without `TRACES_PYTHON`, the analyst bridge runs `agent-eval-rpc[dspy]` at the installed agent-eval version, so with agent-eval 2.0.1 it runs `agent-eval-rpc` 2.0.1 from PyPI.

`traces check <path> --share-safe` reads a `.zst` file decompressed, by its inner extension, so a Discovery `events/<x>.ndjson.zst` file is checked line by line like its `.ndjson` original. The result is UNKNOWN, never clean, in two cases:

- a file that does not decompress;
- a multi-frame file read on a runtime whose zstd decompressor returns only the first frame (Node 22).

traces also reads Grok Build sessions through the shared harness-sessions reader. `traces facts` and `traces bundle` accept a Grok session by its id, its directory or any file in it, and read its `updates.jsonl`.
