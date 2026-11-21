# Traces 4.0.2

When `traces ask` or a model-backed analyst uses Kimi Code, it requests text-only inference through the bridge. This applies to `kimi-code` and `kimi-code/<model>`. Use a bridge that honors `tool_choice: "none"` on this route. The analyst can still search the recorded sessions and open individual spans through its interpreter.

The default Python runner honors `UV_OFFLINE` and `UV_CACHE_DIR`. A disconnected device can run an analyst with a local model and a cached bridge. A missing offline bridge fails before the first model request.
