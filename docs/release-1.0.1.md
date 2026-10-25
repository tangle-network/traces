# traces 1.0.1

- CLI startup is back to 1.0.0's cost before the agent-eval 0.221.3 bump: agent-runtime and agent-interface now resolve to the same graph agent-eval loads, so one copy loads instead of two (#229).
- The release path builds before the tests that spawn the built CLI (#230, #231), and the prepare call has the permissions qualify-release's jobs need (#228).
