---
name: implement-ticket
description: >-
  Given a single GitHub issue number, implement it end-to-end in the current working tree: read
  the ticket, branch off it, make every commit in the ticket's breakdown following repo
  conventions, run the relevant test commands, open a PR with "Closes #<n>", and post
  behaviour-change diagrams via the mermaid-diff skill. Tree- and model-agnostic — it does not
  create worktrees or manage parallelism (that's /swarm's job), so it works standalone on one
  ticket. Triggers: "implement ticket", "/implement-ticket <n>", "implement issue #<n>".
---

# implement-ticket

Implement ONE ticket, identified by issue number, in the current working tree. Does not create
worktrees, pick models, or manage parallelism — `/swarm` owns that. Runs fine standalone.

## Steps

1. **Precheck** — `gh issue list` once; if it errors with issues disabled, stop and tell the user
   to enable them (`gh repo edit --enable-issues`).
2. **Read the issue** — `gh issue view <n> --json title,body,labels`. The body holds the fleshed
   scope, the commit breakdown, and the enumerated tests.
3. **Branch** — create a branch named after the issue: `<n>-<kebab-title>` (truncate sensibly).
   Never work on `main`.
4. **Implement every commit** in the ticket's commit breakdown as real, separate commits.
   Follow repo conventions in `CLAUDE.md`: tabs, `HttpResponse<T>` return pattern, named exports,
   YAGNI, DRY-after-3. Commit trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
5. **Test** — write/adjust the tests the ticket enumerates (USE algorithm), then run the relevant
   command(s): `npm test`, plus any e2e/db commands the ticket names. Do NOT open a PR while tests
   fail — fix the code or report back to the user.
6. **PR** — push the branch and open a PR whose body includes `Closes #<n>` and the trailer
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
7. **Diagrams** — invoke the `mermaid-diff` skill for the new PR (pass the PR number). Do it from
   here, right after opening the PR, so the diagrams draw on the implementation context just built
   rather than a cold GitHub read.
8. **Return** — PR number + URL + test status (and note any commits/tests skipped).

## Rules
- One issue per run. Never touch `main`.
- No PR on red tests.
- mermaid-diff runs here (this is where the change context lives), once, after the PR opens.
