import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DOC_AGENT_SOURCE_ID,
  docAgentSourceIds,
  inspectReleaseInventory,
} from "./validate-github-release-inventory.mjs";

function release(overrides = {}) {
  return {
    id: 149,
    tag_name: "v0.1.20",
    draft: false,
    prerelease: false,
    target_commitish: "abc123",
    body: `## Changelog\n\n<!-- doc-agent: source-id=${DOC_AGENT_SOURCE_ID} -->`,
    created_at: "2026-07-27T00:00:00Z",
    ...overrides,
  };
}

test("extracts exact Doc Agent source ids", () => {
  assert.deepEqual(
    docAgentSourceIds(
      "<!-- doc-agent: source-id=openclaw-cloud-plugin -->\n<!-- doc-agent: source-id=other -->",
    ),
    ["openclaw-cloud-plugin", "other"],
  );
});

test("accepts an absent release unless post-create verification requires it", () => {
  const absent = inspectReleaseInventory({
    pages: [[]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.state, "absent");

  const required = inspectReleaseInventory({
    pages: [[]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    requireExisting: true,
  });
  assert.equal(required.ok, false);
  assert.match(required.errors[0], /not visible/);
});

test("fails closed on duplicate releases including drafts", () => {
  const report = inspectReleaseInventory({
    pages: [[release(), release({ id: 150, draft: true })]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.state, "ambiguous");
  assert.match(report.errors[0], /2 GitHub Releases/);
});

test("verifies target, release flags, and the exact production source id", () => {
  const valid = inspectReleaseInventory({
    pages: [[release()]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    expectedTargetCommitish: "abc123",
  });
  assert.equal(valid.ok, true);

  const invalid = inspectReleaseInventory({
    pages: [[
      release({
        draft: true,
        prerelease: true,
        target_commitish: "wrong",
        body:
          "<!-- doc-agent: source-id=openclaw-cloud-plugin -->\n" +
          "<!-- doc-agent: source-id=test-openclaw-cloud-plugin -->",
      }),
    ]],
    tag: "v0.1.20",
    expectedDraft: false,
    expectedPrerelease: false,
    expectedTargetCommitish: "abc123",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 4);
  assert.ok(invalid.errors.some((error) => /draft=true/.test(error)));
  assert.ok(invalid.errors.some((error) => /prerelease=true/.test(error)));
  assert.ok(invalid.errors.some((error) => /targets wrong/.test(error)));
  assert.ok(invalid.errors.some((error) => /exactly one Doc Agent source id/.test(error)));
});

test("release workflow pins recovery to npm gitHead and reconciles create responses", () => {
  const workflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /npm_release_git_head\(\)/);
  assert.match(
    workflow,
    /RELEASE_EVIDENCE_REF: \$\{\{ steps\.release_source\.outputs\.evidence_ref \}\}/,
  );
  assert.match(
    workflow,
    /release evidence is pinned to npm gitHead/,
  );
  assert.match(
    workflow,
    /missing GitHub metadata will target npm gitHead \$\{release_commit_sha\}/,
  );
  assert.match(
    workflow,
    /git tag -a "\$\{release_tag\}" "\$\{RELEASE_COMMIT_SHA\}"/,
  );
  assert.match(workflow, /push durable release branch/);
  assert.ok(
    workflow.indexOf("push durable release branch") <
      workflow.indexOf('npm publish --access public --tag "${NPM_DIST_TAG}"'),
    "the recoverable release commit must be pushed before npm publish",
  );
  assert.match(
    workflow,
    /--target "\$\{RELEASE_COMMIT_SHA\}"/,
  );
  assert.match(workflow, /gh api --paginate --slurp/);
  assert.match(
    workflow,
    /Refusing to issue a second create request/,
  );
  assert.match(workflow, /report_exhausted_failure "github-release-create"/);
  assert.match(workflow, /report_exhausted_failure "github-release-verification"/);
  assert.match(workflow, /report_exhausted_failure "github-release-tag-push"/);
  assert.match(workflow, /report_exhausted_failure "github-release-branch-push"/);
  assert.match(workflow, /report_exhausted_failure "github-release-pr-create"/);
  assert.match(workflow, /should_create_version_pr=true/);
  assert.match(
    workflow,
    /Release branch \$\{release_branch\} already points at this commit\.[\s\S]+should_create_version_pr=true/,
  );
  assert.match(
    workflow,
    /::error::Failed to create release PR automatically after three attempts/,
  );
  assert.doesNotMatch(
    workflow,
    /::warning::Failed to create release PR automatically after three attempts/,
  );
  assert.doesNotMatch(workflow, /gh release view/);
});

test("real publishes are branch-gated and reusable callers are immutable dry runs", () => {
  const releaseWorkflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    releaseWorkflow,
    /Real releases must be dispatched from the protected default branch/,
  );

  for (const name of [
    "pre-merge-dry-run.yml",
    "post-merge-dry-run.yml",
    "historical-dry-run.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /dry_run: true/);
    assert.doesNotMatch(workflow, /dry_run: false/);
  }
});

test("dry-run callers use least privilege and do not inherit all repository secrets", () => {
  const releaseWorkflow = readFileSync(
    new URL("../workflows/release.yml", import.meta.url),
    "utf8",
  );
  const dryRunWorkflow = readFileSync(
    new URL("../workflows/release-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(releaseWorkflow, /workflow_call:/);
  assert.match(releaseWorkflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(
    releaseWorkflow,
    /persist-credentials: \$\{\{ inputs\.dry_run != true \}\}/,
  );
  assert.match(dryRunWorkflow, /workflow_call:/);
  assert.match(dryRunWorkflow, /permissions:\s*\n\s*contents: read/);
  assert.match(dryRunWorkflow, /persist-credentials: false/);
  assert.doesNotMatch(dryRunWorkflow, /NPM_TOKEN/);
  assert.doesNotMatch(dryRunWorkflow, /npm publish/);
  assert.doesNotMatch(dryRunWorkflow, /gh release/);
  assert.doesNotMatch(dryRunWorkflow, /contents: write/);
  assert.doesNotMatch(dryRunWorkflow, /pull-requests: write/);

  const preMerge = readFileSync(
    new URL("../workflows/pre-merge-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(preMerge, /permissions:\s*\n\s*contents: read/);
  assert.match(preMerge, /uses: \.\/\.github\/workflows\/release-dry-run\.yml/);
  assert.match(preMerge, /release_notes: \|/);
  assert.match(preMerge, /doc-agent-release-notes-json/);
  assert.doesNotMatch(preMerge, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(preMerge, /secrets: inherit/);
  assert.doesNotMatch(preMerge, /contents: write/);
  assert.doesNotMatch(preMerge, /pull-requests: write/);

  for (const name of [
    "post-merge-dry-run.yml",
    "historical-dry-run.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /permissions:\s*\n(?:\s*#[^\n]*\n)*\s*contents: read/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/release-dry-run\.yml/);
    assert.doesNotMatch(workflow, /secrets: inherit/);
    assert.doesNotMatch(workflow, /NPM_TOKEN/);
    assert.doesNotMatch(workflow, /contents: write/);
    assert.doesNotMatch(workflow, /pull-requests: write/);
  }

  const historical = readFileSync(
    new URL("../workflows/historical-dry-run.yml", import.meta.url),
    "utf8",
  );
  assert.match(historical, /github\.event\.repository\.default_branch/);
  for (const [version, previousTag] of [
    ["0.1.15", "v0.1.14"],
    ["0.1.16", "v0.1.15"],
    ["0.1.17", "v0.1.16"],
    ["0.1.18", "v0.1.17"],
    ["0.1.19", "v0.1.18"],
  ]) {
    assert.match(
      historical,
      new RegExp(
        `version: "${version.replaceAll(".", "\\.")}"\\s+expected_previous_tag: "${previousTag.replaceAll(".", "\\.")}"\\s+expected_current_ref: "v${version.replaceAll(".", "\\.")}"`,
      ),
    );
  }

  const contractLint = readFileSync(
    new URL("../workflows/workflow-contract-lint.yml", import.meta.url),
    "utf8",
  );
  assert.match(contractLint, /permissions:\s*\n\s*contents: read/);
  assert.match(contractLint, /persist-credentials: false/);
  assert.match(contractLint, /ACTIONLINT_VERSION: "1\.7\.12"/);
  assert.match(
    contractLint,
    /ACTIONLINT_LINUX_AMD64_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"/,
  );
  assert.match(
    contractLint,
    /node --test \.github\/scripts\/validate-github-release-inventory\.test\.mjs/,
  );
  assert.doesNotMatch(contractLint, /secrets:/);
  assert.doesNotMatch(contractLint, /contents: write/);
  assert.doesNotMatch(contractLint, /pull-requests: write/);
  assert.doesNotMatch(contractLint, /uses: \.\/\.github\/workflows\/release/);
});
