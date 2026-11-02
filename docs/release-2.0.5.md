# traces 2.0.5

- A tree of retained session files counts each session once: an earlier byte-prefix copy under the same file name is dropped, so `traces facts|analyze|ask <dir>` reads a run whose sessions were kept per attempt.
