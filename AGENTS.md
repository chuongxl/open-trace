# Agent workflow

## One worktree per issue
- Never work on an issue in the main checkout. Create a worktree from fresh `origin/main`:
  `git fetch && git worktree add ../open-trace-wt/issue-N -b fix/issue-N origin/main`
  (branch `feat/phase-N` for phase features).
- Run `npm install` (and `cd dashboard && npm install`) inside the worktree; `node_modules` is not shared.
- One issue = one worktree = one branch = one PR. Do not stack PRs; branch from `main` and retarget before merging if a PR depends on another.
- After the PR is created and pushed, remove the worktree:
  `git worktree remove ../open-trace-wt/issue-N` (the branch lives on in the PR).
  Re-create it from the PR branch if review fixes are needed, and remove it again after pushing.
- `git worktree list` should show only the main checkout when no PR is being prepared.
