# Checks

The kit runs the public `traces` CLI; nothing here reads spans itself.

```bash
# On the customer's machine (npm install -g @tangle-network/traces):
traces convert raw.otlp.jsonl --no-content --out metadata-only.otlp.jsonl --format json
traces check metadata-only.otlp.jsonl --share-safe
# On the operator host, from this checkout after `pnpm build`, inside the engagement:
./node_modules/.bin/tsx diagnosis-kit/checks/prepare-bundle.ts "$ENGAGEMENT_DIR"
./node_modules/.bin/tsx diagnosis-kit/checks/run-checks.ts "$ENGAGEMENT_DIR/bundle/spans.flat.jsonl"
```

`prepare-bundle.ts` gates the received file with `traces check <file> --share-safe` and writes the bundle with
`traces convert <file> --no-content`, refusing a file that still carried content. `run-checks.ts` maps
`traces analyze <bundle> --format json` onto `templates/findings.schema.json`: capabilities, what the trace
cannot answer, and the measured findings with their span ids.

Add one check per symptom the customer named in intake section 2, so every complaint
they raised has a number attached to it in the report. A finding with no number is
still reportable; it just has to say it has no number rather than implying one.

For a repeat engagement, record runs to a scorecard and diff it. `diffScorecard` runs a
Welch t-test and returns `improved`, `regressed`, `flat` or `new`. That is what "no
regressions" has to mean for the claim to survive the customer checking it themselves.
