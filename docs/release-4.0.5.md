# Traces 4.0.5

`facts` and `behavior` read a running Runtime run. A settle exports each agent's native session to the run's OTLP; before that, a run read by its id had only the journal's nodes and answered "no tool spans". Each agent with no exported session, and each execution a reopen started after the export, is now read from the run's retained live stream (`evidence/live-stream/`) through the shared `sandbox.events` reader and the projection an exported session takes, under the node's journal label, state, depth and parent session.

`coverage.unknowns` says what the live stream lacks: model calls and their tokens (the Runtime journal's usage is kept on the node), and the events the Sandbox dropped when its buffer overflowed, by agent, whose tool calls are then a lower bound. A running agent's record ends at the stream's last write.

Releases run npm admission before the tag. `pnpm check:release`, now part of the gate, packs a candidate whose version npm does not have and runs the Agent Runtime admission the Publish workflow pins; a refused candidate fails the gate and is never tagged. The v4.1.0 tag, left by a publish that admission refused, published nothing and was deleted; `docs/develop.md` says to delete such a tag and release the fix as the next version.
