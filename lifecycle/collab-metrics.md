# Collaboration metrics - archon

Appended by `_system/scripts/collab_metrics.py`. Derived from git and GitHub after the fact; nothing here proves a merge was clean, because squash-merge erases that.

## 2026-09-21 05:02 (last 7 days)

**Abandoned pull requests (closed, never merged): 25.**
  - #3392 feat(web/console,core): read a chat's summary in a modal, as three answers
  - #3391 fix(web/console): the chat color picker offered six labels but rendered five
  - #3390 fix(web/console,core): four defects found reviewing the chat rail and summary to
  - #3389 feat(web/console): arrange a project's chats by hand
  - #3388 fix(web/console): the chat rail made page state and conversation state different
  - #3387 feat(web/console): answer the agent's questions by clicking them
  - #3386 fix(server): tell browsers how long the web UI may be cached
  - #3385 fix(web/console): show a reply as it streams, not on the next reload
  - #3381 feat(web/console): copy a code block or a whole reply, and stop the page scrolli
  - #3380 feat(web/console): choose 12-hour or 24-hour timestamps
  - *Says nothing about why. A superseded duplicate and a failed change look the same.*

**Leftovers: 0 worktree records to prune, 2 branches with no merged pull request (2 older than 7 days).**
  - chore/drop-fork-customizations (31 days)
  - feat/upstream-v0.9.0 (31 days)
  - *Expect this to look alarming and mostly not be. Squash-merge rewrites commits, so a branch whose work IS merged still reads as unmerged; these are matched against merged pull request branches by name only. Review candidates, not findings.*

**File collisions: 84 pair(s) of the 40 open pull requests touch the same file.**
  - #2529 and #3181 share 2 file(s): packages/adapters/src/chat/slack/adapter.test.ts, packages/adapters/src/chat/slack/adapter.ts
  - #2529 and #3308 share 2 file(s): packages/adapters/src/chat/slack/workflow-bridge.test.ts, packages/adapters/src/chat/slack/workflow-bridge.ts
  - #3147 and #3163 share 2 file(s): packages/server/src/routes/api.ts, packages/server/src/routes/api.workflow-runs.test.ts
  - #3147 and #3221 share 1 file(s): packages/cli/package.json
  - #3147 and #3337 share 1 file(s): packages/cli/package.json
  - #3147 and #3343 share 1 file(s): packages/core/src/db/timestamps.ts
  - #3147 and #3347 share 2 file(s): packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts
  - #3147 and #3350 share 2 file(s): packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts
  - #3147 and #3351 share 2 file(s): packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts
  - #3147 and #3363 share 3 file(s): packages/core/src/db/workflow-events.ts, packages/core/src/db/workflows.test.ts, packages/core/src/db/workflows.ts
  - *Only counts pull requests open right now, so two agents who collided and already merged are invisible to it.*

**Rework: 0 of the 1 merged pull requests carrying a GitHub review got more commits after the first one.**
  - *More commits after a review can mean the review worked, not that the process failed.*

**Time from opening to merge: median 54.8 h, longest 89.6 h, across 4 merged pull requests.** *The long tail is where friction hides; a merge that waited on a human is counted the same as one that fought the code.*

