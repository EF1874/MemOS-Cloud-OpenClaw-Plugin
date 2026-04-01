import { exec, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { getConfigResolution } from "./memos-cloud-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "memos-cloud-openclaw-plugin";
const UI_HOST = "127.0.0.1";
const UI_BASE_PORT = 38463;
const UI_PORT_ATTEMPTS = 24;
const GLOBAL_STATE_KEY = "__memosCloudConfigUiState";
const ASSET_DIR = join(__dirname, "config-ui");
const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";
const CHILD_ENTRY = fileURLToPath(new URL("./config-ui-child.js", import.meta.url));
const CHILD_ENV_KEY = "MEMOS_CLOUD_CONFIG_UI_CHILD";
const HOST_EXEC_PATH_ENV_KEY = "MEMOS_CLOUD_HOST_EXEC_PATH";
const HOST_ARGV_ENV_KEY = "MEMOS_CLOUD_HOST_ARGV_JSON";
const DEFAULT_GATEWAY_READY_PORT = 18789;

const FIELD_GROUPS = [
  { id: "connection", title: "Connection", description: "MemOS endpoint, authentication, and identity mapping." },
  { id: "session", title: "Session And Recall", description: "Conversation id strategy, recall scope, and injection behavior." },
  { id: "capture", title: "Capture And Storage", description: "What gets written back to MemOS after each agent run." },
  { id: "agent", title: "Agent Isolation", description: "Multi-agent isolation, app metadata, and sharing permissions." },
  { id: "filter", title: "Recall Filter", description: "Optional model-based second-pass filtering before memories are injected." },
  { id: "advanced", title: "Advanced", description: "Timeouts, throttling, and low-level controls." },
];

const FIELD_DEFINITIONS = [
  { key: "baseUrl", group: "connection", type: "string", label: "MemOS Base URL", description: "Base URL for the MemOS OpenMem API.", placeholder: "https://memos.memtensor.cn/api/openmem/v1" },
  { key: "apiKey", group: "connection", type: "secret", label: "MemOS API Key", description: "Token auth key. Leave inherited to use env files or process env.", placeholder: "mpg-..." },
  { key: "userId", group: "connection", type: "string", label: "User ID", description: "Unique identifier of the user associated with added messages and queried memories.", placeholder: "openclaw-user" },
  { key: "useDirectSessionUserId", group: "connection", type: "boolean", label: "Use Direct Session User ID", description: "Use direct-session user id from session key when available." },
  { key: "conversationId", group: "session", type: "string", label: "Conversation ID Override", description: "Unique identifier of the conversation. Reusing the same value keeps turns in the same context." },
  { key: "conversationIdPrefix", group: "session", type: "string", label: "Conversation Prefix", description: "Prepended to the derived conversation id." },
  { key: "conversationIdSuffix", group: "session", type: "string", label: "Conversation Suffix", description: "Appended to the derived conversation id." },
  { key: "conversationSuffixMode", group: "session", type: "enum", label: "Suffix Mode", description: "Choose whether /new increments a numeric suffix.", options: [{ value: "none", label: "none" }, { value: "counter", label: "counter" }] },
  { key: "resetOnNew", group: "session", type: "boolean", label: "Reset On /new", description: "Requires hooks.internal.enabled when counter suffix mode is used." },
  { key: "queryPrefix", group: "session", type: "textarea", rows: 4, label: "Query Prefix", description: "Extra text prepended to query before retrieval.", placeholder: "important user context preferences decisions " },
  { key: "maxQueryChars", group: "session", type: "integer", label: "Max Query Chars", description: "Limit the query text length before sending recall search.", placeholder: "0" },
  { key: "recallEnabled", group: "session", type: "boolean", label: "Recall Enabled", description: "Enable before_agent_start memory recall." },
  { key: "recallGlobal", group: "session", type: "boolean", label: "Global Recall", description: "When enabled, query is sent without conversation_id, so current-session weighting is not emphasized." },
  { key: "maxItemChars", group: "session", type: "integer", label: "Max Item Chars", description: "Maximum characters kept when injecting each recalled memory item into context.", placeholder: "8000" },
  { key: "memoryLimitNumber", group: "session", type: "integer", label: "Memory Limit", description: "Maximum number of recalled memories. Default is 9, max is 25.", placeholder: "9" },
  { key: "preferenceLimitNumber", group: "session", type: "integer", label: "Preference Limit", description: "Maximum number of recalled preference memories. Default is 9, max is 25.", placeholder: "9" },
  { key: "includePreference", group: "session", type: "boolean", label: "Include Preferences", description: "Whether to enable preference memory recall." },
  { key: "includeToolMemory", group: "session", type: "boolean", label: "Include Tool Memory", description: "Whether to enable tool memory recall." },
  { key: "toolMemoryLimitNumber", group: "session", type: "integer", label: "Tool Memory Limit", description: "Maximum number of tool memories returned. Effective only when tool memory recall is enabled.", placeholder: "6" },
  { key: "relativity", group: "session", type: "number", label: "Relativity Threshold", description: "Recall relevance threshold from 0 to 1. Set to 0 to disable relevance filtering.", placeholder: "0.45", step: "0.01" },
  { key: "filter", group: "session", type: "json", rows: 7, label: "Search Filter (JSON)", description: "Filter conditions used before retrieval. Supports agent_id, app_id, time fields, info fields, and and/or/gte/lte/gt/lt.", placeholder: '{\n  "agent_id": "assistant-1"\n}' },
  { key: "knowledgebaseIds", group: "session", type: "stringArray", rows: 4, label: "Knowledge Base IDs", description: "Restrict the knowledgebase scope for this search. Use one ID per line, or all.", placeholder: "kb-001\nkb-002" },
  { key: "addEnabled", group: "capture", type: "boolean", label: "Add Enabled", description: "Enable adding message arrays and writing resulting memories at agent_end." },
  { key: "captureStrategy", group: "capture", type: "enum", label: "Capture Strategy", description: "Choose whether messages contains only the last turn or the full session.", options: [{ value: "last_turn", label: "last_turn" }, { value: "full_session", label: "full_session" }] },
  { key: "maxMessageChars", group: "capture", type: "integer", label: "Max Message Chars", description: "Maximum characters kept per stored message before building the messages array.", placeholder: "20000" },
  { key: "includeAssistant", group: "capture", type: "boolean", label: "Include Assistant", description: "Include assistant replies in the messages array." },
  { key: "tags", group: "capture", type: "stringArray", rows: 4, label: "Tags", description: "Custom tags used to classify added messages. One value per line.", placeholder: "openclaw" },
  { key: "info", group: "capture", type: "json", rows: 7, label: "Info Payload (JSON)", description: "Structured metadata merged into info for filtering, tracing, and source tracking.", placeholder: '{\n  "channel": "webchat"\n}' },
  { key: "asyncMode", group: "capture", type: "boolean", label: "Async Mode", description: "Add memories asynchronously in the background to avoid blocking the call chain." },
  { key: "agentId", group: "agent", type: "string", label: "Static Agent ID", description: "Unique identifier of the Agent associated with added messages and retrieved memories." },
  { key: "multiAgentMode", group: "agent", type: "boolean", label: "Multi-Agent Mode", description: "Isolate recall and add payloads by ctx.agentId when available." },
  { key: "allowedAgents", group: "agent", type: "stringArray", rows: 4, label: "Allowed Agents", description: "Only listed agent ids are allowed to recall and add; empty means all agents." },
  { key: "agentOverrides", group: "agent", type: "json", rows: 10, label: "Agent Overrides (JSON)", description: "Per-agent overrides. Key is agent id, value is an object of supported override fields.", placeholder: '{\n  "assistant-1": {\n    "knowledgebaseIds": ["kb-001"],\n    "recallEnabled": true\n  }\n}' },
  { key: "appId", group: "agent", type: "string", label: "App ID", description: "Unique identifier of the App associated with added messages and retrieved memories." },
  { key: "allowPublic", group: "agent", type: "boolean", label: "Allow Public", description: "Allow generated memories to be written to the public memory store." },
  { key: "allowKnowledgebaseIds", group: "agent", type: "stringArray", rows: 4, label: "Allowed Knowledge Base IDs", description: "Knowledgebase scope where generated memories are allowed to be written. One ID per line.", placeholder: "kb-public\nkb-team" },
  { key: "recallFilterEnabled", group: "filter", type: "boolean", label: "Recall Filter Enabled", description: "Enable second-pass model filtering for recall candidates." },
  { key: "recallFilterBaseUrl", group: "filter", type: "string", label: "Filter Base URL", description: "OpenAI-compatible endpoint used for recall filtering.", placeholder: "http://127.0.0.1:11434/v1" },
  { key: "recallFilterApiKey", group: "filter", type: "secret", label: "Filter API Key", description: "Optional bearer token for the recall filter model endpoint." },
  { key: "recallFilterModel", group: "filter", type: "string", label: "Filter Model", description: "Model name used by the recall filter endpoint.", placeholder: "qwen2.5:7b" },
  { key: "recallFilterTimeoutMs", group: "filter", type: "integer", label: "Filter Timeout (ms)", description: "Request timeout for the recall filter model.", placeholder: "6000" },
  { key: "recallFilterRetries", group: "filter", type: "integer", label: "Filter Retries", description: "Retry count when the recall filter request fails.", placeholder: "0" },
  { key: "recallFilterCandidateLimit", group: "filter", type: "integer", label: "Candidate Limit", description: "Per-category candidate limit before filtering.", placeholder: "30" },
  { key: "recallFilterMaxItemChars", group: "filter", type: "integer", label: "Filter Max Item Chars", description: "Maximum characters kept per candidate item before filtering.", placeholder: "500" },
  { key: "recallFilterFailOpen", group: "filter", type: "boolean", label: "Fail Open", description: "Fall back to unfiltered recall if the filter model errors." },
  { key: "timeoutMs", group: "advanced", type: "integer", label: "MemOS Timeout (ms)", description: "Timeout used for MemOS API requests.", placeholder: "5000" },
  { key: "retries", group: "advanced", type: "integer", label: "MemOS Retries", description: "Retry count for MemOS API requests.", placeholder: "1" },
  { key: "throttleMs", group: "advanced", type: "integer", label: "Throttle (ms)", description: "Skip add/message when the previous capture happened too recently.", placeholder: "0" },
];

function getGlobalState() {
  if (!globalThis[GLOBAL_STATE_KEY]) {
    globalThis[GLOBAL_STATE_KEY] = {
      promise: null,
      service: null,
      cleanupInstalled: false,
      restartHookInstalled: false,
      restartTimer: null,
      restartPending: false,
      recyclePromise: null,
      shuttingDown: false,
      child: null,
    };
  }
  return globalThis[GLOBAL_STATE_KEY];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeStructuredValue(value, depth = 0) {
  if (depth > 16) throw new Error("Config payload is too deeply nested.");
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Config payload contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeStructuredValue(item, depth + 1));
  if (isPlainObject(value)) {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = sanitizeStructuredValue(child, depth + 1);
      if (normalized !== undefined) next[key] = normalized;
    }
    return next;
  }
  if (value === undefined) return undefined;
  throw new Error("Config payload contains an unsupported value type.");
}

function sortForHash(value) {
  if (Array.isArray(value)) return value.map((item) => sortForHash(item));
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortForHash(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function createRevision(value) {
  return createHash("sha1").update(JSON.stringify(sortForHash(value))).digest("hex").slice(0, 12);
}

function detectRuntimeProfile() {
  const scriptPath = String(process.argv[1] || "").toLowerCase();
  const execPath = String(process.execPath || "").toLowerCase();

  if (scriptPath.includes("moltbot") || execPath.includes("moltbot")) {
    return { id: "moltbot", displayName: "Moltbot", cliName: "moltbot", configPath: process.env.MOLTBOT_CONFIG_PATH || join(homedir(), ".moltbot", "moltbot.json") };
  }
  if (scriptPath.includes("clawdbot") || execPath.includes("clawdbot")) {
    return { id: "clawdbot", displayName: "ClawDBot", cliName: "clawdbot", configPath: process.env.CLAWDBOT_CONFIG_PATH || join(homedir(), ".clawdbot", "clawdbot.json") };
  }
  return { id: "openclaw", displayName: "OpenClaw", cliName: "openclaw", configPath: process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json") };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

function resolveGatewayReadyProbeTarget(rootConfig = {}) {
  const gateway = isPlainObject(rootConfig?.gateway) ? rootConfig.gateway : {};
  const envPort =
    process.env.OPENCLAW_GATEWAY_PORT ||
    process.env.MOLTBOT_GATEWAY_PORT ||
    process.env.CLAWDBOT_GATEWAY_PORT;
  const port = parsePositiveInteger(gateway.port ?? envPort, DEFAULT_GATEWAY_READY_PORT);
  const bind = typeof gateway.bind === "string" ? gateway.bind.trim().toLowerCase() : "";
  const customBindHost = typeof gateway.customBindHost === "string" ? gateway.customBindHost.trim() : "";
  const host = bind === "custom" && customBindHost ? customBindHost : "127.0.0.1";
  return { host, port, url: `http://${host}:${port}/ready` };
}

export async function waitForGatewayReady(rootConfig = {}, log = console, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 45000);
  const intervalMs = parsePositiveInteger(options.intervalMs, 300);
  const deadline = Date.now() + timeoutMs;
  const target = resolveGatewayReadyProbeTarget(rootConfig);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(target.url, {
        method: "GET",
        cache: "no-store",
      });
      if (response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (!body || body.ready !== false) return true;
      }
    } catch {
      // Ignore probe failures until timeout expires.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  log.warn?.(`[memos-cloud] Gateway readiness probe timed out at ${target.url}; config UI will not start yet.`);
  return false;
}

function shouldStartConfigUi() {
  const args = process.argv.map((value) => String(value || "").toLowerCase());
  const gatewayIndex = args.lastIndexOf("gateway");
  if (gatewayIndex === -1) return false;

  const nextArg = args[gatewayIndex + 1];
  if (!nextArg || nextArg.startsWith("-")) return true;
  return nextArg === "start" || nextArg === "restart";
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson5File(text, filePath) {
  const source = stripBom(String(text || "")).trim();
  if (!source) return {};

  try {
    const parsed = JSON.parse(source);
    if (!isPlainObject(parsed)) throw new Error("Root config must be an object.");
    return parsed;
  } catch {
    const script = new Script(`(${source}\n)`, { filename: filePath });
    const parsed = script.runInNewContext(Object.create(null), { timeout: 500 });
    if (!isPlainObject(parsed)) throw new Error("Root config must be an object.");
    return parsed;
  }
}

function hasIncludeDirective(value, depth = 0) {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasIncludeDirective(item, depth + 1));
  if (!isPlainObject(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "$include")) return true;
  return Object.values(value).some((child) => hasIncludeDirective(child, depth + 1));
}

function readGatewayConfig(profile) {
  let root = {};
  let fileExists = true;
  let stat = null;

  try {
    root = parseJson5File(readFileSync(profile.configPath, "utf8"), profile.configPath);
    stat = statSync(profile.configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fileExists = false;
  }

  const plugins = isPlainObject(root.plugins) ? root.plugins : {};
  const entries = isPlainObject(plugins.entries) ? plugins.entries : {};
  const entry = isPlainObject(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : null;
  const config = entry && isPlainObject(entry.config) ? deepClone(entry.config) : {};
  const enabled = entry ? entry.enabled !== false : true;

  return {
    profile,
    fileExists,
    configPath: profile.configPath,
    entryExists: Boolean(entry),
    enabled,
    config,
    root,
    hasInclude: hasIncludeDirective(root.plugins) || hasIncludeDirective(root),
    revision: createRevision({
      config,
      enabled,
      entryExists: Boolean(entry),
      fileExists,
      mtimeMs: stat?.mtimeMs ?? 0,
      size: stat?.size ?? 0,
    }),
  };
}

function writeGatewayConfig(profile, payload) {
  const current = readGatewayConfig(profile);
  const nextRoot = isPlainObject(current.root) ? deepClone(current.root) : {};
  if (!isPlainObject(nextRoot.plugins)) nextRoot.plugins = {};
  if (!isPlainObject(nextRoot.plugins.entries)) nextRoot.plugins.entries = {};

  const entry = { enabled: payload.enabled !== false };
  const config = sanitizeStructuredValue(payload.config ?? {});
  if (!isPlainObject(config)) throw new Error("Config payload must be an object.");
  if (Object.keys(config).length > 0) entry.config = config;

  nextRoot.plugins.entries[PLUGIN_ID] = entry;

  mkdirSync(dirname(profile.configPath), { recursive: true });
  writeFileSync(profile.configPath, `${JSON.stringify(nextRoot, null, 2)}\n`, "utf8");
  return readGatewayConfig(profile);
}

function buildStatePayload(service) {
  const state = readGatewayConfig(service.profile);
  const resolution = getConfigResolution(state.config);
  return {
    runtime: state.profile.id,
    runtimeDisplayName: state.profile.displayName,
    configPath: state.configPath,
    entryExists: state.entryExists,
    fileExists: state.fileExists,
    enabled: state.enabled,
    config: state.config,
    resolvedConfig: resolution.resolved,
    fieldMeta: resolution.fieldMeta,
    revision: state.revision,
    hasInclude: state.hasInclude,
    bootId: service.bootId,
    assetRevision: getAssetRevision(),
    port: service.port,
    url: service.url,
  };
}

function getCachedStatePayload(service, maxAgeMs = 1200) {
  const now = Date.now();
  if (service.stateCache && now - service.stateCache.createdAt < maxAgeMs) {
    return service.stateCache.payload;
  }
  const payload = buildStatePayload(service);
  service.stateCache = {
    createdAt: now,
    payload,
  };
  return payload;
}

function getCachedHeartbeatPayload(service, maxAgeMs = 1200) {
  const now = Date.now();
  if (service.heartbeatCache && now - service.heartbeatCache.createdAt < maxAgeMs) {
    return {
      ...service.heartbeatCache.payload,
      timestamp: now,
    };
  }
  const payload = {
    ok: true,
    runtime: service.profile.id,
    bootId: service.bootId,
    assetRevision: getAssetRevision(),
  };
  service.heartbeatCache = {
    createdAt: now,
    payload,
  };
  return {
    ...payload,
    timestamp: now,
  };
}

function loadAssetTemplate(name) {
  return readFileSync(join(ASSET_DIR, name), "utf8");
}

function getAssetRevision() {
  const files = ["index.html", "app.js", "app.css"];
  const parts = [];
  for (const name of files) {
    try {
      const stat = statSync(join(ASSET_DIR, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return createRevision(parts);
}

function replaceTokens(template, tokenMap) {
  let output = template;
  for (const [token, value] of Object.entries(tokenMap)) {
    output = output.split(token).join(value);
  }
  return output;
}

function jsonString(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getAccessibleUrls(port) {
  return [`http://127.0.0.1:${port}`];
}

function centerText(text, width) {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  const right = Math.max(0, width - text.length - left);
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function padBoxLine(content, visibleLength, width) {
  return `${ANSI_GREEN}| ${ANSI_RESET}${content}${" ".repeat(Math.max(0, width - visibleLength))}${ANSI_GREEN} |${ANSI_RESET}`;
}

function renderConfigAddressBanner(port) {
  const urls = getAccessibleUrls(port);
  const titleArt = [
  "  __  __   ______   __  __    ____     _____  ",
  " |  \\/  | |  ____| |  \\/  |  / __ \\   / ____| ",
  " | \\  / | | |__    | \\  / | | |  | | | (___   ",
  " | |\\/| | |  __|   | |\\/| | | |  | |  \\___ \\  ",
  " | |  | | | |____  | |  | | | |__| |  ____) | ",
  " |_|  |_| |______| |_|  |_|  \\____/  |_____/  "
];
  const heading = "Plugin Configuration";
  const urlLines = urls.map((url, index) => ` [${index + 1}] ${url}`);
  const plainLines = [
    "",
    ...titleArt,
    "",
    heading,
    "",
    "Plugin configuration page is ready.",
    "Open one of the following URLs in your browser:",
    "",
    ...urlLines,
    "",
    "Tip: keep this window open while you finish the setup.",
    "",
  ];
  const contentWidth = plainLines.reduce((max, line) => Math.max(max, line.length), 0);
  const centeredTitleArt = titleArt.map((line) => centerText(line, contentWidth));
  const centeredHeading = centerText(heading, contentWidth);
  const visibleLineWidths = [
    0,
    ...centeredTitleArt.map(() => contentWidth),
    0,
    contentWidth,
    contentWidth,
    "Plugin configuration page is ready.".length,
    "Open one of the following URLs in your browser:".length,
    0,
    ...urlLines.map((line) => line.length),
    0,
    "Tip: keep this window open while you finish the setup.".length,
    0,
  ];
  const separator = "-".repeat(contentWidth);
  const coloredLines = [
    "",
    ...centeredTitleArt.map((line) => `${ANSI_BOLD}${ANSI_CYAN}${line}${ANSI_RESET}`),
    "",
    `${ANSI_BOLD}${centeredHeading}${ANSI_RESET}`,
    `${ANSI_GREEN}${separator}${ANSI_RESET}`,
    "Plugin configuration page is ready.",
    "Open one of the following URLs in your browser:",
    "",
    ...urlLines.map((line) => `${ANSI_BOLD}${ANSI_GREEN}${line}${ANSI_RESET}`),
    "",
    "Tip: keep this window open while you finish the setup.",
    "",
  ];
  const horizontalBorder = `+${"=".repeat(contentWidth + 2)}+`;

  return `${ANSI_GREEN}${horizontalBorder}${ANSI_RESET}\n${coloredLines
    .map((line, index) => padBoxLine(line, visibleLineWidths[index], contentWidth))
    .join("\n")}\n${ANSI_GREEN}${horizontalBorder}${ANSI_RESET}`;
}

function renderHtml(service) {
  return replaceTokens(loadAssetTemplate("index.html"), {
    "__PLUGIN_ID__": PLUGIN_ID,
    "__APP_JS_URL__": `/app.js?token=${service.token}`,
  });
}

function renderAppJs(service) {
  return replaceTokens(loadAssetTemplate("app.js"), {
    "__CONFIG_UI_TOKEN__": jsonString(service.token),
    "__FIELD_GROUPS__": jsonString(FIELD_GROUPS),
    "__FIELD_DEFINITIONS__": jsonString(FIELD_DEFINITIONS),
  });
}

function installCleanupHooks() {
  const globalState = getGlobalState();
  if (globalState.cleanupInstalled) return;
  globalState.cleanupInstalled = true;

  const terminateChildImmediately = () => {
    const { child } = getGlobalState();
    if (!child?.pid) return;

    if (process.platform === "win32") {
      exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      return;
    }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill races during shutdown.
      }
    }
  };

  const closeSynchronously = () => {
    const globalState = getGlobalState();
    globalState.shuttingDown = true;
    const { service, child } = globalState;
    if (service?.server) {
      try {
        service.server.close();
      } catch {
        // Ignore close races during shutdown.
      }
    }
    if (child?.pid) {
      terminateChildImmediately();
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.once(signal, closeSynchronously);
  }
  process.once("beforeExit", closeSynchronously);
  process.once("exit", closeSynchronously);
}

function installGatewayRestartHook(log = console) {
  const globalState = getGlobalState();
  if (globalState.restartHookInstalled || process.env[CHILD_ENV_KEY] === "1") return;
  globalState.restartHookInstalled = true;

  process.on("SIGUSR1", () => {
    const state = getGlobalState();
    if (state.shuttingDown) return;
    if (state.recyclePromise) return;

    log.info?.("[memos-cloud] Gateway restart detected; recycling config UI service.");
    state.recyclePromise = closeConfigUiService({ clearRestartPending: false })
      .catch((error) => {
        log.warn?.(`[memos-cloud] Failed to close config UI during gateway restart: ${String(error?.message || error)}`);
      })
      .then(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 500);
          }),
      )
      .then(() => {
        const latestState = getGlobalState();
        if (latestState.shuttingDown) return null;
        latestState.recyclePromise = null;
        return waitForGatewayReady({}, log, { timeoutMs: 15000, intervalMs: 250 });
      })
      .then((ready) => {
        if (!ready) return null;
        log.info?.("[memos-cloud] Restarting config UI service after gateway recycle.");
        return ensureConfigUiService(log);
      })
      .catch((error) => {
        log.warn?.(`[memos-cloud] Failed to restart config UI after gateway recycle: ${String(error?.message || error)}`);
        return null;
      })
      .finally(() => {
        const latestState = getGlobalState();
        latestState.recyclePromise = null;
      });
  });
}

function markRestartPending(durationMs = 15000) {
  const globalState = getGlobalState();
  globalState.restartPending = true;
  if (globalState.restartTimer) {
    clearTimeout(globalState.restartTimer);
  }
  globalState.restartTimer = setTimeout(() => {
    const latestState = getGlobalState();
    latestState.restartPending = false;
    latestState.restartTimer = null;
  }, durationMs);
}

function clearRestartPending() {
  const globalState = getGlobalState();
  globalState.restartPending = false;
  if (globalState.restartTimer) {
    clearTimeout(globalState.restartTimer);
    globalState.restartTimer = null;
  }
}

function readHostLaunchContext() {
  const execPath = process.env[HOST_EXEC_PATH_ENV_KEY] || process.execPath;
  const fallbackArgv = Array.isArray(process.argv) ? [...process.argv] : [];

  try {
    const parsed = JSON.parse(process.env[HOST_ARGV_ENV_KEY] || "null");
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { execPath, argv: parsed.map((value) => String(value ?? "")) };
    }
  } catch {
    // Ignore malformed env and fall back to the current process argv.
  }

  return { execPath, argv: fallbackArgv.map((value) => String(value ?? "")) };
}

function buildGatewayRestartLaunch() {
  const { execPath, argv } = readHostLaunchContext();
  const args = argv.slice(1);
  const gatewayIndex = args.findIndex((value) => value.toLowerCase() === "gateway");
  const prefixArgs = gatewayIndex >= 0 ? args.slice(0, gatewayIndex) : args;
  return {
    filePath: execPath,
    args: [...prefixArgs, "gateway", "restart"],
  };
}

function requestGatewayRestartFromParent(log) {
  if (process.env[CHILD_ENV_KEY] !== "1") return false;
  if (typeof process.send !== "function") return false;

  try {
    process.send({ type: "request-restart" });
    log.info?.("[memos-cloud] Requested in-process gateway restart from parent process.");
    return true;
  } catch (error) {
    log.warn?.(`[memos-cloud] Failed to request in-process gateway restart: ${String(error?.message || error)}`);
    return false;
  }
}

function launchGatewayRestartInBackground(service, log) {
  try {
    const launch = buildGatewayRestartLaunch();
    const child = spawn(launch.filePath, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      shell: false,
      cwd: process.cwd(),
      env: { ...process.env, [CHILD_ENV_KEY]: "0" },
    });
    child.once("error", (error) => {
      clearRestartPending();
      log.warn?.(
        `[memos-cloud] Restart launcher failed for ${service.profile.displayName} gateway: ${String(error?.message || error)}`,
      );
    });
    child.once("exit", (code, signal) => {
      if (code && code !== 0) {
        clearRestartPending();
        log.warn?.(
          `[memos-cloud] Restart launcher exited early for ${service.profile.displayName} gateway (code=${code}, signal=${signal ?? "null"}).`,
        );
      }
    });
    child.unref();
    log.info?.(
      `[memos-cloud] Background restart command launched for ${service.profile.displayName} gateway using ${launch.filePath} ${launch.args.join(" ")}`,
    );
  } catch (error) {
    log.warn?.(`[memos-cloud] Failed to launch restart for ${service.profile.displayName} gateway: ${String(error)}`);
    throw error;
  }
}

function listenOnPort(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(port);
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function bindWithFallback(server) {
  for (let offset = 0; offset < UI_PORT_ATTEMPTS; offset += 1) {
    const port = UI_BASE_PORT + offset;
    try {
      await listenOnPort(server, UI_HOST, port);
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`Could not bind config UI after trying ${UI_PORT_ATTEMPTS} ports from ${UI_BASE_PORT}.`);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

function isAuthorized(req, service) {
  return req.headers["x-memos-config-token"] === service.token;
}

async function createService(log) {
  installCleanupHooks();
  const profile = detectRuntimeProfile();
  const token = randomBytes(24).toString("hex");
  const bootId = randomBytes(10).toString("hex");

  const service = { profile, token, bootId, port: 0, url: "", server: null, stateCache: null, heartbeatCache: null };

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (requestUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (requestUrl.pathname === "/icon.svg") {
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
        res.end(loadAssetTemplate("icon.svg"));
        return;
      }

      if (requestUrl.pathname === "/app.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
        res.end(loadAssetTemplate("app.css"));
        return;
      }

      if (requestUrl.pathname === "/app.js") {
        if (requestUrl.searchParams.get("token") !== service.token) {
          sendText(res, 403, "Forbidden");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderAppJs(service));
        return;
      }

      if (requestUrl.pathname === "/api/heartbeat" && req.method === "GET") {
        sendJson(res, 200, getCachedHeartbeatPayload(service));
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        if (!isAuthorized(req, service)) {
          sendText(res, 403, "Forbidden");
          return;
        }

        if (requestUrl.pathname === "/api/state" && req.method === "GET") {
          sendJson(res, 200, getCachedStatePayload(service));
          return;
        }

        if (requestUrl.pathname === "/api/save" && req.method === "POST") {
          let parsed = {};
          try {
            parsed = JSON.parse((await readRequestBody(req)) || "{}");
          } catch {
            sendText(res, 400, "Invalid JSON payload.");
            return;
          }
          if (!isPlainObject(parsed)) {
            sendText(res, 400, "Invalid JSON payload.");
            return;
          }
          if (typeof parsed.enabled !== "boolean") {
            sendText(res, 400, "Payload.enabled must be a boolean.");
            return;
          }
          if (!isPlainObject(parsed.config)) {
            sendText(res, 400, "Payload.config must be an object.");
            return;
          }

          const nextState = writeGatewayConfig(profile, parsed);
          service.stateCache = null;
          service.heartbeatCache = null;
          sendJson(res, 200, { ok: true, state: buildStatePayload({ ...service, profile: nextState.profile }) });
          return;
        }

        if (requestUrl.pathname === "/api/restart" && req.method === "POST") {
          const globalState = getGlobalState();
          if (globalState.restartPending) {
            sendJson(res, 200, { ok: true, deduped: true });
            return;
          }

          markRestartPending();
          sendJson(res, 200, { ok: true });
          setTimeout(() => {
            try {
              if (requestGatewayRestartFromParent(log)) return;
              launchGatewayRestartInBackground(service, log);
            } catch (error) {
              clearRestartPending();
              log.warn?.(`[memos-cloud] Restart launch failed: ${String(error?.message || error)}`);
            }
          }, 120);
          return;
        }

        sendText(res, 404, "Not found");
        return;
      }

      if (requestUrl.pathname !== "/") {
        sendText(res, 404, "Not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:;",
      });
      res.end(renderHtml(service));
    } catch (error) {
      sendText(res, 500, `Internal error: ${String(error?.message || error)}`);
    }
  });

  service.server = server;
  service.port = await bindWithFallback(server);
  service.url = `http://${UI_HOST}:${service.port}`;

  setTimeout(() => {
    console.log(renderConfigAddressBanner(service.port));
  }, 1200);
  return service;
}

function killProcessTree(pid) {
  if (!pid) return Promise.resolve();

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /T /F`, () => resolve());
    });
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore kill races.
    }
  }
  return Promise.resolve();
}

function waitForChildReady(child, log) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Config UI child process did not report ready state in time."));
    }, 12000);

    const onMessage = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        cleanup();
        resolve(child);
        return;
      }
      if (message.type === "error") {
        cleanup();
        reject(new Error(message.error || "Config UI child process failed."));
      }
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Config UI child process exited early (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);

    child.once("spawn", () => {
      log.info?.("[memos-cloud] Config UI child process attached to gateway.");
    });
  });
}

export function ensureConfigUiService(log = console) {
  if (process.env[CHILD_ENV_KEY] === "1") {
    return Promise.resolve(null);
  }
  if (!shouldStartConfigUi()) {
    return Promise.resolve(null);
  }
  installCleanupHooks();
  installGatewayRestartHook(log);

  const globalState = getGlobalState();
  if (globalState.recyclePromise) {
    return globalState.recyclePromise.then(() => ensureConfigUiService(log));
  }
  if (globalState.promise) return globalState.promise;

  let startupChild = null;
  globalState.promise = (() => {
    const child = spawn(process.execPath, [CHILD_ENTRY], {
      env: {
        ...process.env,
        [CHILD_ENV_KEY]: "1",
        [HOST_EXEC_PATH_ENV_KEY]: process.execPath,
        [HOST_ARGV_ENV_KEY]: JSON.stringify(process.argv),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });

    startupChild = child;
    globalState.child = child;
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type !== "request-restart") return;

      if (process.listenerCount("SIGUSR1") > 0) {
        log.info?.("[memos-cloud] Triggering in-process gateway restart via SIGUSR1.");
        process.emit("SIGUSR1");
        return;
      }

      log.warn?.("[memos-cloud] Parent gateway process has no SIGUSR1 listener; falling back to background CLI restart.");
      launchGatewayRestartInBackground({ profile: detectRuntimeProfile() }, log);
    });

    return waitForChildReady(child, log).then(() => child);
  })()
    .then((child) => {
      globalState.service = { child };
      return child;
    })
    .catch((error) => {
      globalState.child = null;
      globalState.service = null;
      globalState.promise = null;
      return killProcessTree(startupChild?.pid)
        .catch(() => {
          // Ignore cleanup races on failed startup.
        })
        .then(() => {
          throw error;
        });
    });

  return globalState.promise;
}

export async function closeConfigUiService(options = {}) {
  const globalState = getGlobalState();
  const clearRestartPending = options.clearRestartPending !== false;
  if (clearRestartPending) {
    if (globalState.restartTimer) {
      clearTimeout(globalState.restartTimer);
      globalState.restartTimer = null;
    }
    globalState.restartPending = false;
  }

  if (!globalState.service && !globalState.child) {
    globalState.promise = null;
    return;
  }

  const child = globalState.child;
  globalState.service = null;
  globalState.child = null;
  globalState.promise = null;

  if (!child) return;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.once("exit", finish);
    child.once("error", finish);

    try {
      child.send?.({ type: "shutdown" });
    } catch {
      // Fall through to forced kill timer.
    }

    setTimeout(async () => {
      await killProcessTree(child.pid);
      finish();
    }, 500);
  });
}

export async function runConfigUiChildProcess(log = console) {
  try {
    const service = await createService(log);

    const shutdown = async () => {
      try {
        await new Promise((resolve) => {
          service.server.close(() => resolve());
        });
      } catch {
        // Ignore close races during shutdown.
      }
    };

    process.on("message", async (message) => {
      if (message?.type !== "shutdown") return;
      await shutdown();
      process.exit(0);
    });

    process.once("disconnect", async () => {
      await shutdown();
      process.exit(0);
    });

    process.send?.({ type: "ready" });
    return service;
  } catch (error) {
    process.send?.({ type: "error", error: String(error?.message || error) });
    throw error;
  }
}
