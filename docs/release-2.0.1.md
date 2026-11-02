# 2.0.1

- Read the OpenInference keys a conforming OTLP producer writes: a message's text from `input.value` (`user.prompt`) or `output.value` (`message.*`) when it has no `content`, and a child session's parent from `tangle.harness_session.parent`. `@tangle-network/harness-sessions` and `@tangle-network/sdk-telemetry` write these keys, so their final messages, turns, `--match` and parent links were empty before.

This release uses the [local merge gate and existing tag publication path](develop.md).
