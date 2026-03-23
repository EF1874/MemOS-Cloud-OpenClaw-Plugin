import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

const ARMS_ENDPOINT = "https://proj-xtrace-e218d9316b328f196a3c640cc7ca84-cn-hangzhou.cn-hangzhou.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1026429231103299-cn-hangzhou&service_id=a3u72ukxmr@bed68dd882dd823439015"
const ARMS_PID = "a3u72ukxmr@c42a249fb14f4d9";
const ARMS_ENV = "prod";
const ARMS_UID_FILE = new URL("../.memos_arms_uid", import.meta.url);

let armsUidCache = "";

function readUidFromFile() {
  try {
    return readFileSync(ARMS_UID_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeUidToFile(value) {
  try {
    writeFileSync(ARMS_UID_FILE, `${value}\n`, { mode: 0o600 });
  } catch {}
}

function createEventId() {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}`;
}

function normalizeMac(mac) {
  if (!mac || typeof mac !== "string") return "";
  const normalized = mac.trim().toLowerCase();
  if (!normalized || normalized === "00:00:00:00:00:00") return "";
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized)) return "";
  return normalized;
}

function loadMacHashedUid() {
  try {
    const interfaces = networkInterfaces();
    const macCandidates = [];
    for (const infos of Object.values(interfaces)) {
      if (!Array.isArray(infos)) continue;
      for (const info of infos) {
        if (!info || info.internal) continue;
        const mac = normalizeMac(info.mac);
        if (mac) macCandidates.push(mac);
      }
    }
    if (macCandidates.length === 0) return "";
    const source = [...new Set(macCandidates)].sort().join("|");
    const hashed = createHash("sha256").update(source).digest("hex");
    return `uid_${hashed.slice(0, 32)}`;
  } catch {
    return "";
  }
}

function loadArmsUid() {
  if (armsUidCache) return armsUidCache;
  const fromMac = loadMacHashedUid();
  if (fromMac) {
    armsUidCache = fromMac;
    writeUidToFile(armsUidCache);
    return armsUidCache;
  }
  const fromUidFile = readUidFromFile();
  if (fromUidFile) {
    armsUidCache = fromUidFile;
    return armsUidCache;
  }
  armsUidCache = `uid_${randomUUID()}`;
  writeUidToFile(armsUidCache);
  return armsUidCache;
}

function buildPayload(ctx, eventName, payload) {
  return {
    app: {
      id: ARMS_PID,
      env: ARMS_ENV,
      type: "node",
    },
    user: { id: loadArmsUid() },
    session: { id: ctx.sessionId },
    net: {},
    view: { id: "plugin", name: "memos-cloud-openclaw" },
    events: [
      {
        event_id: createEventId(),
        event_type: 'custom',
        type: "memos_plugin",
        group: "memos_cloud",
        name: eventName,
        timestamp: +new Date(),
        properties: { ...payload }
      }
    ]
  };
}

export async function reportRumEvent(eventName, payload, cfg, ctx, log) {
  if (!cfg.rumEnabled) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Number.isFinite(cfg.rumTimeoutMs) ? Math.max(1000, cfg.rumTimeoutMs) : 3000,
  );
  const body = buildPayload(ctx, eventName, payload)

  try {
    const res = await fetch(ARMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    log.warn?.(`[memos-cloud] RUM report failed: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
