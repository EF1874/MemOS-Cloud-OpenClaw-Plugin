#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { cleanVersion, compareSemver, parseSemver } from "../../lib/semver.js";

export { cleanVersion, compareSemver, parseSemver };

export const PRODUCT_ID = "openclaw-cloud-plugin";
export const PRODUCT_TITLE = {
  zh: "OpenClaw 云插件",
  en: "OpenClaw Cloud Plugin",
};
export const RELEASE_NOTE_GUIDANCE = {
  category_policy: {
    Added:
      "Use for newly exposed user-facing capabilities, configuration entries, lifecycle hooks, agent integrations, or memory workflow modes.",
    Improved:
      "Use for recall/add-memory quality, prompt sanitization, session or user-id resolution, telemetry hardening, packaging, compatibility, or reliability improvements when the evidence is not primarily a broken-behavior fix.",
    Fixed:
      "Use for concrete broken behavior, regressions, auth or endpoint handling bugs, duplicate prompt injection, failed retries, or configuration that existed but did not take effect.",
  },
  quality_policy: [
    "Prefer Added / Improved / Fixed sections when the evidence supports all three; omit a section only when evidence is insufficient.",
    "Keep bullets short, product-facing, and evidence-backed; do not mention internal file names unless they are the feature name users recognize.",
    "Do not collapse newly added capability and a bug fix in the same subsystem into one item when both are separately evidenced.",
    "Do not describe release automation, tests, or packaging as a user-facing plugin capability unless the evidence changes the published plugin behavior.",
  ],
  translation_policy: [
    "Treat text_cn as the canonical release-note wording first, then translate text_cn into text_en.",
    "Do not independently invent English facts beyond the Chinese canonical bullet and its source_refs.",
    "Keep category and source_refs identical between Chinese and English outputs.",
    "text_cn must contain Chinese text; text_en must not contain Chinese/CJK characters.",
  ],
};

const REPOSITORY = "MemTensor/MemOS-Cloud-OpenClaw-Plugin";
const CURRENT_TAG_PREFIX = "v";
const RELEASE_NOTES_MARKER = "doc-agent-release-notes-json";
const RELEASE_CATEGORY_ORDER = ["Added", "Improved", "Fixed"];
const MAX_DRAFT_REPAIR_ATTEMPTS = 3;
export const RELEASE_NOTE_QUALITY_REQUEST = {
  schema: "memos.plugin.release_notes.quality_request.v1",
  candidate_count: 3,
  selection_policy: [
    "Generate multiple candidate release-note drafts when the draft service supports candidate self-evaluation.",
    "Score candidates against evidence coverage, source_ref validity, bilingual language separation, product-facing clarity, and docs-preview readability.",
    "Return only the best candidate in release_items/release_notes_markdown; include candidate scoring metadata only in debug fields when available.",
  ],
  repair_policy: {
    max_repair_attempts: MAX_DRAFT_REPAIR_ATTEMPTS,
    use_validation_report: true,
    fail_closed_after_exhaustion: true,
  },
};
const RELEASE_TO_DOC_CATEGORY = {
  Added: "New Features",
  Improved: "Improvements",
  Fixed: "Bug Fixes",
};
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

function fail(message) {
  throw new Error(String(message));
}

function warn(message) {
  console.error(`::warning::${message}`);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function displayVersion(raw) {
  const value = cleanVersion(raw);
  return value ? `v${value}` : "";
}

export function versionFromTag(tag) {
  const value = String(tag || "").trim();
  if (!value.startsWith(CURRENT_TAG_PREFIX)) return "";
  return cleanVersion(value.slice(CURRENT_TAG_PREFIX.length));
}

function gitShowJson(ref, path) {
  try {
    return JSON.parse(git(["show", `${ref}:${path}`]));
  } catch {
    return {};
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function tagInfo(ref) {
  const text = git(["show", "--no-patch", "--format=%H%n%ci%n%s", commitRef(ref)]);
  const [sha = "", date = "", subject = ""] = text.split("\n");
  return { tag: ref, sha, date, subject };
}

function commitRef(ref) {
  return `${ref}^{commit}`;
}

function refInfo(ref, tagLabel) {
  const info = tagInfo(ref);
  return { ...info, tag: tagLabel || ref, ref };
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function resolveCurrentRef(
  currentTag,
  { requestedRef = process.env.RELEASE_EVIDENCE_REF || "", refExistsImpl = refExists } = {},
) {
  const explicit = String(requestedRef || "").trim();
  if (explicit) {
    if (!refExistsImpl(explicit)) {
      fail(`RELEASE_EVIDENCE_REF does not exist or is not a commit: ${explicit}`);
    }
    return explicit;
  }
  if (currentTag && refExistsImpl(currentTag)) return currentTag;
  return "HEAD";
}

function localProductTags() {
  return git(["tag", "--list", "v*"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: versionFromTag(tag) }))
    .filter((item) => item.version && parseSemver(item.version));
}

function listProductTags() {
  const existingTags = localProductTags();
  try {
    const remotes = git(["remote"]).split("\n").map((item) => item.trim()).filter(Boolean);
    if (remotes.includes("origin")) {
      git(["fetch", "--tags", "--force", "origin"], { stdio: ["ignore", "ignore", "ignore"] });
    }
  } catch {
    if (existingTags.length === 0) {
      warn("Failed to fetch tags from origin; using locally available tags.");
    }
  }

  return localProductTags();
}

export function findPreviousTag(targetVersion, currentTag) {
  const candidates = listProductTags()
    .filter((item) => item.tag !== currentTag)
    .filter((item) => compareSemver(item.version, targetVersion) < 0)
    .sort((a, b) => compareSemver(b.version, a.version));
  return candidates[0]?.tag || "";
}

function parseCommits(previousTag, currentRef) {
  const text = git(["log", "--format=%H%x09%h%x09%s", "--no-merges", `${previousTag}..${currentRef}`]);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", subject = ""] = line.split("\t");
      return { sha, short_sha: shortSha, subject };
    });
}

function parseChangedFiles(previousTag, currentRef) {
  const text = git(["diff", "--name-status", `${previousTag}..${currentRef}`]);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const item = { status: parts[0], path: parts[parts.length - 1] };
      if (parts.length === 3) item.old_path = parts[1];
      return item;
    });
}

function packageChanges(previousTag, currentRef) {
  const before = gitShowJson(previousTag, "package.json");
  const after = currentRef === "HEAD" ? readJsonFile("package.json") : gitShowJson(currentRef, "package.json");
  return ["name", "version"]
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function extractPullRequests(commits, repo = process.env.GITHUB_REPOSITORY || REPOSITORY) {
  const seen = new Set();
  for (const commit of commits) {
    for (const match of String(commit.subject || "").matchAll(/#(\d+)/g)) {
      seen.add(match[1]);
    }
  }
  return [...seen].map((number) => ({
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  }));
}

function refsForGuidance(commit) {
  const refs = [];
  if (commit.short_sha) refs.push(commit.short_sha);
  for (const match of String(commit.subject || "").matchAll(/#(\d+)/g)) {
    const value = `#${match[1]}`;
    if (!refs.includes(value)) refs.push(value);
  }
  return refs;
}

function categoryHintForSubject(subject) {
  const value = String(subject || "");
  const lower = value.toLowerCase();
  if (
    lower.startsWith("release:") ||
    /^chore(\([^)]+\))?:\s*(release|version|bump)\b/i.test(value) ||
    /^test(\([^)]+\))?:/i.test(value) ||
    /^docs(\([^)]+\))?:/i.test(value)
  ) {
    return null;
  }
  if (/^(feat|feature|add)(\([^)]+\))?:|^add\s+/i.test(value)) {
    return {
      category: "Added",
      reason: "new user-facing cloud plugin capability, configuration, or lifecycle support",
    };
  }
  if (/^(perf|performance|refactor|improve|enhance)(\([^)]+\))?:/i.test(value)) {
    return {
      category: "Improved",
      reason: "performance, maintainability, compatibility, or reliability improvement",
    };
  }
  if (
    /recall filter|prompt|sanitize|query strip|session|user[-_ ]?id|hook|registration|telemetry|rum|pack|publish|sync-version/i.test(
      value,
    ) &&
    !/^(fix|hotfix|bugfix)(\([^)]+\))?:|^fix\s+#\d+/i.test(value)
  ) {
    return {
      category: "Improved",
      reason: "cloud plugin integration, prompt, packaging, or telemetry robustness improvement",
    };
  }
  if (/^(fix|hotfix|bugfix)(\([^)]+\))?:|^fix\s+#\d+/i.test(value)) {
    return {
      category: "Fixed",
      reason: "specific cloud plugin bug fix",
    };
  }
  return null;
}

export function categoryHintsForCommits(commits) {
  return commits
    .map((commit) => {
      const hint = categoryHintForSubject(commit.subject);
      const sourceRefs = refsForGuidance(commit);
      if (!hint || sourceRefs.length === 0) return null;
      return {
        ...hint,
        source_refs: sourceRefs,
        subject: commit.subject,
      };
    })
    .filter(Boolean);
}

export function releaseNoteGuidanceForCommits(commits) {
  return {
    ...RELEASE_NOTE_GUIDANCE,
    source_ref_category_hints: categoryHintsForCommits(commits),
    source_ref_hint_policy:
      "Treat source_ref_category_hints as advisory classification hints grounded in evidence. " +
      "Use them to cover important feat/fix/perf/refactor commits without inventing product facts.",
  };
}

export function collectEvidence({ targetVersion, currentTag, previousTag, currentRef = "HEAD" }) {
  const commits = parseCommits(previousTag, currentRef);
  const changedFiles = parseChangedFiles(previousTag, currentRef);
  const diffRange = `${previousTag}..${currentRef}`;
  const repo = process.env.GITHUB_REPOSITORY || REPOSITORY;
  const importantDiff = git(["diff", "--unified=2", diffRange]).slice(0, 24000);

  return {
    product_id: PRODUCT_ID,
    product_title: PRODUCT_TITLE,
    release_note_quality_request: RELEASE_NOTE_QUALITY_REQUEST,
    release_note_guidance: releaseNoteGuidanceForCommits(commits),
    repo,
    previous_tag: previousTag,
    current_tag: currentTag,
    current_ref: currentRef,
    diff_range: diffRange,
    target_version: displayVersion(targetVersion),
    git_ref: git(["rev-parse", "--short=12", commitRef(currentRef)]),
    previous: tagInfo(previousTag),
    current: refInfo(currentRef, currentTag),
    commits,
    pull_requests: extractPullRequests(commits, repo),
    changed_files: changedFiles,
    diff_stat: git(["diff", "--stat", diffRange]),
    important_diff: {
      "openclaw-cloud-plugin/**": importantDiff,
    },
    package_changes: packageChanges(previousTag, currentRef),
    test_changes: changedFiles.filter((item) => item.path.startsWith("test/")),
    docs_changes: changedFiles.filter((item) => /(^|\/)(README|docs)/i.test(item.path)),
  };
}

export function evidenceForInspection(evidence) {
  const guidance = evidence?.release_note_guidance || {};
  const {
    release_note_guidance: _releaseNoteGuidance,
    release_note_quality_request: _releaseNoteQualityRequest,
    important_diff: _importantDiff,
    ...publicEvidence
  } = evidence || {};
  return {
    ...publicEvidence,
    release_note_guidance: {
      source_ref_category_hints: Array.isArray(guidance.source_ref_category_hints)
        ? guidance.source_ref_category_hints
        : [],
    },
    redactions: {
      important_diff: "omitted from public workflow artifacts; sent only to the configured draft service",
      release_note_prompt_guidance: "omitted from public workflow artifacts",
      release_note_quality_request: "omitted from public workflow artifacts; sent only to the configured draft service",
    },
  };
}

export function draftForInspection(draft) {
  return {
    ok: Boolean(draft?.ok),
    needs_review: Boolean(draft?.needs_review),
    confidence: draft?.confidence || "",
    release_items: Array.isArray(draft?.release_items) ? draft.release_items : [],
    docs_categories: draft?.docs_categories || { cn: {}, en: {} },
    coverage: {
      needs_review: Boolean(draft?.coverage?.needs_review),
      required_count: Number(draft?.coverage?.required_count || 0),
      covered_required_count: Number(draft?.coverage?.covered_required_count || 0),
      missing_required_count: Number(draft?.coverage?.missing_required_count || 0),
      covered_refs: Array.isArray(draft?.coverage?.covered_refs) ? draft.coverage.covered_refs : [],
      missing_required: Array.isArray(draft?.coverage?.missing_required) ? draft.coverage.missing_required : [],
      invalid_item_refs: Array.isArray(draft?.coverage?.invalid_item_refs) ? draft.coverage.invalid_item_refs : [],
    },
    warnings: Array.isArray(draft?.warnings) ? draft.warnings : [],
    language_issues: Array.isArray(draft?.language_issues) ? draft.language_issues : [],
    postprocess: draft?.postprocess || {},
    validation_report: draft?.validation_report || {},
    validation_attempt_count: Number(draft?.validation_attempt_count || 0),
    repair_attempt_count: Number(draft?.repair_attempt_count || 0),
    repair_attempts: Array.isArray(draft?.repair_attempts) ? draft.repair_attempts : [],
    redactions: {
      server_debug_fields: "omitted from public workflow artifacts",
      model_and_prompt_details: "omitted from public workflow artifacts",
    },
  };
}

function appendOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  writeFileSync(outputPath, `${name}<<__DOC_AGENT_EOF__\n${value}\n__DOC_AGENT_EOF__\n`, {
    flag: "a",
  });
}

export function ensureSourceHint(notes) {
  const hint = `<!-- doc-agent: source-id=${PRODUCT_ID} -->`;
  return notes.includes("doc-agent: source-id=") ? notes : `${notes.trim()}\n\n${hint}\n`;
}

function normalizeReleaseCategory(value) {
  const text = String(value || "").trim();
  return RELEASE_CATEGORY_ORDER.includes(text) ? text : "";
}

function normalizeSourceRef(value) {
  const text = String(value || "").trim().replace(/^[`[(\s]+|[`)\],.;\s]+$/g, "");
  if (/^#\d+$/.test(text)) return text;
  if (/^[a-fA-F0-9]{7,40}$/.test(text)) return text.toLowerCase();
  if (/^\d{2,}$/.test(text)) return `#${text}`;
  return "";
}

function normalizeSourceRefs(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || "").match(/#\d+|[a-fA-F0-9]{7,40}/g) || [];
  const refs = [];
  for (const value of values) {
    const ref = normalizeSourceRef(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function refsForCommit(commit) {
  const refs = [];
  for (const ref of [commit?.short_sha, commit?.sha]) {
    const normalized = normalizeSourceRef(ref);
    if (normalized && !refs.includes(normalized)) refs.push(normalized);
  }
  for (const match of String(commit?.subject || "").matchAll(/#(\d+)/g)) {
    const ref = `#${match[1]}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function normalizeReleaseItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const category = normalizeReleaseCategory(raw.category);
  const textCn = String(raw.text_cn || "").trim().replace(/^-+\s*/, "");
  const textEn = String(raw.text_en || "").trim().replace(/^-+\s*/, "");
  const sourceRefs = normalizeSourceRefs(raw.source_refs);
  if (!category || !textCn || !textEn || sourceRefs.length === 0) return null;
  return {
    category,
    text_cn: textCn,
    text_en: textEn,
    source_refs: sourceRefs,
  };
}

function buildSourceRefIndex(evidence) {
  const refToGroup = new Map();
  const groups = new Map();
  const knownRefs = new Set();

  for (const commit of evidence?.commits || []) {
    for (const ref of refsForCommit(commit)) knownRefs.add(ref);
  }

  for (const hint of evidence?.release_note_guidance?.source_ref_category_hints || []) {
    const refs = normalizeSourceRefs(hint.source_refs);
    const category = normalizeReleaseCategory(hint.category);
    if (refs.length === 0 || !category) continue;
    const groupKey = refs[0];
    for (const ref of refs) {
      knownRefs.add(ref);
      refToGroup.set(ref, groupKey);
    }
    groups.set(groupKey, {
      key: groupKey,
      category,
      refs,
      subject: String(hint.subject || ""),
      reason: String(hint.reason || ""),
    });
  }

  return { refToGroup, groups, knownRefs };
}

function groupKeyForRef(ref, refToGroup) {
  return refToGroup.get(ref) || ref;
}

function groupKeysForItem(item, refToGroup) {
  const keys = [];
  for (const ref of item.source_refs || []) {
    const key = groupKeyForRef(ref, refToGroup);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function subjectsForItem(item, index) {
  return groupKeysForItem(item, index.refToGroup)
    .map((key) => index.groups.get(key)?.subject || "")
    .filter(Boolean)
    .join(" ");
}

function evidenceTextForItem(item, index) {
  return `${subjectsForItem(item, index)}\n${item.text_cn || ""}\n${item.text_en || ""}`;
}

function knownReleaseItemsForItem(item, index, { allowSplit = true } = {}) {
  if (allowSplit && item.source_refs.length > 1) {
    const splitItems = item.source_refs.flatMap((ref) =>
      knownReleaseItemsForItem({ ...item, source_refs: [ref] }, index, { allowSplit: false }),
    );
    const changedByEvidence = splitItems.some(
      (split) =>
        split.category !== item.category ||
        split.text_cn !== item.text_cn ||
        split.text_en !== item.text_en,
    );
    if (changedByEvidence) return dedupeReleaseItems(splitItems);
  }

  const subjectBlob = subjectsForItem(item, index).toLowerCase();
  const blob = evidenceTextForItem(item, index).toLowerCase();
  const refs = [...item.source_refs];
  const rewrite = (category, textCn, textEn) => ({
    ...item,
    category,
    text_cn: textCn,
    text_en: textEn,
    source_refs: refs,
  });

  const semverPattern = /semver|prerelease|previous tag|compare release tags|beta\.10|beta\.20|update checker|check-update/;
  const configUpdatePattern = /config ui update check|update check|version status|host-specific update|restart command|copy.*restart/;
  const memorySourcePattern = /memos_source|memory source|platform|windows|macos|linux|darwin/;
  const hookPattern = /activation hooks|capability declaration|hook policy|before_prompt_build|recall hook|add memory hook|hook registration/;
  const recallFilterPattern = /recall filter|payload sanit|query strip|prompt sanit|memory pollution/;
  const toolMemoryPattern = /tool memory|tool_memories|assistant\.tool_calls|toolresult/;
  const memoryFilteringPattern = /buildmemorysections|memory section handling|filtering logic|relevance-threshold|relevance threshold/;
  const systemNotePattern = /system note|leading system notes|interruption notes/;
  const systemEventSkipPattern = /implement system event detection|skip processing for heartbeat|heartbeat and command events|heartbeat polls|system commands/;
  const systemEventRefactorPattern = /refactor system event detection|extend system command detection|system-command detection|internal prompt patterns/;
  const telemetryPattern = /telemetry credentials|memos_arms|arms|rum|observability|generate telemetry credentials/;
  const systemPromptPattern =
    /system prompt detection and handling|scheduled task|scheduled reminder|background command|system event|isforcedsystemmessage|system prompt/;

  if (/recall hook registration.*before_prompt_build|before_prompt_build.*newer openclaw|version compatibility/.test(subjectBlob)) {
    return [
      rewrite(
        "Added",
        "**Recall Hook 兼容新版 OpenClaw**：当宿主版本支持阶段化 Hook 时，召回逻辑自动迁移至 `before_prompt_build`，旧版宿主继续兼容 `before_agent_start`。",
        "**Recall Hook compatibility for modern OpenClaw hosts**: Moves recall logic to `before_prompt_build` on hosts that support phased hooks while keeping `before_agent_start` compatibility for legacy hosts.",
      ),
    ];
  }

  if (systemEventSkipPattern.test(subjectBlob)) {
    return [
      rewrite(
        "Added",
        "**系统事件自动跳过**：召回与写入阶段自动识别并跳过心跳探测、系统命令等系统事件，保持记忆数据纯净。",
        "**Automatic system-event skipping**: Detects and skips heartbeat polls, system commands, and other system events during recall and write phases to keep memory records clean.",
      ),
    ];
  }

  if (toolMemoryPattern.test(subjectBlob)) {
    const items = [
      rewrite(
        "Added",
        "**工具记忆全链路支持**：召回阶段注入 `<tool_memories>`，写入阶段支持 `assistant.tool_calls` 与 `toolResult` 消息转换，统一写入 MemOS 标准消息结构。",
        "**End-to-end Tool Memory support**: Injects `<tool_memories>` during recall and converts `assistant.tool_calls` plus `toolResult` messages into the standard MemOS message structure during write.",
      ),
    ];
    if (memoryFilteringPattern.test(subjectBlob)) {
      items.push(
        rewrite(
          "Improved",
          "**记忆过滤逻辑精简**：整合记忆片段构建中的重复过滤判断，降低无关内容进入上下文的概率。",
          "**Memory filtering cleanup**: Consolidates duplicated filtering logic while building memory sections to reduce irrelevant context injection.",
        ),
      );
    }
    return items;
  }

  if (systemNotePattern.test(subjectBlob)) {
    return [
      rewrite(
        "Added",
        "**System Note 前缀自动剥离**：自动剔除上轮 Agent 中断提示词，提升召回查询与入库数据准确性。",
        "**System Note prefix stripping**: Removes previous-run interruption notes to improve recall queries and stored-memory accuracy.",
      ),
    ];
  }

  if (/extend system command detection|include 'clear' command|internal prompt patterns/.test(subjectBlob)) {
    return [
      rewrite(
        "Improved",
        "**内部提示识别增强**：扩展 `clear` 命令和内部提示模式识别，减少系统命令类内容进入记忆流程。",
        "**Internal prompt detection**: Extends `clear` command and internal prompt pattern detection to keep system-command content out of the memory flow.",
      ),
    ];
  }

  if (systemEventRefactorPattern.test(subjectBlob)) {
    return [
      rewrite(
        "Improved",
        "**系统事件检测重构**：提取心跳、系统命令和内部提示识别逻辑，并降低正常用户消息误判概率。",
        "**System-event detection refactor**: Extracts heartbeat, system-command, and internal-prompt detection helpers to reduce false positives on normal user messages.",
      ),
    ];
  }

  const subjectFirstRules = [
    [semverPattern, () => [
      rewrite(
        "Fixed",
        "**版本比较边界修复**：使用标准 SemVer precedence 选择上一版本并检测更新，避免 beta.10、beta.20 等预发布版本被错误排序。",
        "**Version comparison boundaries**: Uses SemVer precedence for previous-tag selection and update checks so beta.10, beta.20, and similar prereleases sort correctly.",
      ),
    ]],
    [configUpdatePattern, () => [
      rewrite(
        "Improved",
        "**配置页新增更新检查**：可查看版本状态，并复制对应宿主的更新重启命令。",
        "**Update checks in settings**: Shows version status and lets users copy host-specific update or restart commands.",
      ),
    ]],
    [memorySourcePattern, () => [
      rewrite(
        "Added",
        "**跨平台记忆来源识别**：自动区分 Windows、macOS、Linux 的记忆数据。",
        "**Platform-aware memory source labeling**: Distinguishes Windows, macOS, and Linux memory data automatically.",
      ),
    ]],
  ];

  for (const [pattern, buildItems] of subjectFirstRules) {
    if (pattern.test(subjectBlob)) return buildItems();
  }

  if (hookPattern.test(subjectBlob)) {
    if (/before_prompt_build|hook registration|registration/.test(subjectBlob)) {
      return [
        rewrite(
          "Fixed",
          "**Hook 注册兼容性修复**：在支持的 OpenClaw 宿主上正确注册回忆 hook，避免提示构建阶段缺失记忆召回。",
          "**Hook registration compatibility**: Registers recall hooks correctly on supported OpenClaw hosts so memory recall is available during prompt construction.",
        ),
      ];
    }
    return [
      rewrite(
        "Added",
        "**插件 Hook 能力声明**：补充插件激活与记忆相关 hook 声明，让宿主能够按权限策略启用云端记忆能力。",
        "**Plugin hook capability declarations**: Adds activation and memory hook declarations so hosts can enable cloud memory through the permission policy.",
      ),
    ];
  }

  if (recallFilterPattern.test(subjectBlob)) {
    return [
      rewrite(
        "Improved",
        "**召回过滤与提示清洗优化**：增强召回请求和提示内容清洗，降低系统消息或无关参数进入记忆流程的概率。",
        "**Recall filtering and prompt sanitization**: Improves recall-request and prompt cleanup to reduce system-message or irrelevant-parameter leakage into memory flows.",
      ),
    ];
  }

  if (telemetryPattern.test(subjectBlob)) {
    return [
      rewrite(
        "Improved",
        "**遥测凭据打包校验**：发布前校验遥测凭据生成状态，避免半配置密钥导致观测能力缺失或包内容不完整。",
        "**Telemetry credential packaging**: Validates telemetry credential generation before release to avoid partial secret configuration and incomplete observability packaging.",
      ),
    ];
  }

  if (systemPromptPattern.test(subjectBlob) || systemPromptPattern.test(blob)) {
    const items = [];
    if (
      /system prompt detection and handling|scheduled task|scheduled reminder|background command|system event|isforcedsystemmessage/.test(
        blob,
      )
    ) {
      items.push(
        rewrite(
          "Improved",
          "**系统事件过滤增强**：自动跳过定时任务、计划提醒和后台命令结果，减少记忆污染。",
          "**System-event filtering**: Skips scheduled tasks, reminders, and background command results to keep memory cleaner.",
        ),
      );
    }
    if (/system prompt detection and handling|system prompt|single-line|flattened|false positive|prompt detection/.test(blob)) {
      items.push(
        rewrite(
          "Improved",
          "**系统提示识别优化**：兼容单行压缩内容并降低普通消息误判概率。",
          "**System prompt detection**: Supports flattened single-line prompts and reduces false positives on regular messages.",
        ),
      );
    }
    if (items.length > 0) return items;
  }

  if (semverPattern.test(blob)) {
    return [
      rewrite(
        "Fixed",
        "**版本比较边界修复**：使用标准 SemVer precedence 选择上一版本并检测更新，避免 beta.10、beta.20 等预发布版本被错误排序。",
        "**Version comparison boundaries**: Uses SemVer precedence for previous-tag selection and update checks so beta.10, beta.20, and similar prereleases sort correctly.",
      ),
    ];
  }

  if (configUpdatePattern.test(blob)) {
    return [
      rewrite(
        "Improved",
        "**配置页新增更新检查**：可查看版本状态，并复制对应宿主的更新重启命令。",
        "**Update checks in settings**: Shows version status and lets users copy host-specific update or restart commands.",
      ),
    ];
  }

  if (memorySourcePattern.test(blob)) {
    return [
      rewrite(
        "Added",
        "**跨平台记忆来源识别**：自动区分 Windows、macOS、Linux 的记忆数据。",
        "**Platform-aware memory source labeling**: Distinguishes Windows, macOS, and Linux memory data automatically.",
      ),
    ];
  }

  if (hookPattern.test(blob)) {
    if (/before_prompt_build|hook registration|registration/.test(blob)) {
      return [
        rewrite(
          "Fixed",
          "**Hook 注册兼容性修复**：在支持的 OpenClaw 宿主上正确注册回忆 hook，避免提示构建阶段缺失记忆召回。",
          "**Hook registration compatibility**: Registers recall hooks correctly on supported OpenClaw hosts so memory recall is available during prompt construction.",
        ),
      ];
    }
    return [
      rewrite(
        "Added",
        "**插件 Hook 能力声明**：补充插件激活与记忆相关 hook 声明，让宿主能够按权限策略启用云端记忆能力。",
        "**Plugin hook capability declarations**: Adds activation and memory hook declarations so hosts can enable cloud memory through the permission policy.",
      ),
    ];
  }

  if (recallFilterPattern.test(blob)) {
    return [
      rewrite(
        "Improved",
        "**召回过滤与提示清洗优化**：增强召回请求和提示内容清洗，降低系统消息或无关参数进入记忆流程的概率。",
        "**Recall filtering and prompt sanitization**: Improves recall-request and prompt cleanup to reduce system-message or irrelevant-parameter leakage into memory flows.",
      ),
    ];
  }

  if (telemetryPattern.test(blob)) {
    return [
      rewrite(
        "Improved",
        "**遥测凭据打包校验**：发布前校验遥测凭据生成状态，避免半配置密钥导致观测能力缺失或包内容不完整。",
        "**Telemetry credential packaging**: Validates telemetry credential generation before release to avoid partial secret configuration and incomplete observability packaging.",
      ),
    ];
  }

  return [item];
}

function expandKnownReleaseItems(items, index) {
  let expandedKnownItems = 0;
  const expanded = [];
  for (const item of items) {
    const knownItems = knownReleaseItemsForItem(item, index);
    if (knownItems.length !== 1 || knownItems[0] !== item) {
      expandedKnownItems += Math.max(1, knownItems.length);
    }
    expanded.push(...knownItems);
  }
  return {
    items: dedupeReleaseItems(expanded),
    expandedKnownItems,
  };
}

function bestHintCategoryForItem(item, index) {
  const categories = [];
  for (const key of groupKeysForItem(item, index.refToGroup)) {
    const category = index.groups.get(key)?.category;
    if (category && !categories.includes(category)) categories.push(category);
  }
  if (categories.length === 1) return categories[0];
  return "";
}

function scoreOwnerCandidate(item, group, sourceGroupCount, order) {
  let score = 0;
  if (item.category === group.category) score += 100;
  if (sourceGroupCount === 1) score += 20;
  score -= sourceGroupCount;
  score -= order / 1000;
  return score;
}

function dedupeSourceRefsByBestCategory(items, index) {
  const candidatesByGroup = new Map();
  for (const [order, item] of items.entries()) {
    for (const groupKey of groupKeysForItem(item, index.refToGroup)) {
      const group = index.groups.get(groupKey);
      if (!group) continue;
      const sourceGroupCount = groupKeysForItem(item, index.refToGroup).length;
      const candidates = candidatesByGroup.get(groupKey) || [];
      candidates.push({ item, order, sourceGroupCount });
      candidatesByGroup.set(groupKey, candidates);
    }
  }

  const ownerByGroup = new Map();
  for (const [groupKey, candidates] of candidatesByGroup.entries()) {
    const group = index.groups.get(groupKey);
    if (!group) continue;
    const sorted = [...candidates].sort((a, b) => {
      const scoreDelta =
        scoreOwnerCandidate(b.item, group, b.sourceGroupCount, b.order) -
        scoreOwnerCandidate(a.item, group, a.sourceGroupCount, a.order);
      return scoreDelta || a.order - b.order;
    });
    ownerByGroup.set(groupKey, sorted[0].item);
  }

  let removedDuplicateRefs = 0;
  let droppedItems = 0;
  const filtered = [];
  for (const item of items) {
    const refs = [];
    for (const ref of item.source_refs) {
      const groupKey = groupKeyForRef(ref, index.refToGroup);
      const owner = ownerByGroup.get(groupKey);
      if (!owner || owner === item) {
        if (!refs.includes(ref)) refs.push(ref);
      } else {
        removedDuplicateRefs += 1;
      }
    }
    if (refs.length === 0) {
      droppedItems += 1;
      continue;
    }
    filtered.push({ ...item, source_refs: refs });
  }
  return { items: filtered, removedDuplicateRefs, droppedItems };
}

function dedupeReleaseItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.category}\n${item.text_cn}\n${item.text_en}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, source_refs: [...item.source_refs] });
      continue;
    }
    for (const ref of item.source_refs) {
      if (!existing.source_refs.includes(ref)) existing.source_refs.push(ref);
    }
  }
  return [...byKey.values()];
}

function categoriesFromReleaseItems(items) {
  const releaseCategories = {};
  const docsCategories = { cn: {}, en: {} };
  for (const category of RELEASE_CATEGORY_ORDER) {
    const categoryItems = items.filter((item) => item.category === category);
    if (categoryItems.length === 0) continue;
    releaseCategories[category] = categoryItems.map((item) => item.text_cn);
    const docCategory = RELEASE_TO_DOC_CATEGORY[category];
    docsCategories.cn[docCategory] = categoryItems.map((item) => item.text_cn);
    docsCategories.en[docCategory] = categoryItems.map((item) => item.text_en);
  }
  return { releaseCategories, docsCategories };
}

function coverageFromReleaseItems(evidence, draft, items, index) {
  const coveredRefs = [];
  const coveredGroups = new Set();
  const invalidItemRefs = [];
  for (const item of items) {
    for (const ref of item.source_refs || []) {
      if (!coveredRefs.includes(ref)) coveredRefs.push(ref);
      const groupKey = groupKeyForRef(ref, index.refToGroup);
      if (index.groups.has(groupKey)) coveredGroups.add(groupKey);
      if (index.knownRefs.size > 0 && !index.knownRefs.has(ref)) {
        invalidItemRefs.push({
          ref,
          text_cn: item.text_cn,
          category: item.category,
        });
      }
    }
  }

  const required = [...index.groups.values()];
  const missingRequired = required
    .filter((group) => !coveredGroups.has(group.key))
    .map((group) => ({
      short_sha: group.refs.find((ref) => /^[a-f0-9]{7,40}$/.test(ref)) || "",
      subject: group.subject,
      refs: group.refs,
      reason: group.reason || "important cloud plugin release source",
    }));
  const previousCoverage = draft.coverage || {};
  const requiredCount = required.length || Number(previousCoverage.required_count || 0);
  const missingRequiredCount = required.length
    ? missingRequired.length
    : Number(previousCoverage.missing_required_count || 0);
  const coveredRequiredCount = required.length
    ? required.length - missingRequired.length
    : Number(previousCoverage.covered_required_count || 0);
  const needsReview = missingRequiredCount > 0 || invalidItemRefs.length > 0 || items.length === 0;

  return {
    ...previousCoverage,
    needs_review: needsReview,
    required_count: requiredCount,
    covered_required_count: coveredRequiredCount,
    missing_required_count: missingRequiredCount,
    missing_required: missingRequired,
    invalid_item_refs: invalidItemRefs,
    covered_refs: coveredRefs.sort(),
    policy:
      previousCoverage.policy ||
      "important feat/fix/perf/refactor commits must be referenced by at least one bullet source_ref",
  };
}

function languageIssuesFromReleaseItems(items) {
  const issues = [];
  for (const [index, item] of items.entries()) {
    if (!CJK_RE.test(item.text_cn || "")) {
      issues.push({
        index,
        category: item.category,
        field: "text_cn",
        current_text: item.text_cn || "",
        reason: "Chinese release-note text must contain CJK characters.",
      });
    }
    if (CJK_RE.test(item.text_en || "")) {
      issues.push({
        index,
        category: item.category,
        field: "text_en",
        current_text: item.text_en || "",
        reason: "English release-note text must not contain Chinese/CJK characters.",
      });
    }
  }
  return issues;
}

function summarizeCoverageForValidation(coverage) {
  const value = coverage || {};
  return {
    needs_review: Boolean(value.needs_review),
    required_count: Number(value.required_count || 0),
    covered_required_count: Number(value.covered_required_count || 0),
    missing_required_count: Number(value.missing_required_count || 0),
    missing_required: Array.isArray(value.missing_required) ? value.missing_required : [],
    invalid_item_refs: Array.isArray(value.invalid_item_refs) ? value.invalid_item_refs : [],
  };
}

function validationReportFromPostprocessedDraft(draft) {
  const coverage = summarizeCoverageForValidation(draft?.coverage);
  const languageIssues = Array.isArray(draft?.language_issues) ? draft.language_issues : [];
  const issues = [];
  for (const issue of languageIssues) {
    issues.push({
      kind: "language",
      index: issue.index,
      category: issue.category,
      field: issue.field,
      current_text: issue.current_text || "",
      reason: issue.reason,
    });
  }
  for (const item of coverage.missing_required) {
    issues.push({
      kind: "missing_required_source",
      refs: Array.isArray(item.refs) ? item.refs : [],
      short_sha: item.short_sha || "",
      subject: item.subject || "",
      reason: item.reason || "important cloud plugin release source",
    });
  }
  for (const item of coverage.invalid_item_refs) {
    issues.push({
      kind: "invalid_source_ref",
      ref: item.ref || "",
      category: item.category || "",
      text_cn: item.text_cn || "",
      reason: "release note cites a source_ref that is not present in evidence",
    });
  }
  if (!Array.isArray(draft?.release_items) || draft.release_items.length === 0) {
    issues.push({
      kind: "empty_release_items",
      reason: "release_items must contain at least one evidence-backed item",
    });
  }

  const repairableKinds = new Set(["language", "missing_required_source"]);
  const repairable =
    issues.length > 0 &&
    issues.every((issue) => repairableKinds.has(issue.kind)) &&
    Array.isArray(draft?.release_items) &&
    draft.release_items.length > 0;

  return {
    ok: Boolean(draft?.ok) && !draft?.needs_review && issues.length === 0,
    needs_review: Boolean(draft?.needs_review),
    repairable,
    issue_count: issues.length,
    language_issue_count: languageIssues.length,
    invalid_item_ref_count: coverage.invalid_item_refs.length,
    missing_required_count: coverage.missing_required_count,
    issues,
    coverage,
    postprocess: draft?.postprocess || {},
  };
}

function repairContextFromValidation({ draft, validationReport, repairAttempt, maxRepairAttempts }) {
  return {
    schema: "memos.plugin.release_notes.repair.v1",
    repair_attempt: repairAttempt,
    max_repair_attempts: maxRepairAttempts,
    validation_report: validationReport,
    previous_release_items: (draft.release_items || []).map((item, index) => ({
      index,
      category: item.category,
      text_cn: item.text_cn,
      text_en: item.text_en,
      source_refs: item.source_refs,
    })),
    instructions: [
      "Repair only the issues listed in validation_report. Do not rewrite already valid release-note facts.",
      "For language issues, edit only the affected text_cn/text_en field: text_cn must contain Chinese, text_en must contain no Chinese/CJK characters.",
      "Treat text_cn as the canonical wording first; text_en must be a faithful translation of text_cn, not an independently invented summary.",
      "Keep existing valid category and source_refs unchanged. Do not add source_refs that are not present in the evidence.",
      "For missing_required_source issues, add a concise product-facing item or attach the listed refs to a semantically matching existing item, using only the listed evidence.",
      "When several valid repairs are possible, privately compare alternatives and return the candidate with the best evidence coverage, bilingual quality, and docs-preview readability.",
      "Return the same release_items schema with category, text_cn, text_en, and source_refs.",
    ],
  };
}

function validationAttemptRecord({ stage, repairAttempt, draft, validationReport }) {
  return {
    stage,
    repair_attempt: repairAttempt,
    ok: validationReport.ok,
    needs_review: validationReport.needs_review,
    repairable: validationReport.repairable,
    issue_count: validationReport.issue_count,
    language_issue_count: validationReport.language_issue_count,
    missing_required_count: validationReport.missing_required_count,
    invalid_item_ref_count: validationReport.invalid_item_ref_count,
    coverage: validationReport.coverage,
    issues: validationReport.issues,
    postprocess: draft.postprocess || {},
  };
}

export async function requestValidatedDraft(
  evidence,
  {
    requestImpl = requestDraft,
    maxRepairAttempts = MAX_DRAFT_REPAIR_ATTEMPTS,
  } = {},
) {
  let rawDraft = await requestImpl(evidence);
  const attempts = [];
  let finalDraft = null;

  for (let repairAttempt = 0; repairAttempt <= maxRepairAttempts; repairAttempt += 1) {
    const stage = repairAttempt === 0 ? "draft" : "repair";
    const postprocessed = postprocessDraftFromEvidence(rawDraft, evidence);
    const validationReport = validationReportFromPostprocessedDraft(postprocessed);
    attempts.push(validationAttemptRecord({ stage, repairAttempt, draft: postprocessed, validationReport }));

    finalDraft = {
      ...postprocessed,
      validation_report: validationReport,
      repair_attempts: attempts,
      validation_attempt_count: attempts.length,
      repair_attempt_count: Math.max(0, attempts.length - 1),
    };

    if (validationReport.ok) {
      return finalDraft;
    }
    if (!validationReport.repairable || repairAttempt >= maxRepairAttempts) {
      return finalDraft;
    }

    const stageLabel =
      repairAttempt === 0 ? "initial draft validation" : `repair validation attempt ${repairAttempt}`;
    warn(
      `Release notes validation failed after ${stageLabel}; requesting draft repair ` +
        `${repairAttempt + 1}/${maxRepairAttempts}: ${validationReport.issues
          .map((issue) => issue.kind)
          .join(", ")}`,
    );
    rawDraft = await requestImpl({
      ...evidence,
      release_notes_repair_context: repairContextFromValidation({
        draft: finalDraft,
        validationReport,
        repairAttempt: repairAttempt + 1,
        maxRepairAttempts,
      }),
    });
  }

  return finalDraft;
}

function embeddedReleaseNotesPayload(items, coverage) {
  return {
    schema: "memos.plugin.release_notes.v1",
    items: items.map((item) => ({
      category: item.category,
      text_cn: item.text_cn,
      text_en: item.text_en,
      source_refs: item.source_refs,
    })),
    coverage: {
      needs_review: Boolean(coverage.needs_review),
      required_count: Number(coverage.required_count || 0),
      covered_required_count: Number(coverage.covered_required_count || 0),
      missing_required_count: Number(coverage.missing_required_count || 0),
    },
  };
}

function markdownFromReleaseItems(items, coverage) {
  const lines = ["## Changelog"];
  for (const category of RELEASE_CATEGORY_ORDER) {
    const categoryItems = items.filter((item) => item.category === category);
    if (categoryItems.length === 0) continue;
    lines.push("");
    lines.push(`### ${category}`);
    for (const item of categoryItems) {
      lines.push(`- ${item.text_cn}`);
    }
  }
  lines.push("");
  lines.push(`<!-- ${RELEASE_NOTES_MARKER}`);
  lines.push(JSON.stringify(embeddedReleaseNotesPayload(items, coverage), null, 2));
  lines.push("-->");
  return `${lines.join("\n").trim()}\n`;
}

export function postprocessDraftFromEvidence(draft, evidence) {
  const inputItems = Array.isArray(draft?.release_items)
    ? draft.release_items.map(normalizeReleaseItem).filter(Boolean)
    : [];
  if (inputItems.length === 0) return draft;

  const index = buildSourceRefIndex(evidence);
  let reclassifiedItems = 0;
  let items = inputItems.map((item) => {
    const hintedCategory = bestHintCategoryForItem(item, index);
    const category = hintedCategory || item.category;
    if (category !== item.category) reclassifiedItems += 1;
    return { ...item, category };
  });

  const deduped = dedupeSourceRefsByBestCategory(items, index);
  items = dedupeReleaseItems(
    deduped.items.map((item) => {
      const hintedCategory = bestHintCategoryForItem(item, index);
      const category = hintedCategory || item.category;
      if (category !== item.category) reclassifiedItems += 1;
      return { ...item, category };
    }),
  );
  const expanded = expandKnownReleaseItems(items, index);
  items = expanded.items;

  const coverage = coverageFromReleaseItems(evidence, draft, items, index);
  const languageIssues = languageIssuesFromReleaseItems(items);
  if (languageIssues.length > 0) {
    coverage.needs_review = true;
  }
  const { releaseCategories, docsCategories } = categoriesFromReleaseItems(items);
  const postprocess = {
    applied: true,
    removed_duplicate_source_refs: deduped.removedDuplicateRefs,
    dropped_empty_source_items: deduped.droppedItems,
    reclassified_items: reclassifiedItems,
    expanded_known_items: expanded.expandedKnownItems,
    final_item_count: items.length,
  };
  const warnings = Array.isArray(draft.warnings) ? [...draft.warnings] : [];
  if (
    postprocess.removed_duplicate_source_refs > 0 ||
    postprocess.dropped_empty_source_items > 0 ||
    postprocess.reclassified_items > 0 ||
    postprocess.expanded_known_items > 0
  ) {
    warnings.push("release notes were postprocessed to dedupe source_refs, apply evidence category hints, and normalize known cloud plugin topics");
  }
  if (languageIssues.length > 0) {
    warnings.push("release notes language validation failed; manual review is required");
  }

  return {
    ...draft,
    ok: Boolean(items.length) && !coverage.needs_review,
    needs_review: Boolean(coverage.needs_review),
    release_items: items,
    release_categories: releaseCategories,
    docs_categories: docsCategories,
    coverage,
    warnings,
    language_issues: languageIssues,
    postprocess,
    release_notes_markdown: markdownFromReleaseItems(items, coverage),
  };
}

function previewDateFromPublishedAt(value) {
  const text = String(value || "").trim();
  if (!text) return "<GitHub Release published_at>";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "<GitHub Release published_at>";
  return date.toISOString().slice(0, 10);
}

export function docsPreviewFromDraft(draft, { targetVersion, publishedAt = "" } = {}) {
  const version = displayVersion(targetVersion || draft?.target_version || "");
  const date = previewDateFromPublishedAt(publishedAt);
  const docsCategories = draft?.docs_categories || { cn: {}, en: {} };
  const buildEntry = (locale) => ({
    name: version,
    date,
    products: {
      plugin: Object.fromEntries(
        Object.entries(docsCategories[locale] || {}).map(([category, items]) => [
          category,
          [
            {
              type: locale === "cn" ? PRODUCT_TITLE.zh : PRODUCT_TITLE.en,
              changedInfo: items,
            },
          ],
        ]),
      ),
    },
  });
  return {
    schema: "memos.plugin.docs_preview.v1",
    product_id: PRODUCT_ID,
    repo: REPOSITORY,
    version,
    date,
    date_source: publishedAt ? "provided published_at" : "GitHub Release published_at at publish time",
    docs_files: {
      cn: "content/cn/plugin-changelog.yml",
      en: "content/en/plugin-changelog.yml",
    },
    entries: {
      cn: buildEntry("cn"),
      en: buildEntry("en"),
    },
  };
}

export function markdownFromDocsPreview(preview) {
  const lines = [
    "# MemOS-Docs Plugin Changelog Preview",
    "",
    `- product_id: ${preview.product_id}`,
    `- version: ${preview.version}`,
    `- date: ${preview.date}`,
    `- zh file: ${preview.docs_files.cn}`,
    `- en file: ${preview.docs_files.en}`,
  ];
  for (const [locale, title] of [
    ["cn", "中文预览"],
    ["en", "English Preview"],
  ]) {
    lines.push("");
    lines.push(`## ${title}`);
    const plugin = preview.entries[locale]?.products?.plugin || {};
    const categories = Object.keys(plugin);
    if (categories.length === 0) {
      lines.push("");
      lines.push("- No plugin changelog items would be rendered.");
      continue;
    }
    for (const category of categories) {
      lines.push("");
      lines.push(`### ${category}`);
      for (const group of plugin[category] || []) {
        lines.push("");
        lines.push(`- type: ${group.type}`);
        for (const item of group.changedInfo || []) {
          lines.push(`  - ${item}`);
        }
      }
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function releaseNotesPayloadFromMarkdown(text) {
  const match = text.match(/<!--\s*doc-agent-release-notes-json\s*\n([\s\S]*?)\n-->/);
  if (!match) {
    fail("Manual release notes must include the doc-agent-release-notes-json evidence block.");
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    fail("Manual release notes contain invalid doc-agent-release-notes-json.");
  }
}

function draftFromReleaseNotesMarkdown(notes) {
  const payload = releaseNotesPayloadFromMarkdown(notes);
  const items = Array.isArray(payload?.items) ? payload.items.map(normalizeReleaseItem).filter(Boolean) : [];
  const coverage = payload?.coverage || {};
  const { releaseCategories, docsCategories } = categoriesFromReleaseItems(items);
  return {
    ok: items.length > 0 && coverage.needs_review === false,
    needs_review: coverage.needs_review !== false,
    confidence: "manual",
    release_items: items,
    release_categories: releaseCategories,
    docs_categories: docsCategories,
    coverage,
    warnings: [],
    language_issues: languageIssuesFromReleaseItems(items),
    postprocess: {
      applied: false,
      source: "manual_release_notes",
      final_item_count: items.length,
    },
    release_notes_markdown: notes,
  };
}

export function validateManualNotes(notes) {
  const text = String(notes || "").trim();
  if (!/^## Changelog\s*$/m.test(text)) {
    fail("Manual release notes must contain a '## Changelog' heading.");
  }
  const payload = releaseNotesPayloadFromMarkdown(text);
  if (!Array.isArray(payload?.items) || payload.items.length === 0) {
    fail("Manual release notes evidence block must contain non-empty items.");
  }
  if (payload?.coverage?.needs_review !== false) {
    fail("Manual release notes evidence coverage must explicitly set needs_review=false.");
  }
  const normalizedItems = payload.items.map(normalizeReleaseItem);
  if (normalizedItems.some((item) => !item)) {
    fail("Every manual release-note item must include category, text_cn, text_en, and valid source_refs.");
  }
  for (const item of normalizedItems) {
    if (!item?.text_cn || !item?.text_en || !Array.isArray(item?.source_refs) || item.source_refs.length === 0) {
      fail("Every manual release-note item must include text_cn, text_en, and source_refs.");
    }
    if (!CJK_RE.test(String(item.text_cn || ""))) {
      fail("Every manual release-note item text_cn must contain Chinese text.");
    }
    if (CJK_RE.test(String(item.text_en || ""))) {
      fail("Every manual release-note item text_en must not contain Chinese/CJK characters.");
    }
  }
  return text;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function hasStructuredDraftItems(payload) {
  return Array.isArray(payload?.release_items) && payload.release_items.map(normalizeReleaseItem).some(Boolean);
}

function cleanError(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "https://***")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "***")
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function requiredUrlFromEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    fail(`${name} secret is required when release_notes input is empty.`);
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) fail(`${name} must be an HTTP(S) URL.`);
  } catch {
    fail(`${name} must be an HTTP(S) URL.`);
  }
  return value;
}

function optionalUrlFromEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) fail(`${name} must be an HTTP(S) URL.`);
  } catch {
    fail(`${name} must be an HTTP(S) URL.`);
  }
  return value;
}

export async function reportFailure({ evidence, attempts, finalError, phase = "release-notes", fetchImpl = fetch }) {
  if (attempts.length < 3) return { skipped: true, reason: "fewer than three attempts" };
  const token = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN || "";
  if (!token.trim()) return { skipped: true, reason: "missing configured token" };
  const url = optionalUrlFromEnv("DOC_AGENT_RELEASE_FAILURE_URL");
  if (!url) return { skipped: true, reason: "missing configured failure URL" };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      product_id: PRODUCT_ID,
      repository: evidence.repo,
      version: evidence.target_version,
      phase,
      run_id: process.env.GITHUB_RUN_ID || `${evidence.current_tag}-cloud`,
      run_url: process.env.GITHUB_RUN_ID
        ? `https://github.com/${evidence.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
      attempts: attempts.slice(0, 3).map((item, index) => ({
        attempt: index + 1,
        error_code: item.error_code || "DRAFT_FAILED",
        message: cleanError(item.message),
        retryable: Boolean(item.retryable),
      })),
      final_error: cleanError(finalError),
    }),
  });
  if (!response.ok) {
    throw new Error(`Failure-report endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function reportExternalFailureFromEnv({ fetchImpl = fetch } = {}) {
  const phase = String(process.env.RELEASE_FAILURE_PHASE || "").trim();
  const attemptDir = String(process.env.RELEASE_FAILURE_ATTEMPT_DIR || "").trim();
  if (!phase || !attemptDir) fail("RELEASE_FAILURE_PHASE and RELEASE_FAILURE_ATTEMPT_DIR are required.");
  const attempts = [1, 2, 3].map((attempt) => {
    let message = "attempt log is unavailable";
    try { message = readFileSync(join(attemptDir, `${attempt}.log`), "utf8"); } catch {}
    return { error_code: phase.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), message: cleanError(message), retryable: true };
  });
  return reportFailure({
    evidence: {
      repo: process.env.GITHUB_REPOSITORY || REPOSITORY,
      target_version: displayVersion(process.env.RELEASE_VERSION),
      current_tag: process.env.RELEASE_TAG || `${CURRENT_TAG_PREFIX}${cleanVersion(process.env.RELEASE_VERSION)}`,
    },
    attempts,
    finalError: attempts[2].message,
    phase,
    fetchImpl,
  });
}

export async function requestDraft(
  evidence,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const url = requiredUrlFromEnv("DOC_AGENT_RELEASE_NOTES_DRAFT_URL");
  const token = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN || "";
  if (!token.trim()) {
    fail("DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN secret is required when release_notes input is empty.");
  }

  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...evidence,
          workflow_retry_context: {
            attempt,
            previous_errors: attempts.map((item) => item.message),
          },
        }),
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw Object.assign(new Error(`non-JSON response: HTTP ${response.status}`), {
          retryable: isRetryableStatus(response.status),
          errorCode: `HTTP_${response.status}`,
        });
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`HTTP ${response.status} ${JSON.stringify(payload).slice(0, 400)}`),
          { retryable: isRetryableStatus(response.status), errorCode: `HTTP_${response.status}` },
        );
      }
      if (!payload.ok || payload.needs_review) {
        const serverAttempts = Array.isArray(payload.attempts) ? payload.attempts : [];
        const coverage = payload.coverage ? JSON.stringify(payload.coverage) : "";
        const warnings = Array.isArray(payload.warnings) ? payload.warnings.join("; ") : "";
        const message = `Release notes draft needs review. ${coverage} ${warnings}`.trim();
        if (hasStructuredDraftItems(payload)) {
          warn(
            `${message} Continuing with local validation and repair because the draft service returned structured release_items.`,
          );
          return payload;
        }
        if (serverAttempts.length >= 3) {
          await reportFailure({
            evidence,
            attempts: serverAttempts.map((item) => ({
              error_code: "DRAFT_VALIDATION",
              message: item.error || message,
              retryable: false,
            })),
            finalError: message,
            fetchImpl,
          });
        }
        fail(message);
      }
      if (!String(payload.release_notes_markdown || "").trim() && !hasStructuredDraftItems(payload)) {
        fail("Release-notes draft service returned an empty release_notes_markdown.");
      }
      return payload;
    } catch (error) {
      const entry = {
        error_code: error?.errorCode || "DRAFT_REQUEST",
        message: cleanError(error?.message || error),
        retryable: Boolean(error?.retryable),
      };
      attempts.push(entry);
      if (!entry.retryable || attempt === 3) {
        if (attempts.length === 3) {
          await reportFailure({ evidence, attempts, finalError: entry.message, fetchImpl });
        }
        fail(`Release-notes draft request failed on attempt ${attempt}: ${entry.message}`);
      }
      warn(`Release-notes draft attempt ${attempt} failed; retrying: ${entry.message}`);
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  fail("Release-notes draft failed after three attempts.");
}

export async function main() {
  const targetVersion = cleanVersion(process.env.RELEASE_VERSION);
  if (!targetVersion) fail("RELEASE_VERSION is required.");

  const currentTag = process.env.RELEASE_TAG || `${CURRENT_TAG_PREFIX}${targetVersion}`;
  const notesPath =
    process.env.RELEASE_NOTES_FILE ||
    join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-release-notes.md`);
  mkdirSync(dirname(notesPath), { recursive: true });

  const manualNotes = String(process.env.MANUAL_RELEASE_NOTES || "").trim();
  if (manualNotes) {
    const validManualNotes = ensureSourceHint(validateManualNotes(manualNotes));
    const manualDraft = draftFromReleaseNotesMarkdown(validManualNotes);
    const draftPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-release-notes-draft.json`);
    const docsPreview = docsPreviewFromDraft(manualDraft, { targetVersion });
    const docsPreviewPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-docs-preview.json`);
    const docsPreviewMarkdownPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-docs-preview.md`);
    writeFileSync(notesPath, validManualNotes, "utf8");
    writeFileSync(draftPath, JSON.stringify(draftForInspection(manualDraft), null, 2), "utf8");
    writeFileSync(docsPreviewPath, JSON.stringify(docsPreview, null, 2), "utf8");
    writeFileSync(docsPreviewMarkdownPath, markdownFromDocsPreview(docsPreview), "utf8");
    appendOutput("release_notes_file", notesPath);
    appendOutput("draft_file", draftPath);
    appendOutput("docs_preview_file", docsPreviewPath);
    appendOutput("docs_preview_markdown_file", docsPreviewMarkdownPath);
    appendOutput("draft_used", "false");
    console.log(`Using manually provided release notes: ${notesPath}`);
    return;
  }

  const previousTag = findPreviousTag(targetVersion, currentTag);
  if (!previousTag) {
    fail(`Cannot find a previous cloud plugin tag before ${currentTag}.`);
  }

  const currentRef = resolveCurrentRef(currentTag);
  const evidence = collectEvidence({ targetVersion, currentTag, previousTag, currentRef });
  const evidencePath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-evidence.json`);
  writeFileSync(evidencePath, JSON.stringify(evidenceForInspection(evidence), null, 2), "utf8");

  const draft = await requestValidatedDraft(evidence);
  if (!draft.ok || draft.needs_review) {
    fail(`Postprocessed release notes require review: ${JSON.stringify(draft.validation_report || draft.coverage || {})}`);
  }
  const draftPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-release-notes-draft.json`);
  const docsPreview = docsPreviewFromDraft(draft, { targetVersion });
  const docsPreviewPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-docs-preview.json`);
  const docsPreviewMarkdownPath = join(tmpdir(), `openclaw-cloud-plugin-${targetVersion}-docs-preview.md`);
  writeFileSync(draftPath, JSON.stringify(draftForInspection(draft), null, 2), "utf8");
  writeFileSync(docsPreviewPath, JSON.stringify(docsPreview, null, 2), "utf8");
  writeFileSync(docsPreviewMarkdownPath, markdownFromDocsPreview(docsPreview), "utf8");
  writeFileSync(notesPath, ensureSourceHint(draft.release_notes_markdown), "utf8");

  appendOutput("release_notes_file", notesPath);
  appendOutput("evidence_file", evidencePath);
  appendOutput("draft_file", draftPath);
  appendOutput("docs_preview_file", docsPreviewPath);
  appendOutput("docs_preview_markdown_file", docsPreviewMarkdownPath);
  appendOutput("draft_used", "true");
  appendOutput("previous_tag", previousTag);
  appendOutput("current_tag", currentTag);
  appendOutput("current_ref", currentRef);
  appendOutput("draft_confidence", String(draft.confidence || ""));
  appendOutput("missing_required_count", String(draft.coverage?.missing_required_count ?? ""));
  appendOutput("validation_attempt_count", String(draft.validation_attempt_count ?? ""));
  appendOutput("repair_attempt_count", String(draft.repair_attempt_count ?? ""));

  console.log(`Drafted release notes with configured service: ${notesPath}`);
  console.log(`Previous tag: ${previousTag}`);
  console.log(`Current tag: ${currentTag}`);
  console.log(`Current evidence ref: ${currentRef}`);
  console.log(`Coverage: ${JSON.stringify(draft.coverage || {})}`);
  console.log(`Validation attempts: ${draft.validation_attempt_count ?? ""}`);
  console.log(`Repair attempts: ${draft.repair_attempt_count ?? ""}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const run = process.env.RELEASE_FAILURE_PHASE ? reportExternalFailureFromEnv : main;
  run().catch((error) => {
    console.error(`::error::${cleanError(error?.message || String(error))}`);
    process.exitCode = 1;
  });
}
