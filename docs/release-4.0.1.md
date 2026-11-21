An interrupted `traces ask` question now reports how many model completions and trace reads its installed analyst measured before the failure. The saved answer keeps the original error. Counts stay unknown when an analysis engine did not measure them.

When you select an OpenCode model, the analyst requests a text-only completion. Its interpreter still reads the selected trace. This keeps the model answering the question from opening a shell or editing the working directory on a bridge that supports the request.
