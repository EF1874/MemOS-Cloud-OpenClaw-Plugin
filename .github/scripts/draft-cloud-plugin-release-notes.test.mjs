import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanVersion,
  categoryHintsForCommits,
  compareSemver,
  docsPreviewFromDraft,
  draftForInspection,
  evidenceForInspection,
  ensureSourceHint,
  findPreviousTag,
  main,
  markdownFromDocsPreview,
  postprocessDraftFromEvidence,
  RELEASE_NOTE_GUIDANCE,
  RELEASE_NOTE_QUALITY_REQUEST,
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

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

test("compares SemVer prerelease identifiers numerically and ignores build metadata", () => {
  assert.equal(compareSemver("1.0.0-beta.10", "1.0.0-beta.9") > 0, true);
  assert.equal(compareSemver("1.0.0-beta.20", "1.0.0-beta.19") > 0, true);
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0-beta.alpha") < 0, true);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.1") > 0, true);
  assert.equal(compareSemver("1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(compareSemver("1.0.0-beta.1+build.2", "1.0.0-beta.1+build.1"), 0);
});

test("finds previous tags using SemVer precedence for prerelease numbers", () => {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "openclaw-cloud-tags-"));

  try {
    runGit(dir, ["init"]);
    runGit(dir, ["config", "user.email", "test@example.invalid"]);
    runGit(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "README.md"), "tags\n");
    runGit(dir, ["add", "README.md"]);
    runGit(dir, ["commit", "-m", "seed"]);
    runGit(dir, ["tag", "v1.0.0"]);
    runGit(dir, ["tag", "v1.0.1+build.1"]);
    for (let i = 1; i <= 19; i++) {
      runGit(dir, ["tag", `v1.0.0-beta.${i}`]);
    }

    process.chdir(dir);
    assert.equal(findPreviousTag("1.0.0-beta.10", "v1.0.0-beta.10"), "v1.0.0-beta.9");
    assert.equal(findPreviousTag("1.0.0-beta.11", "v1.0.0-beta.11"), "v1.0.0-beta.10");
    assert.equal(findPreviousTag("1.0.0-beta.20", "v1.0.0-beta.20"), "v1.0.0-beta.19");
    assert.equal(findPreviousTag("1.0.1+build.2", "v1.0.1+build.2"), "v1.0.0");
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(RELEASE_NOTE_QUALITY_REQUEST.candidate_count, 3);
  assert.equal(RELEASE_NOTE_QUALITY_REQUEST.repair_policy.max_repair_attempts, 3);
  assert.ok(
    RELEASE_NOTE_QUALITY_REQUEST.selection_policy.some((item) =>
      item.includes("Score candidates against evidence coverage"),
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

test("rewrites known system prompt handling evidence into docs-ready cloud plugin bullets", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "**增强系统提示检测**：提升了 OpenClaw 系统提示的检测和处理能力。",
          text_en: "**Enhanced System Prompt Detection**: Improved detection and handling of OpenClaw system prompts.",
          source_refs: ["d053b0a"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      important_diff: {
        "openclaw-cloud-plugin/**":
          "isForcedSystemMessage scheduled task scheduled reminder background command system prompt false positive single-line flattened",
      },
      commits: [
        {
          sha: "d053b0a000000000000000000000000000000000",
          short_sha: "d053b0a",
          subject: "feat: enhance OpenClaw system prompt detection and handling",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Added",
            source_refs: ["d053b0a"],
            subject: "feat: enhance OpenClaw system prompt detection and handling",
          },
        ],
      },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.release_items.length, 2);
  assert.deepEqual(
    processed.release_items.map((item) => item.category),
    ["Improved", "Improved"],
  );
  assert.match(processed.release_items[0].text_cn, /系统事件过滤增强/);
  assert.match(processed.release_items[1].text_cn, /系统提示识别优化/);
  assert.equal(processed.coverage.missing_required_count, 0);
  assert.deepEqual(processed.docs_categories.cn.Improvements, [
    "**系统事件过滤增强**：自动跳过定时任务、计划提醒和后台命令结果，减少记忆污染。",
    "**系统提示识别优化**：兼容单行压缩内容并降低普通消息误判概率。",
  ]);
});

test("uses evidence subjects ahead of off-topic draft text for known cloud plugin topics", () => {
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "**增强系统提示检测**：提升了 OpenClaw 系统提示的检测和处理能力。",
          text_en: "**Enhanced System Prompt Detection**: Improved detection and handling of OpenClaw system prompts.",
          source_refs: ["5152641"],
        },
      ],
      coverage: { required_count: 1, covered_required_count: 1, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits: [
        {
          sha: "5152641c4b564857f23f46b1ea81f9319ef3fd4a",
          short_sha: "5152641",
          subject: "feat: add config UI update check",
        },
      ],
      release_note_guidance: {
        source_ref_category_hints: [
          {
            category: "Added",
            source_refs: ["5152641"],
            subject: "feat: add config UI update check",
          },
        ],
      },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.release_items.length, 1);
  assert.match(processed.release_items[0].text_cn, /配置页新增更新检查/);
  assert.match(processed.release_items[0].text_en, /Update checks in settings/);
  assert.deepEqual(processed.release_items[0].source_refs, ["5152641"]);
  assert.deepEqual(processed.docs_categories.cn.Improvements, [
    "**配置页新增更新检查**：可查看版本状态，并复制对应宿主的更新重启命令。",
  ]);
});

test("splits collapsed multi-ref historical drafts into docs-ready cloud plugin topics", () => {
  const commits = [
    {
      sha: "306841f000000000000000000000000000000000",
      short_sha: "306841f",
      subject:
        "feat: update recall hook registration to use before_prompt_build for newer OpenClaw hosts and add tests for version compatibility",
    },
    {
      sha: "bf25eb70000000000000000000000000000000000",
      short_sha: "bf25eb7",
      subject:
        "feat: implement system event detection in recall and agent end hooks to skip processing for heartbeat and command events",
    },
    {
      sha: "eb2bddc000000000000000000000000000000000",
      short_sha: "eb2bddc",
      subject: "feat: add function to strip leading system notes from text input",
    },
    {
      sha: "f7c1edb000000000000000000000000000000000",
      short_sha: "f7c1edb",
      subject: "feat: refactor system event detection logic into dedicated functions for clarity and reuse",
    },
    {
      sha: "9c773370000000000000000000000000000000000",
      short_sha: "9c77337",
      subject: "feat: enhance memory section handling by adding tool memory support and simplifying filtering logic",
    },
    {
      sha: "ed52b9c000000000000000000000000000000000",
      short_sha: "ed52b9c",
      subject:
        "feat: extend system command detection to include 'clear' command and add internal prompt patterns for session management",
    },
  ];
  const processed = postprocessDraftFromEvidence(
    {
      ok: true,
      needs_review: false,
      release_items: [
        {
          category: "Added",
          text_cn: "**Hook 与记忆能力增强**：优化云插件 hook、系统事件、工具记忆和提示处理。",
          text_en: "**Hook and memory improvements**: Improves cloud plugin hooks, system events, tool memory, and prompt handling.",
          source_refs: ["306841f", "bf25eb7", "eb2bddc", "f7c1edb", "9c77337", "ed52b9c"],
        },
      ],
      coverage: { required_count: 6, covered_required_count: 6, missing_required_count: 0 },
      warnings: [],
    },
    {
      commits,
      release_note_guidance: {
        source_ref_category_hints: commits.map((commit) => ({
          category: commit.short_sha === "f7c1edb" || commit.short_sha === "ed52b9c" ? "Improved" : "Added",
          source_refs: [commit.short_sha],
          subject: commit.subject,
        })),
      },
    },
  );

  assert.equal(processed.ok, true);
  assert.equal(processed.coverage.missing_required_count, 0);
  assert.equal(processed.release_items.length, 7);
  assert.deepEqual(
    processed.release_items.map((item) => item.source_refs[0]),
    ["306841f", "bf25eb7", "eb2bddc", "f7c1edb", "9c77337", "9c77337", "ed52b9c"],
  );
  assert.match(processed.release_notes_markdown, /Recall Hook 兼容新版 OpenClaw/);
  assert.match(processed.release_notes_markdown, /系统事件自动跳过/);
  assert.match(processed.release_notes_markdown, /System Note 前缀自动剥离/);
  assert.match(processed.release_notes_markdown, /系统事件检测重构/);
  assert.match(processed.release_notes_markdown, /工具记忆全链路支持/);
  assert.match(processed.release_notes_markdown, /记忆过滤逻辑精简/);
  assert.match(processed.release_notes_markdown, /内部提示识别增强/);
});

test("generates bilingual MemOS-Docs preview from postprocessed release items", () => {
  const draft = {
    docs_categories: {
      cn: {
        Improvements: [
          "**系统事件过滤增强**：自动跳过定时任务、计划提醒和后台命令结果，减少记忆污染。",
        ],
      },
      en: {
        Improvements: [
          "**System-event filtering**: Skips scheduled tasks, reminders, and background command results to keep memory cleaner.",
        ],
      },
    },
  };
  const preview = docsPreviewFromDraft(draft, {
    targetVersion: "0.1.20",
    publishedAt: "2026-07-23T08:00:00Z",
  });
  const markdown = markdownFromDocsPreview(preview);

  assert.equal(preview.version, "v0.1.20");
  assert.equal(preview.date, "2026-07-23");
  assert.equal(preview.docs_files.cn, "content/cn/plugin-changelog.yml");
  assert.equal(preview.entries.cn.products.plugin.Improvements[0].type, "OpenClaw 云插件");
  assert.equal(preview.entries.en.products.plugin.Improvements[0].type, "OpenClaw Cloud Plugin");
  assert.match(markdown, /中文预览/);
  assert.match(markdown, /System-event filtering/);
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

test("defaults to three validation repair attempts before failing closed", async () => {
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
  });

  assert.equal(result.ok, false);
  assert.equal(result.needs_review, true);
  assert.equal(result.repair_attempt_count, 3);
  assert.equal(result.validation_attempt_count, 4);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].release_notes_repair_context.max_repair_attempts, 3);
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

test("manual release notes also produce docs preview outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-plugin-manual-preview-"));
  const previous = { ...process.env };
  try {
    const outputPath = join(directory, "github-output.txt");
    const notesPath = join(directory, "release-notes.md");
    Object.assign(process.env, {
      RELEASE_VERSION: "0.1.20",
      RELEASE_NOTES_FILE: notesPath,
      MANUAL_RELEASE_NOTES: `## Changelog

### Improved
- **系统事件过滤增强**：自动跳过定时任务、计划提醒和后台命令结果，减少记忆污染。

<!-- doc-agent-release-notes-json
{"items":[{"category":"Improved","text_cn":"**系统事件过滤增强**：自动跳过定时任务、计划提醒和后台命令结果，减少记忆污染。","text_en":"**System-event filtering**: Skips scheduled tasks, reminders, and background command results to keep memory cleaner.","source_refs":["d053b0a"]}],"coverage":{"needs_review":false,"required_count":1,"covered_required_count":1,"missing_required_count":0}}
-->`,
      GITHUB_OUTPUT: outputPath,
    });

    await main();

    const output = readFileSync(outputPath, "utf8");
    const match = output.match(/docs_preview_markdown_file<<__DOC_AGENT_EOF__\n([\s\S]*?)\n__DOC_AGENT_EOF__/);
    assert.ok(match, "docs preview markdown output should be written");
    const preview = readFileSync(match[1], "utf8");
    assert.match(preview, /MemOS-Docs Plugin Changelog Preview/);
    assert.match(preview, /OpenClaw 云插件/);
    assert.match(preview, /System-event filtering/);
    assert.match(readFileSync(notesPath, "utf8"), /doc-agent: source-id=openclaw-cloud-plugin/);
  } finally {
    process.env = previous;
    rmSync(directory, { recursive: true, force: true });
  }
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

test("passes release-note quality request to the draft service", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    let requestBody;
    const result = await requestDraft(
      {
        ...evidence,
        release_note_quality_request: RELEASE_NOTE_QUALITY_REQUEST,
      },
      {
        fetchImpl: async (_url, options) => {
          requestBody = JSON.parse(options.body);
          return response(200, {
            ok: true,
            needs_review: false,
            release_notes_markdown: "## Changelog\n\n### Improved\n- ok",
          });
        },
        sleep: async () => {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(requestBody.release_note_quality_request.candidate_count, 3);
    assert.equal(requestBody.release_note_quality_request.repair_policy.max_repair_attempts, 3);
    assert.match(requestBody.release_note_quality_request.selection_policy.join("\n"), /docs-preview readability/);
  } finally {
    process.env = previous;
  }
});

test("keeps structured needs-review drafts for local validation instead of failing immediately", async () => {
  const previous = { ...process.env };
  try {
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_URL = "https://example.invalid/draft";
    process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN = "test-token";
    const result = await requestDraft(evidence, {
      fetchImpl: async () =>
        response(200, {
          ok: false,
          needs_review: true,
          warnings: ["English output contains CJK text"],
          release_items: [
            {
              category: "Improved",
              text_cn: "**系统事件过滤增强**：自动跳过后台命令结果。",
              text_en: "**System-event Filtering**：自动跳过后台命令结果。",
              source_refs: ["abc1234"],
            },
          ],
          coverage: { needs_review: true, required_count: 1, covered_required_count: 1, missing_required_count: 0 },
        }),
      sleep: async () => {},
    });
    assert.equal(result.needs_review, true);
    assert.equal(result.release_items.length, 1);
  } finally {
    process.env = previous;
  }
});

test("repairs mixed-language structured drafts by sending validation context back to the drafter", async () => {
  const requests = [];
  const result = await requestValidatedDraft(evidence, {
    requestImpl: async (requestEvidence) => {
      requests.push(requestEvidence);
      if (requests.length === 1) {
        return {
          ok: false,
          needs_review: true,
          release_items: [
            {
              category: "Improved",
              text_cn: "**系统事件过滤增强**：自动跳过后台命令结果。",
              text_en: "**System-event Filtering**：自动跳过后台命令结果。",
              source_refs: ["abc1234"],
            },
          ],
          coverage: { needs_review: true, required_count: 0, covered_required_count: 0, missing_required_count: 0 },
        };
      }
      assert.equal(requestEvidence.release_notes_repair_context.validation_report.language_issue_count, 1);
      return {
        ok: true,
        needs_review: false,
        release_items: [
          {
            category: "Improved",
            text_cn: "**系统事件过滤增强**：自动跳过后台命令结果。",
            text_en: "**System-event Filtering**: Skips background command results automatically.",
            source_refs: ["abc1234"],
          },
        ],
        coverage: { needs_review: false, required_count: 0, covered_required_count: 0, missing_required_count: 0 },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.needs_review, false);
  assert.equal(result.validation_attempt_count, 2);
  assert.equal(result.repair_attempt_count, 1);
  assert.match(result.release_notes_markdown, /Skips scheduled tasks, reminders, and background command results/);
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
