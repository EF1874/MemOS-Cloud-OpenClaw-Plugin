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
  assert.doesNotMatch(workflow, /gh release view/);
});

test("real publishes are branch-gated and dry-run callers have read-only contents", () => {
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
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.doesNotMatch(workflow, /contents: write/);
    assert.doesNotMatch(workflow, /pull-requests: write/);
  }
});
