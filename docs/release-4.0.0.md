The SDK now types `SessionFactsReport.measurementVersion` as a string. In 3.x the declaration exposed a single literal. Compare the value for equality when reusing a cached report. This release changes it so corrected fork measurements are recomputed.

Renaming or moving a marked Prime recording preserves its native session ID. The CLI recognizes Prime from the recording, including when reading a directory or creating a portable bundle. An explicit Pi selection on that recording reports the mismatch. Older recordings that share Pi’s unmarked header keep their existing store and filename conventions.

A Prime user fork retains its parent and its copied conversation. The execution tree and behavior report attribute each recorded action to the session that performed it. You can inspect the prompt and tool result the fork inherited and see where its own work began.

SDK consumers can call `priceReport` to apply the same list-price lookup as `traces facts`.
