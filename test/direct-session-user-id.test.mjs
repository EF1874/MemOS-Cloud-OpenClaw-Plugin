import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig, extractTaggedMemosUserId, stripOpenClawInjectedPrefix } from "../lib/memos-cloud-api.js";
import {
  buildAddMessagePayload,
  buildSearchPayload,
  extractDirectSessionUserId,
  extractLatestTaggedMemosUserIdFromMessages,
  resolveMemosUserId,
  sanitizeTextForMemos,
} from "../index.js";

test("buildConfig keeps direct-session and memos-userid-tag switches disabled by default", () => {
  const previousDirect = process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
  const previousTag = process.env.MEMOS_USE_MEMOS_USERID_TAG;
  delete process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
  delete process.env.MEMOS_USE_MEMOS_USERID_TAG;
  try {
    const cfg = buildConfig({});
    assert.equal(cfg.useDirectSessionUserId, false);
    assert.equal(cfg.useMemosUserIdTag, false);
  } finally {
    if (previousDirect === undefined) {
      delete process.env.MEMOS_USE_DIRECT_SESSION_USER_ID;
    } else {
      process.env.MEMOS_USE_DIRECT_SESSION_USER_ID = previousDirect;
    }
    if (previousTag === undefined) {
      delete process.env.MEMOS_USE_MEMOS_USERID_TAG;
    } else {
      process.env.MEMOS_USE_MEMOS_USERID_TAG = previousTag;
    }
  }
});

test("extractDirectSessionUserId returns the id for direct session keys", () => {
  assert.equal(
    extractDirectSessionUserId("agent:main:discord:direct:1160853368999247882"),
    "1160853368999247882",
  );
  assert.equal(extractDirectSessionUserId("agent:main:telegram:direct:8361983702"), "8361983702");
});

test("extractDirectSessionUserId ignores non-direct session keys", () => {
  assert.equal(extractDirectSessionUserId("agent:main:discord:channel:1482035270651220051"), "");
  assert.equal(extractDirectSessionUserId(""), "");
});

test("resolveMemosUserId falls back to configured userId when switch is off", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: false };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx), "openclaw-user");
});

test("resolveMemosUserId uses direct id when switch is on", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: true };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx), "1160853368999247882");
});

test("resolveMemosUserId ignores memos userid tag override when tag switch is off", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: true, useMemosUserIdTag: false };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx, "custom-user-id"), "1160853368999247882");
});

test("resolveMemosUserId prefers memos userid tag override when tag switch is on", () => {
  const cfg = { userId: "openclaw-user", useDirectSessionUserId: true, useMemosUserIdTag: true };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };
  assert.equal(resolveMemosUserId(cfg, ctx, "custom-user-id"), "custom-user-id");
});

test("extractTaggedMemosUserId returns the first memos_userid tag as a trimmed string", () => {
  const input = "hello <memos_userid>  user-123  </memos_userid> world <memos_userid>ignored</memos_userid>";
  assert.equal(extractTaggedMemosUserId(input), "user-123");
});

test("stripOpenClawInjectedPrefix keeps memos_userid tags untouched", () => {
  const input = "hello <memos_userid>user-123</memos_userid> world";
  assert.equal(stripOpenClawInjectedPrefix(input), input);
});

test("sanitizeTextForMemos strips memos_userid tags only when switch is on", () => {
  const input = "hello <memos_userid>user-123</memos_userid> world";
  assert.equal(sanitizeTextForMemos(input, { useMemosUserIdTag: false }), input);
  assert.equal(sanitizeTextForMemos(input, { useMemosUserIdTag: true }), "hello world");
});

test("buildSearchPayload ignores memos_userid tag when tag switch is off", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    useMemosUserIdTag: false,
    queryPrefix: "",
    maxQueryChars: 0,
    recallGlobal: true,
    knowledgebaseIds: [],
    memoryLimitNumber: 6,
    includePreference: true,
    preferenceLimitNumber: 6,
    includeToolMemory: false,
    toolMemoryLimitNumber: 0,
    relativity: 0.45,
    multiAgentMode: false,
  };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };

  const payload = buildSearchPayload(
    cfg,
    "hello <memos_userid>custom-user-id</memos_userid> world",
    ctx,
  );
  assert.equal(payload.user_id, "1160853368999247882");
  assert.equal(payload.query, "hello <memos_userid>custom-user-id</memos_userid> world");
});

test("buildSearchPayload uses first memos_userid tag as user_id and strips it from query when switch is on", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    useMemosUserIdTag: true,
    queryPrefix: "",
    maxQueryChars: 0,
    recallGlobal: true,
    knowledgebaseIds: [],
    memoryLimitNumber: 6,
    includePreference: true,
    preferenceLimitNumber: 6,
    includeToolMemory: false,
    toolMemoryLimitNumber: 0,
    relativity: 0.45,
    multiAgentMode: false,
  };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };

  const payload = buildSearchPayload(
    cfg,
    "hello <memos_userid>custom-user-id</memos_userid> world",
    ctx,
  );
  assert.equal(payload.user_id, "custom-user-id");
  assert.equal(payload.query, "hello world");
});

test("buildSearchPayload uses direct session id as user_id for private chats", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    queryPrefix: "",
    maxQueryChars: 0,
    recallGlobal: true,
    knowledgebaseIds: [],
    memoryLimitNumber: 6,
    includePreference: true,
    preferenceLimitNumber: 6,
    includeToolMemory: false,
    toolMemoryLimitNumber: 0,
    relativity: 0.45,
    multiAgentMode: false,
  };
  const ctx = { sessionKey: "agent:main:discord:direct:1160853368999247882" };

  const payload = buildSearchPayload(cfg, "你好", ctx);
  assert.equal(payload.user_id, "1160853368999247882");
});

test("extractLatestTaggedMemosUserIdFromMessages reads the latest user tag from raw messages", () => {
  const messages = [
    { role: "user", content: "old <memos_userid>first-user</memos_userid>" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "new <memos_userid>second-user</memos_userid> request" },
  ];
  assert.equal(extractLatestTaggedMemosUserIdFromMessages(messages), "second-user");
});

test("buildAddMessagePayload ignores memos userid override when tag switch is off", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    useMemosUserIdTag: false,
    multiAgentMode: false,
    appId: "",
    tags: [],
    info: {},
    allowPublic: false,
    allowKnowledgebaseIds: [],
    asyncMode: true,
    conversationId: "",
    conversationIdPrefix: "",
    conversationIdSuffix: "",
    conversationSuffixMode: "none",
  };
  const ctx = {
    sessionKey: "agent:main:discord:channel:1482035270651220051",
    memosUserIdOverride: "custom-user-id",
  };

  const payload = buildAddMessagePayload(cfg, [{ role: "user", content: "hi" }], ctx);
  assert.equal(payload.user_id, "openclaw-user");
});

test("buildAddMessagePayload prefers memos userid override from ctx when tag switch is on", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    useMemosUserIdTag: true,
    multiAgentMode: false,
    appId: "",
    tags: [],
    info: {},
    allowPublic: false,
    allowKnowledgebaseIds: [],
    asyncMode: true,
    conversationId: "",
    conversationIdPrefix: "",
    conversationIdSuffix: "",
    conversationSuffixMode: "none",
  };
  const ctx = {
    sessionKey: "agent:main:discord:channel:1482035270651220051",
    memosUserIdOverride: "custom-user-id",
  };

  const payload = buildAddMessagePayload(cfg, [{ role: "user", content: "hi" }], ctx);
  assert.equal(payload.user_id, "custom-user-id");
});

test("buildAddMessagePayload keeps configured userId for non-direct chats", () => {
  const cfg = {
    userId: "openclaw-user",
    useDirectSessionUserId: true,
    multiAgentMode: false,
    appId: "",
    tags: [],
    info: {},
    allowPublic: false,
    allowKnowledgebaseIds: [],
    asyncMode: true,
    conversationId: "",
    conversationIdPrefix: "",
    conversationIdSuffix: "",
    conversationSuffixMode: "none",
  };
  const ctx = { sessionKey: "agent:main:discord:channel:1482035270651220051" };

  const payload = buildAddMessagePayload(cfg, [{ role: "user", content: "hi" }], ctx);
  assert.equal(payload.user_id, "openclaw-user");
});
