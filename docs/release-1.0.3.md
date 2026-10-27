# 1.0.3

- Adopt the public Runtime 1.0, Eval 1.0 and Interface 5.10.1 cohort through their maintained packages; Interface 5.10.1 carries the Zod advisory fix.
- Resolve the Runtime Sandbox SDK peer to 1.0.24.
- Remove the unused direct Sandbox SDK dependency; Runtime declares the SDK peer it requires.
- Require Node 22.19 or newer, matching the Runtime dependency's minimum supported version.

This release uses the [local merge gate and existing tag publication path](develop.md).
