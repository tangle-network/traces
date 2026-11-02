# 2.0.3

- A Runtime run directory now folds into its tree: the journal reader takes Runtime's batched `events` rows, which hold each run's `spawned` events.

This release uses the [local merge gate and existing tag publication path](develop.md).
