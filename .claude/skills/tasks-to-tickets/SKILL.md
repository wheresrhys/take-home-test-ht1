---
name: tasks-to-tickets
description: >-
  Turn a whole list of sketched tasks (passed as an argument, or read from tasks.md) into a set
  of GitHub issues, one per task, by reusing the flesh-out-ticket skill for each. First reviews
  the whole task list conversationally, surfacing clarifications/improvements and writing accepted
  ones back to tasks.md, before drafting. Folds the
  task's heading into the issue title ("{Heading}: title"), enumerates commits and tests, picks a
  model label (fable/sonnet/opus) + `ready`, and expresses inter-task dependencies as GitHub
  native "blocked by" links. Drafting is parallelised across subagents, but the flesh-out-ticket
  confirmation gate still fires for every ticket in the main thread. Triggers: "tasks to
  tickets", "create tickets for all these tasks", "/tasks-to-tickets", "turn tasks.md into
  issues".
---

# tasks-to-tickets

Turn a list of tasks into GitHub issues — one issue per task — by reusing the
[`flesh-out-ticket`](../flesh-out-ticket/SKILL.md) skill for each. This skill orchestrates;
`flesh-out-ticket` owns how a single ticket is fleshed out, confirmed, labelled and created.

## Precheck
Confirm GitHub Issues are enabled: run `gh issue list` once. If it errors with issues disabled,
stop and tell the user to enable them (`gh repo edit --enable-issues`) before continuing.

## Workflow

### 1. Review the whole list (conversational)
Run this **once, up front**, before any drafting. It is distinct from both the scope-selection
step (§2) and the per-ticket confirmation gate (§4).

- Read the full task source (the skill argument if given, otherwise `tasks.md`) and parse into an
  ordered list of `{heading, text}`. Each numbered line item under a `#` heading is one task; the
  literal numbers in `tasks.md` are messy/duplicated — treat every line item as a task, ignore
  its number. Skip meta-process sections (e.g. `# Skills`).
- Review the list **as a whole** and raise, in prose, anything worth the user's input before
  drafting. Grep/read the repo (`README.md`, `CLAUDE.md`, `src/`) before asserting gaps. Look for:
  - **Ambiguities / open questions** already in the text (e.g. the `(NOTE: what about
    transactions here?)` on the Retry task).
  - **Gaps** — missing tasks or acceptance detail implied by `README.md` / `CLAUDE.md` core
    requirements (dedupe, guaranteed email, retry-after-deploy).
  - **Ordering / dependency** problems (a task that needs another to land first).
  - **Merge / split** candidates (items too big for one <400 LOC ticket, or trivially small
    duplicates).
  - **Inconsistencies** with repo conventions in `CLAUDE.md`.
- Discuss **conversationally**: propose each point and let the user accept / reject / amend. This
  is a genuine dialogue, not a one-shot AskUserQuestion.
- For every **accepted** improvement, edit the task source:
  - If the source was `tasks.md`, edit `tasks.md` in place — apply the content change
    (add / remove / reword / reorder / merge / split task lines) **and renumber the list items
    sequentially per `#` heading** so the file is left tidy. Preserve the heading structure and
    the file's existing markdown style (tabs/spacing per `CLAUDE.md`).
  - If the source was a pasted skill argument (not `tasks.md`), apply the accepted edits to the
    working copy used for drafting and tell the user `tasks.md` was **not** touched.
- Use the **updated** list as the input to every step below.

### 2. Scope selection
- Present the reviewed list back to the user (heading + a one-line summary per task) and let them
  trim or confirm which tasks are in scope. This is scope selection — it is NOT the per-ticket
  confirmation gate (that comes later, per ticket).

### 3. Draft each ticket (parallelise)
For each in-scope task, produce a draft using `flesh-out-ticket` steps 1–4 (flesh out, small-
commit breakdown, USE test enumeration, model-label choice). Do NOT create issues yet.

When there are more than ~3 tasks, fan out to `general-purpose` subagents to draft concurrently:
- Give each subagent exactly ONE task to draft, **plus the full parsed task list for reference**
  so it can identify dependencies on other tasks.
- Instruct each subagent to **draft only**: it MUST NOT create any GitHub issue and MUST NOT try
  to confirm with the user (subagents cannot prompt the user). It returns a structured draft:
  - `title` — the fleshed title, prefixed with its heading: `{Heading}: {title}`
  - `body` — the fleshed markdown (context/scope/acceptance/out-of-scope/reuse + commit
    breakdown + test enumeration)
  - `modelLabel` + one-line justification (`fable`|`sonnet`|`opus`)
  - `dependsOn` — the other tasks (identified by heading + summary) this task is blocked by

### 4. Confirm each ticket — HARD GATE, propagated from flesh-out-ticket
Back in the **main thread**, order the drafts in dependency order (blockers before the tickets
they block). For each draft, run `flesh-out-ticket` step 5's confirmation gate: present the full
ticket + proposed model label, then AskUserQuestion offering **Confirm & create / Edit / Change
model label**. Loop on edits until the user confirms.

This gate is mandatory for every ticket. Parallel drafting in step 3 must never bypass it — the
user confirms and can give feedback on each WIP ticket individually.

### 5. Create issues
On each confirmation, run `flesh-out-ticket` step 6: ensure the model label and `ready` label
exist (create if missing), write the body to a scratchpad temp file, then:
`gh issue create --title "{Heading}: ..." --body-file <tmpfile> --label <model> --label ready`.
Record the mapping `task → issue number`.

### 6. Wire up dependencies (second pass)
Once every confirmed issue exists (so all issue numbers are known), resolve each ticket's
`dependsOn` tasks to their issue numbers and apply the GitHub "blocked by" links:
`gh issue edit <issue#> --add-blocked-by <blockerIssue#>[,<blockerIssue#>...]`
(A second pass is used so creation order and missing-number problems don't arise.)

### 7. Report
Summarise: each created issue URL, its labels, and its blocked-by links.

## Rules
- The whole-list review (§1) runs once at the start, before any drafting. Only user-accepted
  changes are written back; when the source is `tasks.md`, edits are applied in place and list
  numbering is cleaned up per heading.
- One issue per task. Reuse `flesh-out-ticket` for the per-ticket work — do not reinvent its
  fleshing, confirmation gate, labelling, or creation logic.
- Every issue: `{Heading}:` title prefix, one model label (`fable`|`sonnet`|`opus`) + `ready`,
  and any blocked-by links.
- The per-ticket confirmation gate is non-negotiable and runs in the main thread, even when
  drafting was parallelised.
