# Fork parity

Every hand-written session parser that traces retires gets a row in `forks.json`: its owner
repo and path, the old command, the traces command that replaces it, the field map, the
tolerance, and the consumer step whose PR deletes it. `score.ts` runs both sides over the same
sessions on a host and compares them field by field. A consumer PR deletes a fork only when it
cites that fork's row at or above its tolerance.

```sh
pnpm build
pnpm bench:parity --home <store home> --dotfiles <dotfiles checkout> --tangle-tools <tangle-tools checkout> \
  --since 2026-10-08 --until 2026-10-15 --out <dir> [--spool <collector traces-*.jsonl>…] [--files 8] [--forks id,id]
```

- `--home` is the store home both sides read: each old parser runs with `HOME` set to it, and
  traces reads it the same way. Stage the window's session files there (APFS clones or hard
  links) to bound what both sides read.
- A `window` fork runs once over `--since`/`--until`. A `file` fork runs on up to `--files`
  session files per harness under `--home` (1 KB to 40 MB, modified in the window, in path
  order). A `spool` fork reads the `--spool` collector files.
- Agreement: for the keys (turns, files) the share found by both sides, and for each mapped
  field the share of shared keys whose values are equal. A row's agreement is the lowest of
  these; it passes at or above its tolerance.
- Output: `scorecard.md` (also printed) and `scorecard.json` under `--out`, with each fork's
  first 5 disagreements by id: session ids, times, file names and numbers, never session text.
  Raw outputs of both sides stay under `--out/raw`; nothing is written outside `--out`.

`tests/bench-parity.test.ts` runs the scorer on a synthetic fork with one agreeing and one
disagreeing field.
