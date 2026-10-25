# traces 1.1.0

- `traces graphs` ingests native sessions, recorded workflow spans and Runtime run directories into Runtime’s existing graph registry. It queries task type and topology with delivery evidence and explicit unknowns, using the declared Runtime dependency by default. Observed graphs cannot become replay candidates.
- The public readers expose exclusive facts for recorded child boundaries without double-counting tokens. The shared harness reader includes Kimi child wires; native parent identity alone does not establish a cross-trace containment edge.
- Graph caching distinguishes discovered parent-inclusive workflows from explicitly named child scopes. Recursive OTLP discovery skips confirmed ordinary and bare Git metadata while retaining nested exports, explicit file reads and retained-OTLP precedence over Runtime journals.
- Node must satisfy the package’s engine range, which now follows the Runtime dependency’s requirement.
