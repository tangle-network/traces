# Traces 4.0.4

A Runtime run that was reopened and stopped again is read one generation at a time. The press starts the first generation and each reopen starts the next. `run_record.generations[]` holds each generation's start, its stop, its Runtime result (a reopen sets aside the result of the generation it ends, as `settles/<n>.json`), its checks and submissions, and the root stream's last event.

The text output gives each earlier generation one line, then prints the latest generation that stopped in full. In that generation, an agent's act or a stream event from before its reopen reads as "no act since the reopen", not as minutes of quiet.
