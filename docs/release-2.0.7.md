# 2.0.7

- `traces analyze` answers what caused what: `measures.causality` rows each `steered_by` link from the steer to the round it caused (with the lag and whether that round improved on the one before), counts every link kind (`spawned_by` included) resolved or not, and folds `agent.loop.iteration` rounds per loop round to round. The text prints a steering, a rounds and a links line; `report.md` gets a steering table.
- A kept tree reads a Claude subagent transcript with its parent session, never as a session of its own; one with no turns no longer refuses the tree.
- Smaller: one owner each for `errorText`, `oneLine`, `stringAttr` and `isObject`; the unused execution summary, prepared-context helper, conformance section renderer and Pi workflow file reader are gone.

This release uses the [local merge gate and existing tag publication path](develop.md).
