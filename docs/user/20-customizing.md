---
section: Extending
---
# Customizing the workspace

You can tailor project instructions, topic memory, scheduled jobs and workspace extensions to your needs. The [memory guide](memory) explains how Claude and Codex receive shared context. Extensions are stored in the workspace; see [Dashboard widgets](dashboard-widgets) and [Page extensions](page-extensions).

The application itself can also be changed in the repository. The web interface is built from `web/src`; run `npm run typecheck` and `npm run build` from `web` after changing it. Restart the local server when server code changes. Keep a backup and review changes before applying them.

## Updates and customizations

The legacy server's customization replay, smart updates and rollback flow have not been validated for this repository. Automatic updates are disabled in the local setup. Do not assume an update will preserve or replay changes automatically; review the Git changes and back up the workspace first. See [Local installation](installation) and the [audit](../AUDIT.md) for the supported path and current limitations.
