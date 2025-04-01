import * as core from "@actions/core";
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { createAppAuth } from "@octokit/auth-app";
import fetch from "node-fetch";

// Get inputs from GitHub Actions
function getInputs() {
  const auth = {
    token: core.getInput("github_token") || process.env.GITHUB_TOKEN,
    appId: core.getInput("github_app_id"),
    privateKey: core.getInput("github_private_key"),
    installationId: core.getInput("github_installation_id"),
  };
  const repoInput = core.getInput("repo") || process.env.GITHUB_REPOSITORY;
  const baseBranch = core.getInput("base_branch");

  const [owner, repo] = repoInput.split("/");

  return { auth, owner, repo, baseBranch };
}

function getOctokit(auth) {
  const MyOctokit = Octokit.plugin(paginateRest, retry, throttling);
  let octokitAuth = auth.token;
  if (auth.appId) {
    delete auth.token;
    octokitAuth = auth;
  }

  return new MyOctokit({
    authStrategy: auth.appId ? createAppAuth : undefined,
    auth: octokitAuth,
    baseUrl: core.getInput("api_url") || "https://api.github.com",
    request: { fetch },
    log: core.isDebug() ? console : null,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

        if (retryCount < 1) {
          // only retries once
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        // does not retry, only logs a warning
        octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
      },
      onAbuseLimit: (retryAfter, options) => {
        console.warn(`Abuse detected for request ${options.method} ${options.url}`);
        return true;
      },
    },
  });
}

// Get open pull requests with optional base branch filter
async function getOpenPullRequests(octokit, owner, repo, baseBranch) {
  const requestParams = {
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "asc", // Get oldest first
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  // Add base branch filter if specified
  if (baseBranch) {
    requestParams.base = baseBranch;
    core.info(`Filtering PRs by base branch: ${baseBranch}`);
  }

  const { data: pullRequests } = await octokit.request("GET /repos/{owner}/{repo}/pulls", requestParams);
  core.info(`Found ${pullRequests.length} open pull requests.`);

  return pullRequests;
}

// Get full pull request details including requested reviewers and teams
async function getPullRequestDetails(octokit, owner, repo, pullNumber) {
  const { data: pullRequest } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  return pullRequest;
}

// Get reviews for a specific pull request
async function getPullRequestReviews(octokit, owner, repo, pullNumber) {
  const { data: reviews } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: pullNumber,
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  return reviews;
}

// Process review data to get approval status
function processReviewStatus(reviews) {
  // Get most recent review state per reviewer
  const reviewerLatestState = {};

  reviews.forEach((review) => {
    const reviewer = review.user.login;

    // Only process if we haven't seen this reviewer or if this review is newer
    if (
      !reviewerLatestState[reviewer] ||
      new Date(review.submitted_at) > new Date(reviewerLatestState[reviewer].submitted_at)
    ) {
      reviewerLatestState[reviewer] = {
        state: review.state,
        submitted_at: review.submitted_at,
      };
    }
  });

  // Check if the PR has at least one approval and no pending changes requested
  const approvals = Object.values(reviewerLatestState).filter((review) => review.state === "APPROVED");
  const changesRequested = Object.values(reviewerLatestState).some((review) => review.state === "CHANGES_REQUESTED");

  return {
    hasValidApproval: approvals.length > 0 && !changesRequested,
    approvalCount: approvals.length,
    hasChangesRequested: changesRequested,
  };
}

// Set output values for an approved PR
function setApprovedPrOutputs(pr) {
  core.setOutput("pr_number", pr.number);
  core.setOutput("pr_title", pr.title);
  core.setOutput("pr_url", pr.html_url);
  core.setOutput("branch_name", pr.head.ref);
}

// Update a pull request branch with latest changes from base branch
async function updatePullRequestBranch(octokit, owner, repo, pr) {
  const headSha = pr.head.sha;

  try {
    // Use the update-branch endpoint to update the PR branch
    await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
      owner,
      repo,
      pull_number: pr.number,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    core.info(`✅ Successfully updated branch for PR #${pr.number}`);
    core.setOutput("branch_updated", "true");
    return true;
  } catch (updateError) {
    // Handle any errors from the update-branch endpoint
    core.warning(`❌ Error updating branch: ${updateError.message}`);
    core.setOutput("branch_updated", "false");

    if (updateError.status === 422 && updateError.message.includes("merge conflict")) {
      core.setOutput("has_conflicts", "true");
      core.warning("⚠️ The PR branch has conflicts that need manual resolution");
    }

    return false;
  }
}

// Check if a PR meets the approval criteria
async function isPrReadyForUpdate(octokit, owner, repo, pr) {
  // Get detailed PR information including requested reviewers and teams
  const prDetails = await getPullRequestDetails(octokit, owner, repo, pr.number);

  // Check if there are any pending reviewers or teams
  const hasPendingReviews = prDetails.requested_reviewers.length > 0 || prDetails.requested_teams.length > 0;

  if (hasPendingReviews) {
    core.info(`PR #${pr.number} has pending reviews. Skipping.`);
    return false;
  }

  // Get all reviews for this PR
  const reviews = await getPullRequestReviews(octokit, owner, repo, pr.number);

  // Process review status
  const { hasValidApproval, approvalCount, hasChangesRequested } = processReviewStatus(reviews);

  if (!hasValidApproval) {
    if (approvalCount > 0 && hasChangesRequested) {
      core.info(`PR #${pr.number} has approval(s) but also has pending change requests. Skipping.`);
    } else {
      core.info(`PR #${pr.number} does not have required approvals. Skipping.`);
    }
    return false;
  }

  core.info(
    `Found approved PR #${pr.number}: ${pr.title} with ${approvalCount} approval(s), no pending change requests, and no pending reviews`
  );
  return true;
}

// Process and update a validated PR
async function processApprovedPr(octokit, owner, repo, pr) {
  // Set outputs for the approved PR
  setApprovedPrOutputs(pr);

  // Update the PR branch
  core.info(`Updating PR branch for PR #${pr.number}...`);
  return await updatePullRequestBranch(octokit, owner, repo, pr);
}

// Main function
export async function run() {
  try {
    // Get input parameters and initialize Octokit
    const { auth, owner, repo, baseBranch } = getInputs();

    // Debug logs
    core.debug(`owner: ${owner}`);
    core.debug(`repo: ${repo}`);
    core.debug(`basebranch: ${baseBranch}`);
    core.debug(`auth: ${JSON.stringify(auth)}`);

    const octokit = getOctokit(auth);
    core.info(`Searching for approved PRs in ${owner}/${repo}...`);

    // Get open pull requests
    const pullRequests = await getOpenPullRequests(octokit, owner, repo, baseBranch);

    // Process each PR in sequence
    for (const pr of pullRequests) {
      core.info(`Checking PR #${pr.number}: ${pr.title}...`);

      const isReadyForUpdate = await isPrReadyForUpdate(octokit, owner, repo, pr);
      if (!isReadyForUpdate) continue;

      await processApprovedPr(octokit, owner, repo, pr);
      return; // Exit after finding first approved PR
    }

    core.info("No approved pull requests found that meet all criteria.");
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}
