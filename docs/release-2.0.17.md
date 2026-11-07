# traces 2.0.17

Runtime run refs read complete, bound Codex captures through the existing Runtime capture APIs and native reader. Record facts use these native records instead of parentless Bridge request summaries, with capture refs and node/session/profile/request provenance retained. Append-only reentry copies count once; journal and Bridge usage are not added to native usage.

Capture provenance joins the journal prefix at the receipt, keeping concrete attempts, authored identity and effective materialization distinct. Missing or inconsistent evidence, incomplete or unknown coverage and unsupported fork/legacy task scopes refuse. Without available captures, the retained OTLP and journal fallback behavior remains; request-only evidence still cannot supply record facts.
