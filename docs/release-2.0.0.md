# 2.0.0

- Require the Runtime 3 public type line, starting at 3.0.5, and its Interface floor 5.10.5. This is the named dependency break; the Traces CLI and SDK exports remain unchanged.
- Use compatible caret ranges for the existing first-party dependencies so consumers can deduplicate the maintained cohort without overrides.
- Select the Python bridge version from the installed Eval package, keeping its protocol paired when a compatible Eval patch is selected.

This release uses the [local merge gate and existing tag publication path](develop.md).
