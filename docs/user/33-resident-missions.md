---
section: Agents
---
# Resident missions

Open **Settings → Resident missions** to give persistent companions bounded work on the platform. A mission keeps its plan, assignments, sessions, decisions and limits on disk. Its source experiments use disposable clones of the application's **committed source**, not the user's live working files.

## Plan, review, execute

1. Create a draft with a goal and conversation topic. Choose a maximum number of runs and working minutes. Creating a draft does not call a model.
2. Either write the steps yourself or ask the architect for a read-only plan. Planning consumes one run and uses the architect role's configured engine. The architect uses the internal source map; the user sees assignments and results, not that map.
3. Review the proposed assignments. Each step chooses an existing persistent role and may wait for earlier steps. Edit instructions, test expectations and dependencies. You can create or adapt roles in **Settings → Companions** and return to the plan.
4. **Save the plan** preserves a draft. **Validate the plan and start** saves the current visible edits and authorizes that exact plan, its limits, and the instructions and engine of every role it uses (shown under each step). A stale plan from another tab is refused. If one of those roles is edited later in **Settings → Companions**, the approval no longer applies: an active mission pauses, stops its running agents and waits until you review and start it again. Up to two resident agents run across the installation, with a maximum of one or two per mission.
5. Follow a step's conversation, inspect its tests and open its code proposal. The normal companion review requires your approval or rejection of the current diff. A pending or rejected proposal never silently becomes accepted.

A generated plan is advisory. Invalid JSON, unknown roles, duplicate step IDs and future or cyclic dependencies are refused. No role, plugin, dependency update, pull request or merge is installed or published merely by accepting a plan.

The planner uses native read-only/plan permissions. Code experiments use the existing companion permissions in disposable copies. These are cooperating agent processes, **not a complete operating-system sandbox**; trusted providers and local access rules still matter. Mission instructions prohibit publishing, credential changes and work outside the clone. The provider needs an active account. Model calls use its normal allowance.

## Dependencies and results

Independent assignments can run concurrently. A dependent step waits until prerequisites finish without changes, have an approved current proposal, or are explicitly skipped by the owner. It receives short predecessor reports as advisory context. Predecessor patches are **not applied to its clone**. If another patch must be integrated first, the companion should report that requirement rather than assume that code exists.

Approval here accepts a proposal for review/publishing; it does not apply code to the running app. Publishing still uses the companion's explicit PR action, and integration follows the PR review/queue flow. Runtime tests reported by an agent remain evidence to inspect in its conversation; a completed mission is not a certification that all proposed code is correct or merged.

## Recurring observation

Set a non-zero interval and a finite maximum cycle count to repeat the reviewed assignments, for example a security and architecture watch. These are checks while the server runs, not unbounded background model activity. The run, time and token budgets still apply. The time limit counts working time only (planning included): waiting between cycles is free, so an interval longer than the time limit still reaches the next cycle. The mission page shows the date of the next cycle.

A proposal awaiting a decision holds that cycle. If a cycle produced an approved patch, recurrence waits for the source commit to change before proposing it again. While the source is unchanged the mission keeps waiting without using working time (stop it if you no longer need it); approval alone does not deploy the patch. Terminal completed, stopped and budget states retain their reason when an invalid repeated stop is refused.

A security role can inspect available local evidence, prepare changes and tests, and report missing advisory/network access; a role definition alone does not provision an advisory service or prove that packages are up to date.

## Limits, interruptions and recovery

The run count is a hard limit on new automatic launches. Working time counts while an agent of the mission is being prepared (clone) or works, planning included. Waiting between cycles, waiting for your decision on a proposal and pauses do not count. Deadline checks run approximately every two seconds when the worker is free; CLI/process startup and stopping may add latency. Each turn also receives a bounded timeout. No claim of an exact wall-clock kill is made.

The token threshold uses reported session counters. Some engines report usage only at the end of a turn, so an in-flight call can exceed it. It is **not a billing cap or subscription quota**. Stopping prevents new launches and requests the normal stop of owned sessions; a model request already sent cannot be recalled. **Stop** asks for confirmation because it is final, unlike **Pause**: a stopped mission cannot be resumed.

Pause interrupts active agents and retains their conversations. Interrupted or failed steps are not automatically retried. Review them, explicitly skip a step when appropriate, and resume, or create a corrected mission. Restarts reconcile launch keys with existing sessions instead of creating duplicate work; an uncertain launch without a recoverable session stops for attention. In relocated or restored state, an active or planning mission is paused before automatic work can resume; drafts and finished missions keep their state. Skipping is available while a mission is paused: stopped, completed and limit-reached missions are final.

Current limits are 50 missions per installation, eight steps, 32 runs and 32 cycles per mission, at most 24 hours of working time and at most two resident agents globally. Historical conversations and proposals remain available through the existing session and companion pages. Missions do not archive or delete them.
