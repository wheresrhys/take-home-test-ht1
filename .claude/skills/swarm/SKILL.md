---
name: swarm
description: >-
  Keep open PRs mergeable — resolve merge conflicts and clear outstanding review feedback — then
  pick unblocked `ready` GitHub issues and implement them in parallel. Each unit of work runs in
  its own git worktree via a subagent on the model named by the ticket's label (fable/sonnet/opus).
  Biases toward tickets that unblock the most others. Each ticket subagent runs the
  /implement-ticket skill (branch, commits, tests, PR with "Closes #<n>", mermaid-diff).
  Orchestration only — PR maintenance, selection, worktree isolation, model routing, parallelism,
  teardown. Triggers: "swarm", "/swarm", "pick up ready tickets", "work the ready queue".
---

# swarm

Two kinds of concurrent work, one subagent + worktree each: (a) **maintain open PRs** — resolve
merge conflicts and address outstanding feedback so they can merge — then (b) **implement `ready`
tickets**. This skill orchestrates; per-ticket work is delegated to the
[`implement-ticket`](../implement-ticket/SKILL.md) skill.

**Total concurrency across both kinds is capped at 4.** PR maintenance goes first — merging open
PRs unblocks downstream tickets — so allocate the budget to PRs needing maintenance first, then
fill the remainder with tickets.

## 1. Maintain open PRs — resolve conflicts + address feedback (first call on the budget)

`gh pr list --state open --json number,title,headRefName,labels,reviews,mergeable`

An open PR **needs maintenance** if either holds:
- **Merge conflicts** — `mergeable` is `CONFLICTING` (it may report `UNKNOWN` briefly while GitHub
  recomputes; re-query rather than assume).
- **Outstanding feedback** — inline review comments (`gh api repos/{owner}/{repo}/pulls/<n>/comments`)
  or review bodies (`gh pr view <n> --json reviews`) authored by a human, **newer than the PR's
  head commit** or not yet replied to. `CHANGES_REQUESTED` always counts. Ignore the PR's own
  mermaid-diff/behaviour-change bot comments and anything already answered.

For each PR needing maintenance (up to the budget), launch **one** background Agent that handles
both concerns for that PR:
- `subagent_type: general-purpose`; no `isolation` — the prompt tells it to **reuse the PR
  branch's existing worktree if one exists** (`git worktree list`), else `git worktree add` a fresh
  one for that branch. Never edit the main working tree.
- `model` = the linked ticket's label if resolvable, else `sonnet`.
- `description`: `"Maintain PR #<pr>"`.
- Prompt, in order:
  1. **Conflicts first** — if `CONFLICTING`, `git fetch origin` then `git merge origin/main`
     (merge, not rebase — no force-push onto a shared branch), resolve every conflict honouring
     both sides' intent, run the relevant tests to prove the merge is sound.
  2. **Then feedback** — summarise outstanding feedback, make the changes, run tests, reply to the
     reviewer via `gh pr comment <n>`.
  3. Commit (repo conventions) and push. If on inspection neither a real conflict nor genuine
     feedback remains, no-op and report that.

If no open PR needs maintenance, skip to ticket selection with the full budget.

## 2. Select tickets (fill the remaining budget)

`gh issue list --state open --label ready --json number,title,labels,blockedBy,blocking`

Filter and rank:
- **Unblocked only** — drop any issue with an *open* entry in `blockedBy` (all-closed blockers =
  unblocked).
- **Skip in-flight** — drop issues that already have an open linked PR or an existing branch
  (`gh issue view <n> --json closedByPullRequestsReferences` / `git branch -a`).
- **Bias to unblockers** — rank by the count of *open* issues in `blocking` (how many others this
  ticket unblocks), highest first; tie-break on lowest issue number.
- Take as many as the **remaining budget** allows (4 minus the feedback subagents launched in
  step 1).

If neither step 1 nor step 2 finds work, report that and stop.

## 3. Spawn one worktree subagent per ticket

For each selected issue, launch an Agent (default background, so they run in parallel):
- `subagent_type: general-purpose`
- `isolation: "worktree"` — isolated git worktree per ticket, so parallel branches never collide.
- `model` = the ticket's model label — `opus` | `sonnet` | `fable` (exactly the label). Don't
  substitute.
- `description`: `"Implement #<n>"`.
- Prompt: **first `git fetch origin` and create the ticket branch off `origin/main`** (the worktree
  is cut from local `main`, which may be stale relative to origin — basing on `origin/main` picks
  up already-merged sibling tickets), then run the `implement-ticket` skill for issue `<n>` and
  return its result (PR number + URL + test status).

The subagent owns branch/commits/tests/PR/mermaid-diff via `implement-ticket`. swarm does not
duplicate that logic — it only pins the branch base to `origin/main` so parallel worktrees don't
build on a stale local checkout.

## 4. Report

As each subagent finishes, collect its result and **record its worktree path** for teardown.
Summarise both tracks:
- **Feedback PRs**: PR → what was addressed → commit pushed → reviewer reply URL (or "no-op,
  nothing outstanding").
- **Tickets**: issue → branch → PR URL → test status → whether mermaid-diff posted.

Flag anything that failed tests, couldn't open a PR, or couldn't push so the user can intervene.

## 5. Teardown (after the user is done)

The branch is pushed and the PR holds the work, so the local worktree is only needed for review.
Do NOT tear down automatically — wait until the user says they're done (or the PRs are merged).
Then, per worktree created:
- `git worktree remove <path>` (`--force` only if it has leftovers the user accepts losing).
- `git worktree prune` to clear stale entries.
Confirm each removal; report anything skipped (e.g. a worktree with unpushed changes).

## Rules
- Feedback on open PRs is handled first; ready tickets fill the remaining budget.
- Never pick a blocked ticket; never exceed **4 concurrent subagents total** across both tracks.
- Each subagent runs the model the ticket label dictates (feedback PRs: the linked ticket's label,
  else `sonnet`).
- One worktree per unit of work; parallel branches must never share a working tree. Ticket work
  cuts a fresh isolated worktree; feedback work reuses the PR branch's existing worktree or adds
  one for that branch.
- Every ticket branch is based on freshly-fetched `origin/main`, never on the local checkout.
- Per-ticket work goes through `implement-ticket` — don't reinvent it here.
