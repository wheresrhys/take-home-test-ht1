---
name: swarm
description: >-
  Keep open PRs mergeable — resolve merge conflicts and clear outstanding review feedback — then
  pick unblocked `ready` GitHub issues and implement them in parallel. Each unit of work runs in
  its own git worktree via a subagent on the model named by the ticket's label (fable/sonnet/opus).
  Biases toward tickets that unblock the most others. Each ticket subagent runs the
  /implement-ticket skill (branch, commits, tests, PR with "Closes #<n>", mermaid-diff). Runs as a
  continuously-refilling pool of up to 4 worker subagents (the orchestrator doesn't count): each
  completion triggers a re-select + respawn until no eligible work remains. A stop command prompts
  the user to confirm halt-all vs drain. Orchestration only — PR maintenance, selection, worktree
  isolation, model routing, parallelism, refill, termination, teardown. Triggers: "swarm",
  "/swarm", "pick up ready tickets", "work the ready queue".
---

# swarm

Two kinds of concurrent work, one subagent + worktree each: (a) **maintain open PRs** — resolve
merge conflicts and address outstanding feedback so they can merge — then (b) **implement `ready`
tickets**. This skill orchestrates; per-ticket work is delegated to the
[`implement-ticket`](../implement-ticket/SKILL.md) skill.

**Concurrency is capped at 4 worker subagents.** The top-level swarm orchestrator (the parent
agent running this skill) does not count toward the cap — it only selects, spawns, reports and
refills; it holds no worktree and does no ticket work. So: 1 orchestrator + up to 4 workers.

PR maintenance goes first — merging open PRs unblocks downstream tickets — so allocate free slots
to PRs needing maintenance first, then fill the remainder with tickets.

**This is a continuously-refilling pool, not a one-shot batch.** The orchestrator keeps 4 slots
busy: every time a worker subagent finishes, immediately re-run selection (§1 maintenance first,
then §2 tickets) and spawn a replacement for each newly-freed slot, up to the cap. Keep refilling
until there is genuinely no eligible work left (no PR needs maintenance and no unblocked, not-in-
flight `ready` ticket remains) — then go idle and report the pool is drained. A new completion or
a freshly-`ready`/-conflicting PR later re-triggers a refill. The user can stop the loop at any
time — see **Termination**.

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
- Take as many as the **free slots** allow (4 minus workers currently running — both tracks).

If, on a given selection pass, neither §1 nor §2 yields eligible work **and** no workers are
running, the pool is drained: report that and go idle (do not exit the loop — a later completion
or new PR can refill).

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

## 4. On each completion: report, then refill

Every time a worker subagent finishes (completions arrive as notifications, usually one at a time):
1. **Record** its worktree path for teardown and note whether it succeeded or needs the user.
2. **Report** that unit:
   - **Maintained PRs**: PR → conflicts resolved? → feedback addressed (+ reviewer reply URL) →
     commit pushed → now mergeable? (or "no-op, nothing outstanding").
   - **Tickets**: issue → branch → PR URL → test status → whether mermaid-diff posted.
   - Flag anything that failed tests, still conflicts after the merge, couldn't open a PR, or
     couldn't push so the user can intervene.
3. **Refill** — unless termination has been requested (see below), immediately re-run selection
   (§1 then §2) for the now-free slot(s) and spawn replacements up to the cap. A finished ticket
   often makes its PR eligible for maintenance and unblocks downstream tickets, so a completion
   usually creates fresh work. If nothing is eligible and no workers remain, report the pool is
   drained and go idle.

Track the live worker set (subagent id → what it's doing) across the whole run so the cap, refill,
and termination logic all have an accurate count.

## Termination (user asks to stop)

If the user issues any stop-like command to the **orchestrator** — e.g. "stop swarming", "stop",
"exit", "halt", "cancel", "abort", "that's enough" — do **not** guess. First stop refilling
(launch no new workers), then **ask the user to confirm which they mean**, via `AskUserQuestion`
with these two options:
- **Halt all now** — immediately stop every running worker subagent (`TaskStop` each live worker
  id), abandoning in-flight work. Use for an urgent full stop.
- **Drain** — stop starting new work, but let the workers already running finish and report
  normally. No new refills after this.

Then do exactly what they pick:
- *Halt all now* → `TaskStop` every tracked live worker, confirm each is stopped, report what was
  abandoned (branch/worktree state may be partial), and exit the loop.
- *Drain* → keep the refill suppressed, await the running workers' completions, report each as it
  lands (§4 steps 1–2 only, no refill), and exit the loop once the pool empties.

Either way, leave worktrees in place for teardown unless the user also asks to clean up.

## 5. Teardown (after the user is done)

The branch is pushed and the PR holds the work, so the local worktree is only needed for review.
Do NOT tear down automatically — wait until the user says they're done (or the PRs are merged).
Then, per worktree created:
- `git worktree remove <path>` (`--force` only if it has leftovers the user accepts losing).
- `git worktree prune` to clear stale entries.
Confirm each removal; report anything skipped (e.g. a worktree with unpushed changes).

## Rules
- Open-PR maintenance (conflicts + feedback) is handled first; ready tickets fill the remaining
  budget. One subagent per PR does both concerns for that PR.
- Resolve conflicts by merging `origin/main` into the PR branch — never rebase/force-push a shared
  branch.
- Never pick a blocked ticket; never exceed **4 concurrent worker subagents** across both tracks.
  The orchestrator itself is not a worker and does not count toward the 4.
- Keep the pool full: on every worker completion, refill freed slots (maintenance first, then
  tickets) until no eligible work remains — then go idle, don't exit.
- On any stop-like command from the user, suppress refilling immediately, then confirm via
  `AskUserQuestion` whether to **halt all now** (`TaskStop` every live worker) or **drain** (let
  running workers finish), and do exactly that. Never assume which.
- Each subagent runs the model the ticket label dictates (feedback PRs: the linked ticket's label,
  else `sonnet`).
- One worktree per unit of work; parallel branches must never share a working tree. Ticket work
  cuts a fresh isolated worktree; feedback work reuses the PR branch's existing worktree or adds
  one for that branch.
- Every ticket branch is based on freshly-fetched `origin/main`, never on the local checkout.
- Per-ticket work goes through `implement-ticket` — don't reinvent it here.
