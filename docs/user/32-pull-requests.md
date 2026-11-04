---
section: Agents
---
# Reviewed pull request integration

Open **Settings → Pull requests** to coordinate code proposals from different companions, projects and channels. The queue is installation-wide and starts paused. It uses the GitHub CLI (`gh`) account authenticated on the server; no token is entered into the page.

## Review and order work

1. Add a canonical `https://github.com/owner/repository/pull/42` URL. Choose a merge commit or squash merge.
2. Select prerequisite entries that must merge first. A prerequisite can belong to another repository. Dependencies refer only to older entries, preventing cycles. To change dependencies, remove the entry and add it again.
3. Choose **Review changes**. The page fetches the current commit and full available diff, with file headers, additions, removals and line numbers. Pull requests whose diff GitHub refuses (including more than 300 changed files) and responses over 2 MiB are refused rather than silently truncated; inspect larger changes on GitHub.
4. Review prerequisites first, then approve the specific commit. Approval binds the head SHA, target branch and commit, diff, method and prerequisite heads. A changed head, target commit or prerequisite invalidates it and creates a notification. These notifications use the normal notification preferences, including sound.
5. Activate the queue when ready. Approval authorizes this exact integration while the queue is active. Adding a URL or refreshing status does not authorize a merge.

A companion's published pull request has an **Add to queue** link. This only pre-fills the URL; it does not enqueue, approve or merge anything.

## Before each merge

The worker requires merged prerequisites, an open non-draft pull request, a conflict-free branch containing the current target commit, at least one successful CI check or status, no pending or failing checks, and no active change request from a repository reviewer. Excess check or review pages block integration rather than guessing. Configure CI on repositories that do not publish checks.

GitHub also enforces repository rules. Protect the target branch with required checks and reviews for server-side enforcement if the branch changes during a request. Local checks are a preflight, not an atomic lock of the remote target branch. The merge API pins the approved **head SHA**. The queue does not request an administrator bypass, force-push, rebase, update branches, resolve conflicts or delete branches.

After a prerequisite changes `main`, normally merge `main` into dependent branches, rerun checks and review their new heads. This deliberately requires another approval. The queue is not GitHub's native merge queue and does not create merge groups.

## Pause, errors and recovery

**Pause integration** prevents new merge requests. A request already sent to GitHub cannot be recalled. **Refresh status** only reads up to three oldest pending entries; automatic checks rotate through entries while the server is running. Closing the page does not stop an active queue.

After an uncertain request or process interruption, the worker checks GitHub for a completed merge. It never automatically resends an ambiguous in-flight merge. Check the pull request on GitHub. An explicitly failed request can be retried by the owner; changed heads still require another review. Removed entries cannot merge through the queue.

Moving or restoring its state into a different directory pauses the queue and clears pending approvals. Review the current commits again on the recovered installation.

The queue stores at most 100 entries, with up to 20 prerequisites each, in private local state. It supports GitHub.com only. GitHub Enterprise, branch updating, archiving the history and automatic CI configuration are not implemented. GitHub availability and permissions may block a refresh.

## Verification

Isolated tests simulate successful integrations, dependency ordering, failing and pending checks, absent CI, requested changes, stale approvals, cancellation and pause races, a remote head race, worker restart and a crash after GitHub accepts a merge. No real pull request is merged during those tests. A live preview can load actual metadata and diffs while remaining paused and unapproved.
