# Salvage: runtime-session-lineage (worktree fix/runtime-session-lineage, last commit 2026-08-27)

Base commit: 38e02ae2edf35d5fd3985d4daa6e6aa7fe3dd070 (chore(release): v0.9.19). Head: 8579133ccfe4e79b55bf9077fa75570e10e805ce.
The real commits live in the local worktree /home/drew/code/.worktrees/traces-runtime-session-lineage
and could not be pushed as-is: they conflict with origin/main in 6 files (README, codex.ts,
conversation.ts, pi.ts, cli.ts, session-relationship.ts), and the pre-push hook refuses
non-mergeable pushes.

- lineage-work.mbox: the two commits, for `git am` onto 38e02ae2edf35d5fd3985d4daa6e6aa7fe3dd070.
- lineage-work.patch: the same change as one diff vs the base.
- files/: the full post-change files.

What it adds that main still lacks: src/runtime-session-lineage.ts (provider-session receipts,
controllerTurns exact-ordinal attribution, coverage gaps) and `--session-map <json>` as the
historical fallback for `--supervisor-run-dir`. main has its own `--supervisor-run-dir`
implementation (src/supervisor-run-context.ts) that this work predates.
