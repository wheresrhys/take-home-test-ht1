---
name: swarm
description: >-
  Pick up to 4 unblocked `ready` GitHub issues and implement them in parallel, each in its own git
  worktree via a subagent running the model named by the ticket's label (fable/sonnet/opus).
  Biases toward tickets that unblock the most others. Each subagent runs the /implement-ticket
  skill (branch, commits, tests, PR with "Closes #<n>", mermaid-diff). Orchestration only —
  selection, worktree isolation, model routing, parallelism, teardown. Triggers: "swarm",
  "/swarm", "pick up ready tickets", "work the ready queue".
---

# swarm

Implement multiple `ready` tickets concurrently, one worktree + subagent per ticket. This skill
orchestrates; the per-ticket work is delegated to the [`implement-ticket`](../implement-ticket/SKILL.md)
skill, which each subagent runs.

## 1. Select tickets (max 4)

`gh issue list --state open --label ready --json number,title,labels,blockedBy,blocking`

Filter and rank:
- **Unblocked only** — drop any issue with an *open* entry in `blockedBy` (all-closed blockers =
  unblocked).
- **Skip in-flight** — drop issues that already have an open linked PR or an existing branch
  (`gh issue view <n> --json closedByPullRequestsReferences` / `git branch -a`).
- **Bias to unblockers** — rank by the count of *open* issues in `blocking` (how many others this
  ticket unblocks), highest first; tie-break on lowest issue number.
- Take the top **4** at most.

If nothing qualifies, report that and stop.

## 2. Spawn one worktree subagent per ticket

For each selected issue, launch an Agent (default background, so they run in parallel):
- `subagent_type: general-purpose`
- `isolation: "worktree"` — isolated git worktree per ticket, so parallel branches never collide.
- `model` = the ticket's model label — `opus` | `sonnet` | `fable` (exactly the label). Don't
  substitute.
- `description`: `"Implement #<n>"`.
- Prompt: run the `implement-ticket` skill for issue `<n>` and return its result (PR number + URL
  + test status).

The subagent owns branch/commits/tests/PR/mermaid-diff via `implement-ticket`. swarm does not
duplicate that logic.

## 3. Report

As each subagent finishes, collect its result and **record its worktree path** for teardown.
Summarise: issue → branch → PR URL → test status → whether mermaid-diff posted. Flag any ticket
that failed tests or couldn't open a PR so the user can intervene.

## 4. Teardown (after the user is done)

The branch is pushed and the PR holds the work, so the local worktree is only needed for review.
Do NOT tear down automatically — wait until the user says they're done (or the PRs are merged).
Then, per worktree created:
- `git worktree remove <path>` (`--force` only if it has leftovers the user accepts losing).
- `git worktree prune` to clear stale entries.
Confirm each removal; report anything skipped (e.g. a worktree with unpushed changes).

## Rules
- Never pick a blocked ticket; never exceed 4 concurrent.
- Each subagent runs the model the ticket label dictates.
- Worktree isolation is mandatory (parallel branches must not share a working tree).
- Per-ticket work goes through `implement-ticket` — don't reinvent it here.
