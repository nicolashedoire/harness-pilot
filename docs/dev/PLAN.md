# Product and engineering plan

This document describes the current direction of this repository. The [audit](../AUDIT.md) tracks verified changes, outstanding work, and known limitations.

## Product

Provide a self-hosted workspace for Claude Code and OpenAI Codex: persistent project conversations, optional automatic discussions between the agents, and tools to review their output, manage tasks, and retain useful context.

## Priorities

1. **Reliable agent collaboration:** separate agent credentials and models, visible exchanges, user intervention, pause and stop controls, limits, and reviewable summaries.
2. **Shared context:** clear project and topic memory that the user can inspect and explicitly update; make agent-specific behavior and limits visible.
3. **Honest operations:** distinguish the two agents in connection status and usage, avoid inventing subscription costs or quotas, and describe unsupported features accurately.
4. **Practical local operation:** a documented local setup, a scheduler that does not alter system crontab, and a clear account of what happens while the app is stopped.
5. **Documentation and accessibility:** align guides and UI with implemented behavior, review mobile layouts, translations and error states, and preserve applicable license notices.
6. **Distribution:** adapt and validate Linux installation and updates for this repository before enabling those paths. The inherited installer is currently disabled; the supported starting point is the local procedure in the [README](../../README.md).

## Delivery and validation

- Keep user data and credentials out of the repository and test fixtures.
- Test behavior with isolated data and exercise important flows in the application.
- Update the user guides and audit whenever behavior or support changes.
- Treat historical change notes as history, not current setup instructions.

## Licensing

The repository is distributed under the [MIT License](../../LICENSE), with the original rights holders' permission. Historical notices are retained in [LICENSE.original](../../LICENSE.original); third-party software retains its own license terms.
