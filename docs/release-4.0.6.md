# Traces 4.0.6

A reopened run's behavior no longer counts the time the run was stopped as idle. A reopen can resume a root's first session ten days after the stop, and that session then spanned the whole stop: the root read as fourteen thousand minutes idle, with one stall as long, and an hourly call rate spread over ten days.

`traces behavior` on a run directory now reads the times the run was stopped from its generations, from each generation's end (its Runtime settle, else its stop) to the reopen that started the next, and reports them as `run.stopped[]` and a text line. A gap that spans such a time is cut there, and each part on either side is idle, and a stall, only when it is ten minutes or more. An act explains no time past the stop. A node's `hours` leave the time out and its new `stopped_min` holds it. A node left open at a stop ends there unless it acted after the reopen. A generation with no recorded end is named under `coverage.unknowns`.
