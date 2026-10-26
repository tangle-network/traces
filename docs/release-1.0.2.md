# 1.0.2

- Use the current compatible Runtime, Eval, Interface and Sandbox dependencies so an application can install Traces alongside the maintained Runtime cohort without pulling in an older Runtime with incompatible Sandbox peers.
- Refresh the shared harness reader and trace contract through their maintained packages. Traces keeps its CLI and SDK integration surface; it does not copy those implementations.

This release is qualified through the local merge gate and the existing tag publication path described in [Develop and release](develop.md).
