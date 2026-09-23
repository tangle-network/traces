# Checks

`run-checks.ts` is the deterministic measurement pass. It drops content-bearing
attributes, redacts structured secrets, turns spans into runs and scores them.

```bash
# from the repository root
./node_modules/.bin/tsx diagnosis-kit/checks/run-checks.ts customer/spans.otlp.jsonl
```

Add one check per symptom the customer named in intake section 2, so every complaint
they raised has a number attached to it in the report. A finding with no number is
still reportable; it just has to say it has no number rather than implying one.

For a repeat engagement, record runs to a scorecard and diff it. `diffScorecard` runs a
Welch t-test and returns `improved`, `regressed`, `flat` or `new`. That is what "no
regressions" has to mean for the claim to survive the customer checking it themselves.
