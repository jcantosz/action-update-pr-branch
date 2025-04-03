# Find Approved PR Action

This GitHub Action finds the first open pull request in a repository that has been approved by at least one reviewer, has no pending change requests, and automatically updates its branch with the latest changes from the base branch.

## PR Update Conditions

For a PR to be considered ready for branch update, it must meet ALL of the following criteria:

- The PR must be open
- The PR must have at least one approval from a reviewer
- The PR must not have any pending change requests
- The PR must not have any pending reviews (no requested reviewers or teams)

## Inputs

- `github_token` (required): GitHub token for API access. Default: `${{ github.token }}`
- `github_app_id` (optional): GitHub App ID for authentication (if using GitHub App instead of token)
- `github_private_key` (optional): Private key for the GitHub App in PEM format
- `github_installation_id` (optional): Installation ID for the GitHub App
- `api_url` (optional): GitHub API URL. Default: `https://api.github.com`
- `repo` (optional): Target repository in format owner/repo. Default: current repository
- `base_branch` (optional): Filter PRs by base branch name (e.g., main, master)

## Outputs

- `pr_number`: The number of the first approved PR found
- `pr_title`: The title of the approved PR
- `pr_url`: The URL to the approved PR
- `branch_name`: The branch name of the approved PR
- `branch_updated`: Whether the branch was updated (`true`) or not (`false`)
- `has_conflicts`: Whether there were merge conflicts when trying to update the branch

## Example Usage

### Scheduled Workflow

```yaml
name: Find and Process Approved PR
on:
  workflow_dispatch:
  schedule:
    - cron: "0 */6 * * *" # Run every 6 hours

jobs:
  update-approved-prs:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Update Approved PR Branch
        uses: jcantosz/action-update-pr-branch@main
        id: update-pr
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          repo: ${{ github.repository }}
          base_branch: main

      - name: Check Result
        if: steps.update-pr.outputs.pr_number
        run: |
          echo "Updated PR #${{ steps.update-pr.outputs.pr_number }}: ${{ steps.update-pr.outputs.pr_title }}"
          echo "#${{ pr_url }}"
```

### On PR Merge Workflow

```yaml
name: Update PRs on Merge
on:
  pull_request:
    types: [closed]
    branches:
      - main # or your default branch

jobs:
  update-prs-after-merge:
    # Only run if the PR was merged (not just closed)
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Update Approved PRs
        uses: jcantosz/action-update-pr-branch@main
        id: update-pr
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          repo: ${{ github.repository }}
          base_branch: ${{ github.base_ref }} # when a PR against this ref is closed, update other prs that target the same branch
      - name: Check Result
        if: steps.update-pr.outputs.pr_number
        run: |
          echo "Updated PR #${{ steps.update-pr.outputs.pr_number }}: ${{ steps.update-pr.outputs.pr_title }}"
          echo "#${{ steps.update-pr.outputs.pr_url }}"
```
