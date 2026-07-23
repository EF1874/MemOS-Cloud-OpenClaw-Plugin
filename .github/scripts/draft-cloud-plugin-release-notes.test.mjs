import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanVersion,
  categoryHintsForCommits,
  draftForInspection,
  evidenceForInspection,
  ensureSourceHint,
  postprocessDraftFromEvidence,
  RELEASE_NOTE_GUIDANCE,
  reportExternalFailureFromEnv,
  requestDraft,
  requestValidatedDraft,
  resolveCurrentRef,
  validateManualNotes,
  versionFromTag,
} from "./draft-cloud-plugin-release-notes.mjs";

const evidence = {
  repo: "MemTensor/MemOS-Cloud-OpenClaw-Plugin",
  current_tag: "v0.1.19",
  target_version: "v0.1.19",
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

test("normalizes cloud plugin versions and tags", () => {
  assert.equal(cleanVersion("v0.1.19"), "0.1.19");
  assert.equal(versionFromTag("v0.1.19"), "0.1.19");
  assert.equal(versionFromTag("openclaw-cloud-plugin-v0.1.19"), "");
});

test("uses an existing release tag as the evidence endpoint", () => {
  const exists = (ref) => ref === "v0.1.19" || ref === "manual-ref";
  assert.equal(resolveCurrentRef("v0.1.19", { requestedRef: "", refExistsImpl: exists }), "v0.1.19");
  assert.equal(resolveCurrentRef("v0.1.20", { requestedRef: "", refExistsImpl: exists }), "HEAD");
  assert.equal(resolveCurrentRef("v0.1.20", { requestedRef: "manual-ref", refExistsImpl: exists }), "manual-ref");
  assert.throws(
    () => resolveCurrentRef("v0.1.20", { requestedRef: "missing-ref", refExistsImpl: exists }),
    /RELEASE_EVIDENCE_REF does not exist/,
  );
});

test("documents cloud release-note guidance", () => {
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Added, /lifecycle hooks/);
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Improved, /prompt sanitization/);
  assert.match(RELEASE_NOTE_GUIDANCE.category_policy.Fixed, /duplicate prompt injection/);
  assert.ok(
    RELEASE_NOTE_GUIDANCE.translation_policy.some((item) =>
      item.includes("Treat text_cn as the canonical release-note wording first"),
    ),
  );
});

test("adds source-ref category hints from cloud plugin commit subjects", () => {
  const hints = categoryHintsForCommits([
    {
      short_sha: "9deb941e",
      subject: "feat: add direct-session user id support (#135)",
    },
    {
      short_sha: "59c14746",
      subject: "refactor: improve recall filter payload sanitization",
    },
    {
      short_sha: "de03ab29",
      subject: "fix: register before_prompt_build hook on supported OpenClaw hosts (#140)",
    },
    {
      short_sha: "c739e9f2",
      subject: "docs: update README",
    },
  ]);

  assert.deepEqual(
    hints.map((hint) => hint.category),
    ["Added", "Improved", "Fixed"],
  );
  assert.deepEqual(hints[0].source_refs, ["9deb941e", "#135"]);
  assert.deepEqual(hints[2].source_refs, ["de03ab29", "#140"]);
});

test("redacts full diff and prompt guidance from inspection evidence", () => {
  const inspection = evidenceForInspection({
    ...evidence,
    release_note_guidance: {
      category_policy: { Added: "private prompt details" },
      quality_policy: ["private quality prompt"],
      translation_policy: ["private translation prompt"],
      source_ref_category_hints: [{ category: "Added", source_refs: ["abc1234"] }],
    },
    important_diff: {
      "openclaw-cloud-plugin/**": "diff --git a/private.js b/private.js",
    },
  });

  assert.equal("important_diff" in inspection, false);
  assert.equal(inspection.release_note_guidance.category_policy, undefined);
  assert.deepEqual(inspection.release_note_guidance.source_ref_category_hints, [
    { category: "Added", source_refs: ["abc1234"] },
  ]);
  assert.match(inspection.redactions.important_diff, /omitted/);
});

test("redacts server debug fields from inspection draft", () => {
  const inspection = draftForInspection({
    ok: true,
    needs_review: false,
    confidence: "high",
    release_items: [
      { category: "Added", text_cn: "新增云插件配置", text_en: "Added cloud plugin configuration", source_refs: ["abc1234"] },
    ],
    coverage: { needs_review: false, required_count: 1, covered_required_count: 1, covered_refs: ["abc1234"] },
    model: "private-model",
    prompt: "private prompt",
    debug: { trace: "private debug" },
  });

  assert.equal(inspection.model, undefined);
  assert.equal(inspection.prompt, undefined);
  assert.equal(inspection.debug, undefined);
  assert.deepEqual(inspection.release_items[0].source_refs, ["abc1234"]);
});

test("postprocesses duplicate source refs into the best evidence category", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Fixed",
          text_cn: "**召回过滤修复**：解决召回过滤 payload 处理问题。",
          text_en: "**Recall Filter Fix**: Fixed recall filter payload handling.",
          source_refs: ["59c14746"],
        },
        {
          category: "Improved",
          text_cn: "**召回过滤优化**：增强召回过滤 payload 清洗稳定性。",
          text_en: "**Recall Filter Improvement**: Improved recall filter payload sanitization.",
          source_refs: ["59c14746"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "59c1474600000000000000000000000000000000",
          short_sha: "59c14746",
          subject: "refactor: improve recall filter payload sanitization",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Improved",
            source_refs: ["59c14746"],
            subject: "refactor: improve recall filter payload sanitization",
          },
        ],
      },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.release_items.length, 1);
  assert.equal(processed.release_items[0].category, "Improved");
  assert.match(processed.release_notes_markdown, /doc-agent-release-notes-json/);
});

test("postprocess fails closed when English and Chinese text cross languages", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "Plugin health dashboard",
          text_en: "插件健康看板",
          source_refs: ["abc1234", "#3001"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "abc12340000000000000000000000000000000",
          short_sha: "abc1234",
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Added",
            source_refs: ["abc1234", "#3001"],
            subject: "feat: add plugin health dashboard (#3001)",
          },
        ],
      },
    },
  );

  assert.equal(processed.ok, false);
  assert.equal(processed.needs_review, true);
  assert.equal(processed.language_issues.length, 2);
});

test("repairs postprocessed language validation issues with exact context", async () => {
  const repairEvidence = {
    commits: [
      {
        sha: "abc12340000000000000000000000000000000",
        short_sha: "abc1234",
        subject: "feat: add plugin health dashboard (#3001)",
      },
    ],
    release_note_guidance: {
      source_ref_category_hints: [
        {
          category: "Added",
          source_refs: ["abc1234", "#3001"],
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
    },
  };
  const requests = [];
  const requestImpl = async (payload) => {
    requests.push(payload);
    if (requests.length === 1) {
      return {
        ok: true,
        needs_review: false,
        release_items: [
          {
            category: "Added",
            text_cn: "Plugin health dashboard",
            text_en: "插件健康看板",
            source_refs: ["abc1234", "#3001"],
          },
        ],
        coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
        warnings: [],
      };
    }
    return {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "**插件健康看板**：新增云插件健康状态展示。",
          text_en: "**Plugin Health Dashboard**: Added cloud plugin health status visibility.",
          source_refs: ["abc1234", "#3001"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    };
  };

  const result = await requestValidatedDraft(repairEvidence, { requestImpl });

  assert.equal(result.ok, true);
  assert.equal(result.needs_review, false);
  assert.equal(result.repair_attempt_count, 1);
  assert.equal(result.validation_attempt_count, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].release_notes_repair_context.validation_report.language_issue_count, 2);
  assert.match(result.release_notes_markdown, /插件健康看板/);
});

test("stops release-note repair after two validation repair attempts", async () => {
  const repairEvidence = {
    commits: [
      {
        sha: "abc12340000000000000000000000000000000",
        short_sha: "abc1234",
        subject: "feat: add plugin health dashboard (#3001)",
      },
    ],
    release_note_guidance: {
      source_ref_category_hints: [
        {
          category: "Added",
          source_refs: ["abc1234", "#3001"],
          subject: "feat: add plugin health dashboard (#3001)",
        },
      ],
    },
  };
  const crossedDraft = {
    ok: true,
    needs_review: false,
    release_items: [
      {
        category: "Added",
        text_cn: "Plugin health dashboard",
        text_en: "插件健康看板",
        source_refs: ["abc1234", "#3001"],
      },
    ],
    coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
    warnings: [],
  };
  const requests = [];
  const result = await requestValidatedDraft(repairEvidence, {
    requestImpl: async (payload) => {
      requests.push(payload);
      return crossedDraft;
    },
    maxRepairAttempts: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(result.needs_review, true);
  assert.equal(result.repair_attempt_count, 2);
  assert.equal(result.validation_attempt_count, 3);
  assert.equal(requests.length, 3);
});

test("manual notes require bilingual evidence refs and passed coverage", () => {
  const valid = `## Changelog

### Added
- cloud memory

<!-- doc-agent-release-notes-json
{"items":[{"text_cn":"云端记忆","text_en":"Cloud memory","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`;
  assert.equal(validateManualNotes(valid), valid);
  assert.match(ensureSourceHint(valid), /source-id=openclaw-cloud-plugin/);
  assert.throws(() => validateManualNotes("## Changelog\n- unsupported"), /evidence block/);
  assert.throws(
    () =>
      validateManualNotes(`## Changelog

### Added
- cloud memory

<!-- doc-agent-release-notes-json
{"items":[{"text_cn":"Cloud memory","text_en":"云端记忆","source_refs":["abc1234"]}],"coverage":{"needs_review":false}}
-->`),
    /text_cn must contain Chinese/,
  );
});

test("reports three external-operation attempt logs with a sanitized phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-release-failure-"));
  const previous = { ...process.env };
  try {
    for (const attempt of [1, 2, 3]) writeFileSync(join(directory, `${attempt}.log`), `npm failure ${attempt}`);
    Object.assign(process.env, {
      RELEASE_FAILURE_PHASE: "npm-publish",
      RELEASE_FAILURE_ATTEMPT_DIR: directory,
      RELEASE_VERSION: "0.1.19",
      RELEASE_TAG: "v0.1.19",
      DOC_AGENT_RELEASE_FAILURE_URL: "https://example.invalid/failure",
      DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN: "test-token",
    });
    let report;
    await reportExternalFailureFromEnv({
      fetchImpl: async (_url, options) => {
        report = JSON.parse(options.body);
        return response(200, { ok: true });
      },
    });
    assert.equal(report.phase, "npm-publish");
    assert.deepEqual(report.attempts.map((item) => item.message), ["npm failure 1", "npm failure 2", "npm failure 3"]);
  } finally {
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries transient draft failures and passes prior error context", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const requests = [];
    const fetchImpl = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length < 3) return response(503, { detail: "busy" });
      return response(200, {
        ok: true,
        needs_review: false,
        release_notes_markdown: "## Changelog\n\n### Added\n- ok",
      });
    };
    const result = await requestDraft(evidence, { fetchImpl, sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].workflow_retry_context.previous_errors.length, 1);
    assert.equal(requests[2].workflow_retry_context.previous_errors.length, 2);
  } finally {
    process.env = previous;
  }
});

test("reports once after three transient failures", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_FAILURE_URL = "https://example.invalid/failure";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("/failure")) return response(200, { ok: true, sent: true });
      return response(503, { detail: "busy" });
    };
    await assert.rejects(requestDraft(evidence, { fetchImpl, sleep: async () => {} }), /attempt 3/);
    const reports = calls.filter((call) => call.url.includes("/failure"));
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].body.attempts.map((item) => item.attempt), [1, 2, 3]);
    assert.equal(reports[0].body.repository, "MemTensor/MemOS-Cloud-OpenClaw-Plugin");
  } finally {
    process.env = previous;
  }
});

test("requires configured draft URL instead of using a public fallback", async () => {
  const previous = { ...process.env };
  try {
    delete process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL;
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    await assert.rejects(
      requestDraft(evidence, { fetchImpl: async () => response(200, { ok: true }), sleep: async () => {} }),
      /DOC_AGENT_RELEASE_NOTES_DRAFT_URL secret is required/,
    );
  } finally {
    process.env = previous;
  }
});

test("sanitizes configured URLs and IPs before failure reporting", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_FAILURE_URL = "https://example.invalid/failure";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("/failure")) return response(200, { ok: true, sent: true });
      throw Object.assign(
        new Error("connect ECONNREFUSED https://example.invalid/redacted-path 127.0.0.1:4318 with Bearer test-token"),
        { retryable: true },
      );
    };
    await assert.rejects(requestDraft(evidence, { fetchImpl, sleep: async () => {} }), /attempt 3/);
    const report = calls.find((call) => call.url.includes("/failure"))?.body;
    assert.ok(report);
    assert.doesNotMatch(JSON.stringify(report), /example\.invalid|redacted-path|127\.0\.0\.1|test-token/);
    assert.match(JSON.stringify(report), /https:\/\/\*\*\*/);
  } finally {
    process.env = previous;
  }
});
