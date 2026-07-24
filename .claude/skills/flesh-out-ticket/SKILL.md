---
name: flesh-out-ticket
description: >-
  Turn ONE sketched task into a precise, commit-sized, test-enumerated ticket and file it as a
  labelled GitHub issue. Fleshes out scope/acceptance criteria, breaks the work into small
  commits, enumerates describe blocks and test titles (USE algorithm), picks the cheapest Claude
  model that can do it accurately (fable/sonnet/opus label), ALWAYS asks for confirmation, then
  runs `gh issue create` with the model label plus `ready`. Operates on a single task only — it
  never walks the whole task list. Triggers: "flesh out ticket", "flesh out this task",
  "/flesh-out-ticket", turning a tasks.md item into a GitHub issue.
---

# flesh-out-ticket

Take a **single** task description and turn it into a precise GitHub issue. Work on one task
only — never iterate `tasks.md` or process multiple tasks in one run. If the user hands you a
whole list, ask which single task to act on.

## Precheck

Confirm GitHub Issues are enabled: run `gh issue list` once. If it errors with issues disabled,
stop and tell the user to enable them (`gh repo edit --enable-issues`) before continuing.

## Input

The task text arrives as the skill argument: either pasted prose, or a `tasks.md`
heading/section the user names (read just that section from `tasks.md`). If no task text is
given, ask the user to paste the one task, then stop until they do.

## Workflow

### 1. Flesh out the ticket
Draft a structured ticket in markdown:
- **Title** — concise, imperative (e.g. "Add Postgres via Docker with db:start").
- **Context** — why this is needed; link the originating `tasks.md` item or README requirement.
- **Scope & acceptance criteria** — bullets, each testable/observable.
- **Out of scope** — what this ticket deliberately does not do.
- **Dependencies** — other tickets/work that must land first.
- **Reuse** — name existing repo files/patterns to build on (grep/read the repo before asserting
  something exists). Follow conventions in `CLAUDE.md` (tabs, `HttpResponse<T>`, named exports).

### 2. Break into small commits
Ordered list of shippable subtasks. Each aims for <400 LOC (per `CLAUDE.md`). One line each:
what changes and why. If the whole ticket is one small commit, say so.

### 3. Enumerate tests (USE algorithm)
Apply the USE algorithm from `CLAUDE.md`:
- **Usual** — typical happy-path cases.
- **Structure** — one test per param/variant/branch of the thing's shape.
- **Edge** — boundaries, empties, ties, errors.

List concrete `describe` blocks and individual test titles. Validators → unit tests; endpoints →
BDD/supertest tests from the caller's point of view. If the ticket has no runtime surface (pure
docs/config), write "No tests" plus a one-line reason.

### 4. Choose the model label
Pick the **cheapest** Claude model that can complete the ticket **accurately**:
- **`fable`** — trivial/mechanical: config, boilerplate, scaffolding, renames, simple CRUD, docs.
- **`sonnet`** — standard feature work, moderate logic, straightforward tests (default choice).
- **`opus`** — complex/ambiguous/high-risk: tricky architecture, concurrency/dedupe/idempotency,
  security, subtle correctness, or where a mistake is costly.

State the chosen label and a one-line justification.

### 5. Confirm (HARD GATE — never skip)
Present the full drafted ticket (sections 1–3) plus the proposed model label and justification.
Then call **AskUserQuestion** offering: **Confirm & create** / **Edit** / **Change model label**.
- Do NOT create the issue until the user explicitly confirms.
- On Edit or Change label, revise and re-present, looping until confirmed.

### 6. Create the GitHub issue
Only after confirmation:
1. Ensure labels exist. Run `gh label list`. For any of the chosen model label and `ready` that
   are missing, create them:
   - `gh label create ready --color 0e8a16 --description "Ticket fleshed out, ready to pick up"`
   - `gh label create opus --color 6f42c1 --description "Best done by Claude Opus"`
   - `gh label create sonnet --color 1d76db --description "Best done by Claude Sonnet"`
   - `gh label create fable --color fbca04 --description "Best done by Claude Fable"`
2. Write the fleshed markdown (sections 1–3) to a temp file in the scratchpad and create the
   issue from it (avoids shell-escaping problems):
   `gh issue create --title "<title>" --body-file <tmpfile> --label <model> --label ready`
3. Report the created issue URL back to the user.

## Rules
- Single task per run. Never batch.
- Every issue gets exactly two labels: one model label (`fable`|`sonnet`|`opus`) + `ready`.
- Confirmation gate in step 5 is mandatory — no issue without an explicit yes.
