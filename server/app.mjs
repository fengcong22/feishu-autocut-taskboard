import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket as WebSocketClient, WebSocketServer } from "ws";

import {
  DEFAULT_PROJECT_ID,
  JIRA_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { discoverAiCatalog, resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
import { decodeComposerReferenceKey } from "./composer-reference.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import { createFeishuPackageStore } from "./feishu-package-config.mjs";
import { createFeishuPackageApi } from "./feishu-package-api.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, TaskboardDatabase } from "./database.mjs";
import { createJiraConfigStore } from "./jira-config.mjs";
import { createJiraIntegration } from "./jira-integration.mjs";
import { ProjectSummaryService } from "./project-summary.mjs";
import { codexInvocation } from "../shared/codex-invocation.mjs";
import { createFeishuWorkflowStore, subjectProjectId } from "./feishu-workflow-store.mjs";
import { createFeishuWorkflowApi } from "./feishu-workflow-api.mjs";
import { createResourceScheduler } from "./resource-scheduler.mjs";
import { createFeishuExecutionCoordinator } from "./feishu-execution-coordinator.mjs";
import { ArtifactServiceError, createArtifactService } from "./artifact-service.mjs";
import { createArtifactUploadWorker } from "./upload-worker.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const PROJECT_README_BODY_LIMIT = 3 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const HOST_RUNTIME_TTL_MS = 3_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FEISHU_PREVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SAFE_FEISHU_SYNC_ERROR_CODES = new Set([
  "BASE_NOT_FOUND",
  "FIELD_NOT_FOUND",
  "FEISHU_METADATA_INVALID_RESPONSE",
  "FEISHU_METADATA_READ_FAILED",
  "FEISHU_METADATA_UNAVAILABLE",
  "FEISHU_TABLE_NOT_FOUND",
  "INVALID_FIELD",
  "WORKFLOW_CONFIG_VERSION_MISMATCH",
  "WORKFLOW_PACKAGE_ALIAS_UNBOUND",
  "WORKFLOW_SUBJECT_NOT_FOUND",
  "WORKFLOW_SYNC_UNAVAILABLE",
]);
const SAFE_FEISHU_PREVIEW_ERRORS = new Map([
  ["INVALID_BASE_LINK", { status: 400, message: "请输入有效的飞书多维表格或知识库链接" }],
  ["FEISHU_WIKI_NOT_BASE", { status: 400, message: "该知识库链接不是多维表格" }],
  ["FEISHU_TABLE_NOT_FOUND", { status: 400, message: "链接中的子表不存在" }],
  ["FEISHU_METADATA_UNAVAILABLE", { status: 503, message: "飞书多维表格读取服务尚未配置" }],
  ["FEISHU_METADATA_CLIENT_INVALID", { status: 502, message: "飞书多维表格读取服务不可用" }],
  ["FEISHU_METADATA_INVALID_RESPONSE", { status: 502, message: "飞书返回了无法识别的多维表格信息" }],
  ["FEISHU_METADATA_READ_FAILED", { status: 502, message: "无法读取飞书多维表格，请检查应用权限" }],
]);
const BRIDGE_DIAGNOSTIC_PATH_PATTERN = /^bases\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const BRIDGE_DIAGNOSTIC_MESSAGES = new Map([
  ["BASE_NOT_FOUND", "The configured Base is not available in Feishu"],
  ["TABLE_NOT_FOUND", "The configured subject table is not present in this Base"],
  ["FIELD_NOT_FOUND", "A configured field is not present in the live subject table"],
  ["FEISHU_METADATA_UNAVAILABLE", "Live Feishu metadata could not be verified"],
  ["PACKAGE_ALIAS_UNAVAILABLE", "The Auto-Cut package alias is not configured for the Bridge"],
  ["PACKAGE_WORKSPACE_PATH_UNBOUND", "The Bridge Auto-Cut package workspace is not bound on this machine"],
  ["ARTIFACT_SOURCE_PATH_UNBOUND", "The ZIP artifact source path is not bound on this machine"],
  ["UPLOAD_TARGET_PATH_UNBOUND", "The upload target path is not bound on this machine"],
]);
const PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX = "taskboard.project-board-display-settings.v3.";
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const TRUSTED_ORIGINS_ENV = "CODEX_TASKBOARD_TRUSTED_ORIGINS";
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function bridgeShareDiagnosticContext(configuration) {
  const aliases = new Set();
  const paths = new Set();
  for (const base of Array.isArray(configuration?.bases) ? configuration.bases : []) {
    const basePath = `bases.${base.baseToken}`;
    paths.add(basePath);
    for (const subject of Array.isArray(base.subjects) ? base.subjects : []) {
      const subjectPath = `${basePath}.subjects.${subject.tableId}`;
      for (const suffix of [
        "", ".fields", ".trigger.fieldId", ".title.fieldId", ".subjectCode.fieldId",
        ".packageRoute", ".upload.artifactSourcePath", ".upload.targetPath",
      ]) paths.add(`${subjectPath}${suffix}`);
      if (typeof subject.packageRoute?.packageAlias === "string") {
        aliases.add(subject.packageRoute.packageAlias);
      }
      for (const alias of Object.values(subject.packageRoute?.branchMap ?? {})) {
        if (typeof alias === "string") aliases.add(alias);
      }
    }
  }
  return { aliases, paths };
}

function normalizeBridgeShareDiagnostics(value, configuration) {
  if (!Array.isArray(value)) {
    throw new ApiError(502, "FEISHU_WORKFLOW_SHARE_IMPORT_FAILED", "Feishu workflow share inspection failed");
  }
  const context = bridgeShareDiagnosticContext(configuration);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !BRIDGE_DIAGNOSTIC_MESSAGES.has(entry.code)
      || !["info", "warning", "error"].includes(entry.severity)
      || typeof entry.message !== "string" || entry.message.trim() === "") {
      throw new ApiError(502, "FEISHU_WORKFLOW_SHARE_IMPORT_FAILED", "Feishu workflow share inspection failed");
    }
    const diagnostic = {
      code: entry.code,
      severity: entry.severity,
      message: BRIDGE_DIAGNOSTIC_MESSAGES.get(entry.code)
        ?? "Feishu Bridge reported a workflow configuration problem",
    };
    if (typeof entry.path === "string"
      && BRIDGE_DIAGNOSTIC_PATH_PATTERN.test(entry.path)
      && context.paths.has(entry.path)) {
      diagnostic.path = entry.path;
    }
    if (typeof entry.alias === "string"
      && entry.alias.trim() !== ""
      && !/^[./\\]/u.test(entry.alias)
      && !/[\u0000-\u001f\u007f"'`:$<>|]/u.test(entry.alias)
      && context.aliases.has(entry.alias)) {
      diagnostic.alias = entry.alias.trim();
    }
    return diagnostic;
  });
}

function safeFeishuSyncErrorCode(value) {
  return typeof value === "string" && SAFE_FEISHU_SYNC_ERROR_CODES.has(value)
    ? value
    : "FEISHU_WORKFLOW_SYNC_FAILED";
}

function feishuPreviewError(payload) {
  const code = payload?.error?.code;
  const safe = typeof code === "string" ? SAFE_FEISHU_PREVIEW_ERRORS.get(code) : null;
  return safe
    ? new ApiError(safe.status, code, safe.message)
    : new ApiError(502, "FEISHU_METADATA_READ_FAILED", "Feishu Base metadata preview failed");
}

function isFeishuPreviewText(value) {
  return typeof value === "string"
    && value.trim() !== ""
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isFeishuPreviewId(value) {
  return typeof value === "string" && FEISHU_PREVIEW_ID_PATTERN.test(value.trim());
}

function normalizeFeishuPreviewFieldType(value) {
  if (value === null) return null;
  if (Number.isInteger(value)) return value;
  if (isFeishuPreviewText(value)) return value.trim();
  return undefined;
}

function normalizeFeishuPreviewPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isFeishuPreviewId(value.baseToken)
    || !isFeishuPreviewText(value.baseName)
    || !Array.isArray(value.tables)) return null;

  const metadataRefreshedAt = value.metadataRefreshedAt ?? null;
  if (metadataRefreshedAt !== null
    && (!Number.isSafeInteger(metadataRefreshedAt) || metadataRefreshedAt < 0)) return null;

  const tableIds = new Set();
  const tables = [];
  for (const table of value.tables) {
    if (!table || typeof table !== "object" || Array.isArray(table)
      || !isFeishuPreviewId(table.tableId)
      || !isFeishuPreviewText(table.tableName)
      || !Array.isArray(table.fields)) return null;
    const tableId = table.tableId.trim();
    if (tableIds.has(tableId)) return null;
    tableIds.add(tableId);

    const fieldIds = new Set();
    const fields = [];
    for (const field of table.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)
        || !isFeishuPreviewId(field.fieldId)
        || !isFeishuPreviewText(field.fieldName)
        || !Object.hasOwn(field, "type")
        || !Object.hasOwn(field, "uiType")
        || !Array.isArray(field.options)) return null;
      const fieldId = field.fieldId.trim();
      if (fieldIds.has(fieldId)) return null;
      fieldIds.add(fieldId);
      const type = normalizeFeishuPreviewFieldType(field.type);
      const uiType = field.uiType === null
        ? null
        : isFeishuPreviewText(field.uiType) ? field.uiType.trim() : undefined;
      if (type === undefined || uiType === undefined) return null;

      const optionIds = new Set();
      const options = [];
      for (const option of field.options) {
        if (!option || typeof option !== "object" || Array.isArray(option)
          || !isFeishuPreviewId(option.id)
          || !isFeishuPreviewText(option.name)
          || (option.color !== undefined && !Number.isInteger(option.color))) return null;
        const optionId = option.id.trim();
        if (optionIds.has(optionId)) return null;
        optionIds.add(optionId);
        const normalized = { id: optionId, name: option.name.trim() };
        if (option.color !== undefined) normalized.color = option.color;
        options.push(normalized);
      }
      fields.push({
        fieldId,
        fieldName: field.fieldName.trim(),
        type,
        uiType,
        options,
      });
    }
    tables.push({ tableId, tableName: table.tableName.trim(), fields });
  }

  return {
    baseToken: value.baseToken.trim(),
    baseName: value.baseName.trim(),
    metadataRefreshedAt,
    tables,
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function parseTrustedOrigins(value) {
  if (value === undefined) return new Set();
  const configured = String(value).trim();
  if (!configured) {
    throw new Error(`${TRUSTED_ORIGINS_ENV} must not be empty when configured`);
  }

  const origins = new Set();
  for (const rawOrigin of configured.split(",")) {
    const origin = rawOrigin.trim();
    if (!origin || origin.includes("*")) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must be a comma-separated list of exact HTTPS origins`);
    }
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must contain valid HTTPS origins`);
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must contain exact HTTPS origins without paths, queries, fragments, or credentials`);
    }
    if (origins.has(url.origin)) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must not contain duplicate origins`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function parseRequestHost(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  let url;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname
  ) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  return { hostname: url.hostname, httpsOrigin: url.origin };
}

function assertTrustedNetworkRequest(request, allowOpaqueOrigin = false, trustedOrigins = new Set()) {
  const host = parseRequestHost(request.headers.host);
  const trustedNetworkHost = isTrustedNetworkHost(host.hostname);
  const configuredTrustedHost = !trustedNetworkHost && trustedOrigins.has(host.httpsOrigin);
  if (!trustedNetworkHost && !configuredTrustedHost) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }

  const origin = request.headers.origin;
  const configuredTrustedOrigin = trustedOrigins.has(origin);
  if (origin && !configuredTrustedOrigin && !TRUSTED_EMBED_ORIGINS.has(origin)) {
    if (!(allowOpaqueOrigin && origin === "null")) {
      let originHost;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
      }
      if (!isTrustedNetworkHost(originHost)) {
        throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
      }
    }
  }
  return configuredTrustedHost || configuredTrustedOrigin;
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function parseAfterCursor(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(["after"]), routeLabel);
  const value = searchParams.get("after");
  if (value === null) return null;
  const revision = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor must be a non-negative integer revision");
  }
  return { value, revision };
}

function nextCursor(items, after) {
  if (items.length === 0) return after?.value ?? "0";
  return String(items.reduce(
    (revision, item) => Math.max(revision, item.changeRevision),
    0,
  ));
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function hasMatchingSecret(expected, supplied) {
  if (typeof expected !== "string" || expected.length === 0
    || typeof supplied !== "string" || supplied.length === 0) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

function assertFeishuBridgeRequest(request, expectedSecret) {
  assertAiLoopbackRequest(request);
  if (typeof expectedSecret !== "string" || expectedSecret.length === 0) {
    throw new ApiError(
      503,
      "FEISHU_BRIDGE_SECRET_NOT_CONFIGURED",
      "The local Feishu Bridge secret is not configured",
    );
  }
  if (request.headers["x-taskboard-client"] !== "feishu-bridge"
    || !hasMatchingSecret(expectedSecret, request.headers["x-feishu-bridge-secret"])) {
    throw new ApiError(403, "FEISHU_BRIDGE_AUTH_FAILED", "Feishu Bridge authentication failed");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseProjectReadmeSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["content", "version"]));
  const content = body.content ?? "";
  if (typeof content !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "'content' must be a string");
  }
  if (content.length > 500_000) {
    throw new ApiError(400, "INVALID_FIELD", "'content' cannot exceed 500000 characters");
  }
  const version = body.version;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return { content, version };
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.codexProjectKind must be local or remote");
  }
  if (
    (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.headers["x-taskboard-client"] === "taskctl") {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user or codex-agent");
  }
  return value;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "projectId", "title", "description", "status", "priority", "labels", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const threadBinding = parseThreadBinding(body.threadBinding);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, threadBinding, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseRelationOrigin(value) {
  if (value === undefined) return undefined;
  if (value !== "manual" && value !== "mention") {
    throw new ApiError(400, "INVALID_FIELD", "'origin' must be manual or mention");
  }
  return value;
}

function parseRelationMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding", "origin"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    origin: parseRelationOrigin(body.origin),
  };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseAttachmentHeaders(request, { requireKind = true } = {}) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  const kind = request.headers["x-taskboard-attachment-kind"] ?? (
    requireKind ? null : "attachment"
  );
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Taskboard-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

function parseArtifactHeaders(request) {
  const metadata = parseAttachmentHeaders(request, { requireKind: false });
  if (!metadata.filename.toLowerCase().endsWith(".zip")) {
    throw new ApiError(400, "INVALID_ARTIFACT_TYPE", "Artifact must be a .zip file");
  }
  return metadata;
}

function parseArtifactUploadEnqueue(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["artifactId"]));
  return {
    artifactId: stringField(body.artifactId, "artifactId", { required: true, maxLength: 256 }),
  };
}

function parseArtifactUploadRetry(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["uploadId"]));
  return {
    uploadId: stringField(body.uploadId, "uploadId", { required: true, maxLength: 256 }),
  };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseArtifactUploadListFilters(searchParams) {
  const keys = [...searchParams.keys()];
  if (keys.some((key) => key !== "projectId")) {
    throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Upload views accept only 'projectId'");
  }
  if (searchParams.getAll("projectId").length !== 1) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Upload views require one 'projectId'");
  }
  return { projectId: validateProjectId(searchParams.get("projectId")) };
}

function parseTaskTreeQuery(searchParams) {
  const allowed = new Set(["direction", "depth"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_TREE_QUERY", `Query parameter '${key}' cannot be repeated`);
    }
  }
  const direction = searchParams.get("direction");
  if (direction !== "descendants" && direction !== "ancestors") {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'direction' must be descendants or ancestors");
  }
  const rawDepth = searchParams.get("depth");
  const depth = Number(rawDepth);
  if (!/^\d+$/.test(rawDepth ?? "") || !Number.isSafeInteger(depth) || depth < 1 || depth > 25) {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'depth' must be an integer from 1 to 25");
  }
  return { direction, depth };
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiExecutionTarget(value) {
  const fields = [
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ];
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== fields.length) {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "Codex project identity must contain all four fields");
  }
  const codexProjectKind = parseAiSetting(value.codexProjectKind, "codexProjectKind", 16);
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "'codexProjectKind' must be local or remote");
  }
  const workspacePath = parseAiSetting(value.workspacePath, "workspacePath", 4096);
  if (workspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "'workspacePath' cannot contain null bytes");
  }
  return {
    codexProjectId: parseAiSetting(value.codexProjectId, "codexProjectId", 256),
    codexProjectKind,
    codexHostId: parseAiSetting(value.codexHostId, "codexHostId", 512),
    workspacePath,
  };
}

function aiExecutionTargetFromQuery(searchParams) {
  return parseAiExecutionTarget({
    codexProjectId: searchParams.get("codexProjectId") ?? undefined,
    codexProjectKind: searchParams.get("codexProjectKind") ?? undefined,
    codexHostId: searchParams.get("codexHostId") ?? undefined,
    workspacePath: searchParams.get("workspacePath") ?? undefined,
  });
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
    ...parseAiExecutionTarget(body),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  if (body.contractVersion !== undefined) return parseComposerTurn(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

function parseFeishuTaskMetadata(description) {
  if (typeof description !== "string") return null;
  const marker = "<!-- feishu-codex-task:";
  const start = description.indexOf(marker);
  if (start < 0) return null;
  const end = description.indexOf("-->", start + marker.length);
  if (end < 0) return null;
  try {
    const encoded = description.slice(start + marker.length, end).trim();
    let metadata;
    if (encoded.startsWith("v1:")) {
      metadata = JSON.parse(Buffer.from(encoded.slice(3), "base64url").toString("utf8"));
    } else {
      metadata = JSON.parse(encoded);
    }
    if (
      !metadata
      || typeof metadata !== "object"
      || metadata.source !== "feishu-base"
      || (metadata.packageAlias !== undefined
        && (typeof metadata.packageAlias !== "string" || metadata.packageAlias.trim() === ""))
      || (metadata.packageSource !== undefined
        && (typeof metadata.packageSource !== "string" || metadata.packageSource.trim() === ""))
    ) return null;
    return {
      ...(typeof metadata.packageAlias === "string" ? { packageAlias: metadata.packageAlias.trim() } : {}),
      ...(typeof metadata.packageSource === "string" ? { packageSource: metadata.packageSource.trim() } : {}),
      version: metadata.version === undefined ? 1 : metadata.version,
      source: "feishu-base",
      baseToken: typeof metadata.baseToken === "string" ? metadata.baseToken.trim() : "",
      tableId: typeof metadata.tableId === "string" ? metadata.tableId.trim() : "",
      recordId: typeof metadata.recordId === "string" ? metadata.recordId.trim() : "",
      eventId: typeof metadata.eventId === "string" ? metadata.eventId.trim() : "",
      ...(typeof metadata.triggerField === "string" && metadata.triggerField.trim()
        ? { triggerField: metadata.triggerField.trim() } : {}),
      ...(typeof metadata.triggerFieldId === "string" && metadata.triggerFieldId.trim()
        ? { triggerFieldId: metadata.triggerFieldId.trim() } : {}),
      ...(typeof metadata.triggerValue === "string" && metadata.triggerValue.trim()
        ? { triggerValue: metadata.triggerValue.trim() } : {}),
      mode: metadata.mode === "automatic" ? "automatic" : "manual",
      ...(typeof metadata.subjectKey === "string" && metadata.subjectKey.trim()
        ? { subjectKey: metadata.subjectKey.trim() } : {}),
      ...(Number.isSafeInteger(metadata.configVersion) && metadata.configVersion > 0
        ? { configVersion: metadata.configVersion } : {}),
      ...(metadata.executionMode === "automatic" || metadata.executionMode === "manual"
        ? { executionMode: metadata.executionMode } : {}),
      ...(metadata.uploadMode === "automatic" || metadata.uploadMode === "manual"
        ? { uploadMode: metadata.uploadMode } : {}),
      ...(typeof metadata.concurrencyGroup === "string" && metadata.concurrencyGroup.trim()
        ? { concurrencyGroup: metadata.concurrencyGroup.trim() } : {}),
      ...(Number.isSafeInteger(metadata.maxConcurrent) && metadata.maxConcurrent > 0
        ? { maxConcurrent: metadata.maxConcurrent } : {}),
      ...(Array.isArray(metadata.resourceGroups)
        ? { resourceGroups: metadata.resourceGroups.filter((group) => typeof group === "string" && group.trim() !== "") }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseStartAiBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set());
  return {};
}

function parseExecutionBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["trigger"]));
  const trigger = body.trigger ?? "manual";
  if (!["manual", "move", "automatic"].includes(trigger)) {
    throw new ApiError(400, "INVALID_FIELD", "'trigger' must be manual, move, or automatic");
  }
  return { trigger };
}

function parseComposerCandidateQuery(searchParams) {
  assertAllowedQuery(
    searchParams,
    new Set([
      "projectId",
      "threadId",
      "trigger",
      "query",
      "surface",
      "codexProjectId",
      "codexProjectKind",
      "codexHostId",
      "workspacePath",
    ]),
    "GET /api/local/ai/composer/candidates",
  );
  let projectId;
  const rawProjectId = searchParams.get("projectId");
  if (rawProjectId !== null) {
    try {
      projectId = validateProjectId(rawProjectId);
    } catch {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project id is invalid");
    }
  }
  const trigger = searchParams.get("trigger");
  if (trigger !== "/" && trigger !== "@") {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer trigger must be '/' or '@'");
  }
  const query = searchParams.get("query") ?? "";
  if (query.length > 256) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer query cannot exceed 256 characters");
  }
  let threadId;
  try {
    threadId = parseThreadId(searchParams.get("threadId") ?? undefined);
  } catch {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread id is invalid");
  }
  const surface = searchParams.get("surface") ?? "ai-chat";
  if (!new Set(["ai-chat", "issue-description", "comment"]).has(surface)) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer surface is invalid");
  }
  return {
    projectId,
    threadId,
    trigger,
    query,
    surface,
    ...aiExecutionTargetFromQuery(searchParams),
  };
}

function invalidComposerRebindRequest(message) {
  return new ApiError(400, "INVALID_COMPOSER_REBIND_REQUEST", message);
}

function assertComposerRebindKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidComposerRebindRequest(`'${field}.${key}' is not allowed`);
    }
  }
}

function parseComposerRebindRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidComposerRebindRequest("Composer rebind body must be an object");
  }
  assertComposerRebindKeys(
    value,
    new Set(["contractVersion", "projectId", "threadId", "document"]),
    "body",
  );
  if (value.contractVersion !== "composer.v1") {
    throw invalidComposerRebindRequest("'contractVersion' must be 'composer.v1'");
  }
  let projectId;
  try {
    projectId = validateProjectId(value.projectId);
  } catch {
    throw invalidComposerRebindRequest("'projectId' is invalid");
  }
  let threadId;
  try {
    threadId = parseThreadId(value.threadId);
  } catch {
    throw invalidComposerRebindRequest("'threadId' is invalid");
  }
  const document = value.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidComposerRebindRequest("'document' must be an object");
  }
  assertComposerRebindKeys(document, new Set(["version", "nodes"]), "document");
  if (document.version !== 1) {
    throw invalidComposerRebindRequest("'document.version' must be 1");
  }
  if (!Array.isArray(document.nodes) || document.nodes.length > 200) {
    throw invalidComposerRebindRequest("'document.nodes' must contain at most 200 entries");
  }
  let textLength = 0;
  const nodes = document.nodes.map((node, nodeIndex) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}]' must be an object`);
    }
    if (node.type === "text") {
      assertComposerRebindKeys(node, new Set(["type", "text"]), `document.nodes[${nodeIndex}]`);
      if (typeof node.text !== "string") {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].text' must be a string`);
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "unsupportedReference") {
      assertComposerRebindKeys(
        node,
        new Set(["type", "referenceUri", "label"]),
        `document.nodes[${nodeIndex}]`,
      );
      if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
      }
      if (typeof node.referenceUri !== "string" || node.referenceUri.length > 1_024) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is invalid`,
        );
      }
      const match = /^taskboard:\/\/composer-reference\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        node.referenceUri,
      );
      if (!match) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is not a composer reference marker`,
        );
      }
      try {
        decodeComposerReferenceKey(match[3]);
      } catch {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' has an invalid reference key`,
        );
      }
      const reasonCode = match[1] !== "v1"
        ? "REFERENCE_FORMAT_UNSUPPORTED"
        : !new Set(["skill", "agent"]).has(match[2])
          ? "REFERENCE_KIND_UNSUPPORTED"
          : null;
      if (!reasonCode) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}]' must use persistedReference for supported markers`,
        );
      }
      return {
        type: "unsupportedReference",
        referenceUri: node.referenceUri,
        label: node.label,
        reasonCode,
      };
    }
    if (node.type !== "persistedReference") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].type' must be text, persistedReference or unsupportedReference`,
      );
    }
    assertComposerRebindKeys(
      node,
      new Set(["type", "referenceKind", "referenceKey", "label"]),
      `document.nodes[${nodeIndex}]`,
    );
    if (node.referenceKind !== "skill" && node.referenceKind !== "agent") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKind' must be skill or agent`,
      );
    }
    if (
      typeof node.referenceKey !== "string"
      || node.referenceKey.length === 0
      || node.referenceKey.length > 512
    ) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is invalid`,
      );
    }
    if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
    }
    let stableId;
    try {
      stableId = decodeComposerReferenceKey(node.referenceKey);
    } catch {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is not canonical base64url`,
      );
    }
    if (node.referenceKind === "skill" && stableId !== stableId.normalize("NFC")) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' does not contain an NFC Skill name`,
      );
    }
    return {
      type: "persistedReference",
      referenceKind: node.referenceKind,
      referenceKey: node.referenceKey,
      label: node.label,
      stableId,
    };
  });
  if (textLength > 100_000) {
    throw invalidComposerRebindRequest("Composer text cannot exceed 100000 characters");
  }
  return {
    contractVersion: "composer.v1",
    projectId,
    threadId,
    document: { version: 1, nodes },
  };
}

async function resolveComposerRebindWorkspace(aiChat, input) {
  let thread;
  if (input.threadId !== undefined) {
    try {
      thread = aiChat.getThread(input.threadId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread does not exist");
      }
      throw error;
    }
    if (thread.origin.projectId !== input.projectId) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread does not belong to the selected project",
      );
    }
    if (thread.origin.codexProjectKind !== "remote") {
      try {
        if (!(await stat(thread.origin.workspacePath)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ApiError(
          409,
          "PROJECT_WORKSPACE_UNAVAILABLE",
          "The conversation workspace is not available on this device",
        );
      }
    }
    return {
      workspacePath: thread.origin.workspacePath,
      composerCatalog: aiChat.composerCatalogForThread(thread),
    };
  }
  let resolved;
  try {
    resolved = await aiChat.resolveContext(input.projectId, thread?.origin.issueId);
  } catch (error) {
    if (
      error instanceof ApiError
      && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)
    ) {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
    }
    throw error;
  }
  return { workspacePath: resolved.workspacePath, composerCatalog: aiChat.composerCatalog };
}

function parseComposerDocument(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "nodes"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_COMPOSER_DOCUMENT", "'document.version' must be 1");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > 200) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'document.nodes' must be an array with at most 200 entries",
    );
  }
  let textLength = 0;
  const nodes = value.nodes.map((node, index) => {
    assertPlainObject(node);
    if (typeof node.type !== "string" || !node.type) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        `'document.nodes[${index}].type' is required`,
      );
    }
    if (node.type === "text") {
      assertAllowedKeys(node, new Set(["type", "text"]));
      if (typeof node.text !== "string") {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_DOCUMENT",
          `'document.nodes[${index}].text' must be a string`,
        );
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "skill" || node.type === "agent") {
      assertAllowedKeys(node, new Set(["type", "candidateRef", "label"]));
      return {
        type: node.type,
        candidateRef: stringField(
          node.candidateRef,
          `document.nodes[${index}].candidateRef`,
          { required: true, maxLength: 512 },
        ),
        label: stringField(node.label, `document.nodes[${index}].label`, {
          required: true,
          maxLength: 256,
        }),
      };
    }
    return { type: node.type };
  });
  if (textLength > 100_000) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "Composer text cannot exceed 100000 characters",
    );
  }
  return { version: 1, nodes };
}

function parseComposerTurn(body) {
  assertAllowedKeys(body, new Set([
    "contractVersion",
    "revision",
    "document",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (body.contractVersion !== "composer.v1") {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'contractVersion' must be 'composer.v1'",
    );
  }
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  return {
    contractVersion: "composer.v1",
    revision: stringField(body.revision, "revision", { required: true, maxLength: 512 }),
    document: parseComposerDocument(body.document),
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments: parseAiAttachments(body.attachments),
  };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

async function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      if (line.startsWith("prunable")) prunable = true;
    }
    if (!worktreePath || prunable) continue;
    try {
      await stat(worktreePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath, processEnv = process.env) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      env: environment,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...(await parseWorktrees(worktreesResult.stdout)),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath, processEnv) {
  const entries = await new Promise((resolve, reject) => {
    const invocation = codexInvocation(codexExecutable, ["app-server", "--stdio"]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: workspacePath,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable, processEnv) {
  const invocation = codexInvocation(codexExecutable, ["mcp", "list", "--json"]);
  const result = await execFileAsync(invocation.command, invocation.args, {
    env: processEnv,
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath, processEnv) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath, processEnv),
    discoverMcpServers(resolved.codexExecutable, processEnv),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const environment = options.processEnv ?? process.env;
  const configuredDataDirectory = options.dataDirectory ?? environment.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const instanceToken = String(
    options.instanceToken ?? environment.CODEX_TASKBOARD_INSTANCE_TOKEN ?? "",
  ).trim();
  if (instanceToken && !/^[a-z0-9-]{16,128}$/i.test(instanceToken)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_TOKEN must be an identifier");
  }
  const instanceSecret = String(
    options.instanceSecret ?? environment.CODEX_TASKBOARD_INSTANCE_SECRET ?? "",
  ).trim();
  if (instanceToken && !/^[a-f0-9-]{32,128}$/i.test(instanceSecret)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_SECRET must be set in launcher mode");
  }
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    artifactsDirectory: options.artifactsDirectory ?? path.join(dataDirectory, "artifacts"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    feishuPackagesPath: options.feishuPackagesPath
      ?? process.env.CODEX_FEISHU_PACKAGES_PATH
      ?? path.join(dataDirectory, "feishu-packages.json"),
    feishuBridgeUrl: options.feishuBridgeUrl
      ?? process.env.CODEX_FEISHU_BRIDGE_URL
      ?? "http://127.0.0.1:47824",
    feishuBridgeSecret: options.feishuBridgeSecret
      ?? process.env.CODEX_FEISHU_BRIDGE_SECRET
      ?? null,
    jiraConfigPath: options.jiraConfigPath ?? path.join(dataDirectory, "jira-connection.json"),
    clientStoragePath: options.clientStoragePath ?? path.join(dataDirectory, "client-storage.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath
      ?? environment.CODEX_TASKBOARD_SKILL_PATH
      ?? path.join(PROJECT_ROOT, "skills", "manage-taskboard", "SKILL.md"),
    codexExecutable: resolveCodexExecutable({ explicit: options.codexExecutable }),
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    instanceToken,
    instanceSecret,
    trustedOrigins: parseTrustedOrigins(environment[TRUSTED_ORIGINS_ENV]),
    version: String(
      options.version ?? environment.CODEX_TASKBOARD_VERSION ?? "development",
    ).trim(),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "127.0.0.1") {
  const host = String(value).trim();
  if (host !== "127.0.0.1") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1");
  }
  return host;
}

export function assertLoopbackListenAddress(address) {
  if (
    !address
    || typeof address === "string"
    || address.address !== "127.0.0.1"
  ) {
    throw new Error("Taskboard inherited listener must be bound to 127.0.0.1");
  }
  return address;
}

/**
 * Automatic Auto-Cut execution is a deployment policy, not a task-provided
 * flag.  Keep it disabled by default and accept only an explicit opt-in value
 * from the launcher environment (or a boolean supplied by tests/embedders).
 */
export function resolveAutomaticExecution(value = process.env.CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const codexProcessEnvironment = withoutTaskboardLauncherEnvironment(
    options.processEnv ?? process.env,
  );
  const routePrefix = resolved.instanceToken ? `/${resolved.instanceToken}` : "";
  const database = new TaskboardDatabase(resolved.databasePath);
  const artifactService = options.artifactService ?? createArtifactService({
    rootDirectory: resolved.artifactsDirectory,
  });
  const feishuPackages = options.feishuPackageStore ?? createFeishuPackageStore({
    filename: resolved.feishuPackagesPath,
    packages: options.feishuPackages,
    listReferences: typeof options.listFeishuPackageReferences === "function"
      ? options.listFeishuPackageReferences
      : (alias) => database.listPackageReferences(alias),
  });
  const feishuPackageApi = createFeishuPackageApi({
    store: feishuPackages,
    getModelCatalog: async (workspacePath) => discoverAiCatalog({
      codexExecutable: resolved.codexExecutable,
      workspacePath,
      processEnv: codexProcessEnvironment,
    }),
  });

  function matchingFeishuTaskOrigin(task, origin, { requirePackage = false } = {}) {
    if (!task || !Array.isArray(task.labels) || !task.labels.includes("feishu")) return null;
    const marker = parseFeishuTaskMetadata(task.description);
    if (!marker || !origin) return null;
    for (const key of [
      "version", "source", "eventId", "baseToken", "tableId", "recordId",
      "triggerField", "triggerFieldId", "triggerValue", "mode", "executionMode",
      "subjectKey", "configVersion", "uploadMode", "packageAlias", "packageSource",
      "concurrencyGroup", "maxConcurrent", "resourceGroups",
    ]) {
      if (JSON.stringify(marker[key]) !== JSON.stringify(origin[key])) return null;
    }
    if (requirePackage && typeof origin.packageAlias !== "string") return null;
    return origin;
  }

  function trustedFeishuTaskOrigin(task, options = {}) {
    return matchingFeishuTaskOrigin(task, task ? database.getFeishuTaskOrigin(task.id) : null, options);
  }

  function requireTrustedFeishuTask(task, options = {}) {
    const origin = trustedFeishuTaskOrigin(task, options);
    if (!origin) {
      throw new ApiError(409, "TASK_NOT_STARTABLE", "This task is not a server-registered Feishu workflow task");
    }
    return origin;
  }

  function validateFeishuTaskRegistration(input, metadata) {
    const expectedSubjectKey = `${metadata.baseToken}:${metadata.tableId}`;
    if (metadata.subjectKey !== expectedSubjectKey) {
      throw new ApiError(
        409,
        "FEISHU_SUBJECT_IDENTITY_REQUIRED",
        "Feishu task origin must include the exact Base/table subject identity",
      );
    }
    const expectedProjectId = subjectProjectId(expectedSubjectKey);
    if (input.projectId !== expectedProjectId) {
      throw new ApiError(
        409,
        "FEISHU_PROJECT_ID_MISMATCH",
        "Feishu task project does not match its Base/table subject",
      );
    }
    if (input.status !== "todo" && input.status !== "blocked") {
      throw new ApiError(
        409,
        "FEISHU_TASK_INITIAL_STATUS_INVALID",
        "Feishu tasks may start only in todo or blocked",
      );
    }
    if (!Array.isArray(input.labels) || !input.labels.includes("feishu")) {
      throw new ApiError(
        400,
        "FEISHU_LABEL_REQUIRED",
        "Feishu tasks must include the feishu label",
      );
    }
  }
  const resourceScheduler = options.resourceScheduler ?? createResourceScheduler();
  const allowAutomaticExecution = options.allowAutomaticExecution === undefined
    ? resolveAutomaticExecution()
    : options.allowAutomaticExecution === true;
  const taskStartAbortController = new AbortController();
  const taskStartOperations = new Set();
  let closing = false;

  function assertTaskStartAllowed(signal = taskStartAbortController.signal) {
    if (closing || signal?.aborted) {
      throw new ApiError(503, "SERVER_SHUTTING_DOWN", "Taskboard is shutting down");
    }
  }

  function startTrackedTask(taskId, callback) {
    let tracked;
    tracked = Promise.resolve().then(callback);
    const operation = { taskId, promise: tracked };
    taskStartOperations.add(operation);
    void tracked.finally(() => taskStartOperations.delete(operation)).catch(() => {});
    return tracked;
  }

  async function settleTaskStarts() {
    while (taskStartOperations.size > 0) {
      await Promise.allSettled([...taskStartOperations].map((operation) => operation.promise));
    }
  }

  function cancelQueuedTaskStarts() {
    if (typeof resourceScheduler.cancel !== "function") return;
    for (const operation of taskStartOperations) {
      resourceScheduler.cancel(operation.taskId);
    }
  }

  async function syncFeishuSubjectToBridge(subject, { lifecycle, expectedVersion }) {
    let bridgeUrl;
    try {
      bridgeUrl = new URL(resolved.feishuBridgeUrl);
    } catch {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    if (bridgeUrl.protocol !== "http:" || bridgeUrl.hostname !== "127.0.0.1") {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    const safeSubject = {
      subjectKey: subject.subjectKey,
      baseToken: subject.baseToken,
      baseName: subject.baseName,
      tableId: subject.tableId,
      tableName: subject.tableName,
      displayEnabled: subject.displayEnabled,
      lifecycle,
      configVersion: subject.configVersion,
      trigger: subject.trigger,
      title: subject.title,
      execution: subject.execution,
      packageRoute: subject.packageRoute,
      upload: {
        ...subject.upload,
        // Upload locations are Taskboard-local bindings and are never sent to
        // the Bridge workflow catalog during lifecycle synchronization.
        artifactSourcePath: null,
        targetPath: null,
      },
    };
    let response;
    try {
      response = await fetch(new URL("/api/feishu/workflow/sync", bridgeUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-feishu-bridge-client": "taskboard",
        },
        body: JSON.stringify({ lifecycle, expectedVersion, subject: safeSubject }),
      });
    } catch {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload?.subject) {
      const code = safeFeishuSyncErrorCode(payload?.error?.code);
      throw new ApiError(response.status >= 400 ? response.status : 502, code, "Feishu workflow synchronization failed");
    }
    return payload.subject;
  }
  async function inspectFeishuShareImportWithBridge(configuration) {
    let bridgeUrl;
    try {
      bridgeUrl = new URL(resolved.feishuBridgeUrl);
    } catch {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    if (bridgeUrl.protocol !== "http:" || bridgeUrl.hostname !== "127.0.0.1") {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    let response;
    try {
      response = await fetch(new URL("/api/feishu/workflow/share/import", bridgeUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-feishu-bridge-client": "local-operator",
        },
        body: JSON.stringify({ configuration, dryRun: true }),
      });
    } catch {
      throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge is unavailable");
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload || typeof payload !== "object" || !Array.isArray(payload.diagnostics)) {
      throw new ApiError(
        response.status >= 400 ? response.status : 502,
        "FEISHU_WORKFLOW_SHARE_IMPORT_FAILED",
        "Feishu workflow share inspection failed",
      );
    }
    return { diagnostics: normalizeBridgeShareDiagnostics(payload.diagnostics, configuration) };
  }
  const feishuWorkflowApi = createFeishuWorkflowApi({
    database,
    store: createFeishuWorkflowStore({
      database,
      packageAliases: async () => (typeof feishuPackages.list === "function"
        ? (await feishuPackages.list()).filter((record) => record.state === "enabled").map((record) => record.alias)
        : Object.keys(await feishuPackages.read()).filter((alias) => alias)),
      syncSubject: typeof options.feishuWorkflowSync === "function"
        ? options.feishuWorkflowSync
        : syncFeishuSubjectToBridge,
    }),
    inspectShareImport: typeof options.feishuWorkflowShareImport === "function"
      ? options.feishuWorkflowShareImport
      : inspectFeishuShareImportWithBridge,
    previewBase: async (url) => {
      let bridgeUrl;
      try {
        bridgeUrl = new URL(resolved.feishuBridgeUrl);
      } catch {
        throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge preview is unavailable");
      }
      if (bridgeUrl.protocol !== "http:" || bridgeUrl.hostname !== "127.0.0.1") {
        throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge preview is unavailable");
      }
      let response;
      try {
        response = await fetch(new URL("/api/feishu/base-preview", bridgeUrl), {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } catch {
        throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge preview is unavailable");
      }
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        throw feishuPreviewError(payload);
      }
      const preview = normalizeFeishuPreviewPayload(payload);
      if (!preview) {
        throw feishuPreviewError({ error: { code: "FEISHU_METADATA_INVALID_RESPONSE" } });
      }
      return { ...preview, sourceUrlLabel: url };
    },
  });
  const events = new EventHub();
  const uploadWorker = options.uploadWorker ?? createArtifactUploadWorker({
    database,
    artifactService,
    validateTaskForCompletion: (task, origin) => Boolean(
      task?.status === "done" && matchingFeishuTaskOrigin(task, origin),
    ),
    onUpdate: (upload) => events.emit("artifact.upload.updated", {
      upload,
      task: upload?.taskId ? database.getTask(upload.taskId) : null,
    }),
  });
  function emitArtifactUploadUpdated(upload) {
    events.emit("artifact.upload.updated", {
      upload,
      task: upload?.taskId ? database.getTask(upload.taskId) : null,
    });
  }

  function wakeUploadWorker() {
    void Promise.resolve(uploadWorker.wake()).catch((error) => {
      console.error(`Artifact upload worker wake failed: ${error?.code ?? "UPLOAD_WORKER_FAILED"}`);
    });
  }

  function startUploadWorker() {
    void Promise.resolve(uploadWorker.start()).catch((error) => {
      console.error(`Artifact upload worker start failed: ${error?.code ?? "UPLOAD_WORKER_FAILED"}`);
    });
  }
  let clientStorageWrite = Promise.resolve();

  async function readClientStorage() {
    try {
      const value = JSON.parse(await readFile(resolved.clientStoragePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  function parseClientStorageUpdate(body) {
    assertPlainObject(body);
    assertAllowedKeys(body, new Set(["key", "value"]));
    const key = stringField(body.key, "key", { required: true, maxLength: 512 });
    const value = stringField(body.value, "value", { nullable: true, maxLength: 100_000 });
    return { key, value };
  }

  async function updateClientStorage({ key, value }) {
    clientStorageWrite = clientStorageWrite.catch(() => {}).then(async () => {
      const entries = await readClientStorage();
      if (value === null) delete entries[key];
      else entries[key] = value;
      await mkdir(path.dirname(resolved.clientStoragePath), { recursive: true });
      const temporaryPath = `${resolved.clientStoragePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, resolved.clientStoragePath);
      await chmod(resolved.clientStoragePath, 0o600);
    });
    await clientStorageWrite;
  }
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const jiraConfig = options.jiraConfigStore ?? createJiraConfigStore({
    configPath: resolved.jiraConfigPath,
  });
  const jira = createJiraIntegration({
    configStore: jiraConfig,
    database,
    fetch: options.jiraFetch ?? globalThis.fetch,
  });
  let hostRuntime = null;
  function currentHostThreadBinding(threadId) {
    if (
      !hostRuntime
      || hostRuntime.threadId !== threadId
      || !hostRuntime.codexProjectId
      || !hostRuntime.codexProjectKind
      || !hostRuntime.codexHostId
      || !hostRuntime.workspacePath
    ) return undefined;
    return {
      threadId,
      codexProjectId: hostRuntime.codexProjectId,
      codexProjectKind: hostRuntime.codexProjectKind,
      codexHostId: hostRuntime.codexHostId,
      workspacePath: hostRuntime.workspacePath,
    };
  }
  function resolveInputThreadBinding(input) {
    if (input.threadBinding !== undefined) return input;
    const threadBinding = currentHostThreadBinding(input.threadId);
    return threadBinding ? { ...input, threadBinding } : input;
  }
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveThreadBinding: currentHostThreadBinding,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath, codexProcessEnvironment);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
    assertTaskProjectMoveAllowed: (taskId, targetProjectId) => {
      if (!database.hasAiChatThreadProjectConflict(taskId, targetProjectId)) return;
      throw new CloudProxyError(
        409,
        "AI_CHAT_PROJECT_MOVE_BLOCKED",
        "Delete issue-linked AI conversations before moving the issue to another project",
      );
    },
  });
  async function readCloudJson(pathname) {
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    }));
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(
        upstream.ok ? 502 : upstream.status,
        "INVALID_CLOUD_RESPONSE",
        "Cloud taskboard returned an invalid JSON response",
      );
    }
    if (!upstream.ok) {
      throw new ApiError(
        upstream.status,
        payload?.error?.code ?? "CLOUD_REQUEST_FAILED",
        payload?.error?.message ?? "Cloud taskboard request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  async function resolveAiChatContext(projectId, issueId, codexTarget) {
    const config = await cloudConfig.read();
    if (!config.remoteUrl) {
      if (codexTarget?.codexProjectKind === "remote") {
        const project = database.getProject(projectId);
        if (!project) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        }
        let issue;
        if (issueId !== undefined) {
          issue = database.getTask(issueId);
          if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
            throw new ApiError(
              404,
              "AI_CHAT_ISSUE_NOT_FOUND",
              `Task '${issueId}' is not an active task in project '${projectId}'`,
            );
          }
        }
        return { project, issue, addDirectories: [], ...codexTarget };
      }
      let resolvedWorkspace;
      const issue = issueId !== undefined ? database.getTask(issueId) : null;
      if (issueId !== undefined && (!issue || issue.projectId !== projectId || issue.archivedAt != null)) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
      const trustedOrigin = issue
        ? trustedFeishuTaskOrigin(issue, { requirePackage: true })
        : null;
      const packageCatalog = await feishuPackages.read();
      const packageSnapshot = trustedOrigin?.packageAlias && issue
        && typeof database.getFeishuTaskPackageSnapshot === "function"
        ? database.getFeishuTaskPackageSnapshot(issue.id)
        : null;
      // Subject projects are identified by Base/table, while the package
      // alias identifies the trusted Auto-Cut workspace.  Resolve a Feishu
      // task by its server-owned alias instead of requiring project IDs to
      // match.  An ordinary task must use the normal project workspace even
      // when its description contains a Feishu-looking marker.
      const packageConfig = trustedOrigin?.packageAlias
        ? packageSnapshot ?? packageCatalog[trustedOrigin.packageAlias]
        : issue
          ? null
          : Object.values(packageCatalog).find((entry) => entry.projectId === projectId);
      if (packageConfig) {
        const project = database.getProject(projectId);
        if (!project) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        }
        let workspacePath;
        try {
          workspacePath = await realpath(packageConfig.workspacePath);
          if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
        } catch {
          throw new ApiError(
            409,
            "PACKAGE_WORKSPACE_UNAVAILABLE",
            `Configured workspace for package '${packageConfig.projectName}' is unavailable`,
          );
        }
        resolvedWorkspace = {
          workspacePath,
          // Feishu package workspaces are isolated to their configured directory.
          addDirectories: [],
          project: { ...project, workspacePath },
        };
      }
      try {
        if (!resolvedWorkspace) {
          resolvedWorkspace = await resolveAiWorkspace(
            projectId,
            resolved.codexStatePath,
            database,
          );
        }
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "PROJECT_WORKSPACE_UNAVAILABLE"
          || projectId !== DEFAULT_PROJECT_ID
        ) {
          throw error;
        }
        resolvedWorkspace = {
          workspacePath: PROJECT_ROOT,
          addDirectories: [],
          project: database.getProject(projectId),
        };
      }
      return {
        ...resolvedWorkspace,
        issue,
        skipGitRepoCheck: Boolean(trustedOrigin && packageConfig),
        trustedAutoCutSource: trustedOrigin && packageConfig
          ? {
              source: trustedOrigin.source,
              baseToken: trustedOrigin.baseToken,
              tableId: trustedOrigin.tableId,
              recordId: trustedOrigin.recordId,
            }
          : null,
      };
    }

    const projectPayload = await readCloudJson("/api/projects");
    const project = Array.isArray(projectPayload.projects)
      ? projectPayload.projects.find((candidate) => candidate?.id === projectId)
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    let issue;
    if (issueId !== undefined) {
      const issuePayload = await readCloudJson(`/api/tasks/${encodeURIComponent(issueId)}`);
      issue = issuePayload.task;
      if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
    }

    if (codexTarget?.codexProjectKind === "remote") {
      return { project, issue, addDirectories: [], ...codexTarget };
    }

    const resolvedWorkspace = await resolveMappedAiWorkspace(
      projectId,
      project,
      config.projectMappings,
    );
    return { ...resolvedWorkspace, issue };
  }

  const aiChat = new AiChatService({
    database,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    manageTaskboardSkillPath: resolved.skillPath,
    processEnv: codexProcessEnvironment,
    resolveContext: resolveAiChatContext,
    remoteAppServerFactory: options.remoteAppServerFactory,
  });
  function executionModeForMetadata(metadata) {
    return metadata?.executionMode === "automatic" || metadata?.mode === "automatic"
      ? "automatic"
      : "manual";
  }

  function terminalTaskStatusForRun(run, metadata) {
    if (run?.status === "completed") {
      return "in_progress";
    }
    return run?.status === "failed" || run?.status === "interrupted" ? "blocked" : null;
  }

  function completedTaskStatusForMetadata(metadata) {
    return executionModeForMetadata(metadata) === "automatic" ? "done" : "in_review";
  }

  function clearFeishuExecutionAfterRun(taskId, lease = null) {
    const execution = database.getFeishuExecution(taskId);
    if (!execution || execution.state !== "running") return;
    if (lease?.leaseId && execution.leaseId && execution.leaseId !== lease.leaseId) return;
    database.clearFeishuExecution(taskId);
  }

  function assertTaskArtifactEligible(task) {
    try {
      return requireTrustedFeishuTask(task);
    } catch {
      throw new ApiError(409, "TASK_NOT_ARTIFACT_ELIGIBLE", "Only server-registered Feishu Auto-Cut tasks can store Jianying draft artifacts");
    }
  }

  function assertTaskCanAcceptArtifact(task) {
    const metadata = assertTaskArtifactEligible(task);
    const completedStatus = completedTaskStatusForMetadata(metadata);
    if (task.status !== "in_progress" && task.status !== completedStatus) {
      throw new ApiError(
        409,
        "TASK_NOT_ARTIFACT_READY",
        `This ${executionModeForMetadata(metadata)} task accepts artifacts only while processing or ${completedStatus}`,
      );
    }
    if (
      task.status === "in_progress"
      && database.listTaskAiStarts().some((claim) => claim.taskId === task.id)
    ) {
      throw new ApiError(
        409,
        "TASK_EDITING_IN_PROGRESS",
        "Wait for Auto-Cut to finish before selecting its Jianying draft ZIP",
      );
    }
    return metadata;
  }

  function assertTaskCanEnqueueArtifact(task) {
    const metadata = assertTaskArtifactEligible(task);
    if (task.status !== "done") {
      throw new ApiError(
        409,
        "TASK_NOT_UPLOAD_READY",
        "Verified ZIP artifacts can join the upload queue only after editing is accepted",
      );
    }
    return metadata;
  }

  function enqueueArtifactUpload(task, metadata, artifact, { automaticOnly = false } = {}) {
    const snapshotSubjectKey = metadata.subjectKey ?? `${metadata.baseToken}:${metadata.tableId}`;
    const snapshotTarget = Number.isSafeInteger(metadata.configVersion)
      ? database.getFeishuSubjectUploadTargetByVersion(snapshotSubjectKey, metadata.configVersion)
      : database.getFeishuSubjectUploadTargetByOrigin(metadata.baseToken, metadata.tableId);
    // A task created before upload was configured has an intentionally empty
    // target in its snapshot. Let that task use the subject's current target;
    // once a target was captured, keep the creation-time binding stable.
    const target = snapshotTarget?.targetPath
      ? snapshotTarget
      : database.getFeishuSubjectUploadTargetByOrigin(metadata.baseToken, metadata.tableId);
    if (automaticOnly && target?.enqueueMode !== "automatic") return null;
    if (!target) {
      throw new ApiError(409, "TASK_UPLOAD_NOT_CONFIGURED", "This task is not linked to a configured subject");
    }
    if (!target.targetPath) {
      throw new ApiError(409, "UPLOAD_TARGET_NOT_CONFIGURED", "Set an upload destination for this subject first");
    }
    const workArtifact = database.getTaskArtifactForWork(artifact.id);
    if (!workArtifact || workArtifact.taskId !== task.id) {
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", "The selected ZIP does not belong to this task");
    }
    if (workArtifact.validationStatus !== "verified") {
      throw new ApiError(409, "ARTIFACT_NOT_VERIFIED", "Only verified ZIP artifacts can be uploaded");
    }
    const upload = database.createArtifactUpload({
      taskId: task.id,
      artifactId: workArtifact.id,
      subjectKey: target.subjectKey,
      storageKey: workArtifact.storageKey,
      targetId: target.targetId,
      targetPath: target.targetPath,
      uploadConcurrency: target.uploadConcurrency,
      filename: workArtifact.filename,
      sha256: workArtifact.sha256,
    });
    emitArtifactUploadUpdated(upload);
    wakeUploadWorker();
    return upload;
  }

  function maybeAutomaticallyEnqueueCompletedTask(task) {
    try {
      if (task?.status !== "done") return { upload: null, error: null };
      const metadata = trustedFeishuTaskOrigin(task);
      if (!metadata) return { upload: null, error: null };
      const [artifact] = database.listTaskArtifacts(task.id);
      if (!artifact || artifact.validationStatus !== "verified") return { upload: null, error: null };
      return {
        upload: enqueueArtifactUpload(task, metadata, artifact, { automaticOnly: true }),
        error: null,
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "UPLOAD_ENQUEUE_FAILED";
      console.error(`Automatic artifact upload enqueue failed for task '${task?.id}': ${code}`);
      return {
        upload: null,
        error: {
          code,
          message: "Editing completed, but the verified ZIP could not join the upload queue",
        },
      };
    }
  }

  function reconcileAutomaticArtifactUploads() {
    let tasks;
    try {
      tasks = database.listTasks({ status: "done", archived: "false" });
    } catch (error) {
      console.error(`Automatic artifact upload recovery failed: ${error?.code ?? "UPLOAD_RECOVERY_FAILED"}`);
      return;
    }
    for (const task of tasks) {
      try {
        maybeAutomaticallyEnqueueCompletedTask(task);
      } catch (error) {
        console.error(
          `Automatic artifact upload recovery failed for task '${task.id}': ${error?.code ?? "UPLOAD_RECOVERY_FAILED"}`,
        );
      }
    }
  }

  function reconcileFeishuTaskAfterRun(taskId, threadId, run, actor, metadata, lease = null) {
    const status = terminalTaskStatusForRun(run, metadata);
    if (!status) return;
    const current = database.getTask(taskId);
    if (!current || current.threadId !== threadId) {
      clearFeishuExecutionAfterRun(taskId, lease);
      if (lease) resourceScheduler.release(lease);
      return;
    }
    const claim = database.listTaskAiStarts().find((entry) => (
      entry.taskId === taskId
      && entry.threadId === threadId
      && entry.runId === run.id
    ));
    if (!claim) {
      clearFeishuExecutionAfterRun(taskId, lease);
      if (lease) resourceScheduler.release(lease);
      return;
    }
    const task = database.settleTaskAiStart(
      taskId,
      claim.claimToken,
      run.id,
      status,
      actor,
    );
    clearFeishuExecutionAfterRun(taskId, lease);
    events.emit("task.updated", { task });
    if (lease) resourceScheduler.release(lease);
  }
  function reconcileClaimedFeishuTasks() {
    for (const claim of database.listTaskAiStarts()) {
      const task = database.getTask(claim.taskId);
      const metadata = task
        ? trustedFeishuTaskOrigin(task, { requirePackage: true })
        : null;
      if (!task || !task.labels.includes("feishu") || !metadata) {
        if (task) {
          try {
            const current = database.getTask(task.id);
            if (
              current
              && current.status === "in_progress"
              && current.threadId === claim.threadId
            ) {
              const ready = database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR);
              events.emit("task.updated", { task: ready });
            } else {
              database.deleteTaskAiStartClaim(task.id, claim.claimToken);
            }
          } catch (error) {
            console.error("Failed to recover edited Feishu task claim", error);
          }
        } else {
          try { database.deleteTaskAiStartClaim(claim.taskId, claim.claimToken); } catch {}
        }
        continue;
      }
      if (task.status !== "in_progress") {
        try { database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR); } catch {}
        continue;
      }
      if (!claim.threadId) {
        try {
          const ready = database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR);
          events.emit("task.updated", { task: ready });
        } catch (error) {
          console.error("Failed to recover unbound Feishu task start", error);
        }
        continue;
      }
      const thread = database.getAiChatThread(claim.threadId);
      if (!thread) {
        try {
          const ready = database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR);
          events.emit("task.updated", { task: ready });
        } catch (error) {
          console.error("Failed to recover invalid Feishu task thread", error);
        }
        continue;
      }
      if (thread.origin.issueId !== task.id) {
        console.error(`Refusing to recover Feishu task '${task.id}' from mismatched thread '${claim.threadId}'`);
        try {
          const current = database.getTask(task.id);
          if (current.status === "in_progress" && current.threadId === claim.threadId) {
            const ready = database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR);
            events.emit("task.updated", { task: ready });
          } else {
            database.deleteTaskAiStartClaim(task.id, claim.claimToken);
          }
        } catch (error) {
          console.error("Failed to recover mismatched Feishu task claim", error);
        }
        continue;
      }
      const latest = claim.runId ? database.getAiChatRun(claim.runId) : null;
      if (!latest) {
        try {
          const ready = database.releaseTaskFromAiStart(task.id, claim.claimToken, CODEX_AGENT_ACTOR);
          events.emit("task.updated", { task: ready });
          if (database.listAiChatRuns(claim.threadId).length === 0) {
            try { aiChat.deleteThread(claim.threadId); } catch {}
          }
        } catch (error) {
          console.error("Failed to recover Feishu task before run", error);
        }
        continue;
      }
      const status = terminalTaskStatusForRun(latest, metadata);
      if (!status) continue;
      try {
        const updated = database.settleTaskAiStart(
          task.id,
          claim.claimToken,
          latest.id,
          status,
          CODEX_AGENT_ACTOR,
        );
        clearFeishuExecutionAfterRun(task.id);
        events.emit("task.updated", { task: updated });
      } catch (error) {
        console.error("Failed to recover terminal Feishu task", error);
      }
    }
  }
  function executionRequestForTask(task, metadata, packageConfig = null) {
    const mode = executionModeForMetadata(metadata);
    const packageAlias = metadata.packageAlias || "default";
    return {
      requestId: task.id,
      concurrencyGroup: `autocut:${packageAlias}`,
      maxConcurrent: Number.isSafeInteger(packageConfig?.maxConcurrent) && packageConfig.maxConcurrent > 0
        ? packageConfig.maxConcurrent
        : 1,
      resourceGroups: Array.isArray(metadata.resourceGroups) ? metadata.resourceGroups : [],
      mode,
    };
  }

  function normalizePackageModelError(error, packageConfig) {
    if (error?.code !== "INVALID_MODEL" && error?.code !== "INVALID_REASONING_EFFORT") {
      return error;
    }
    return new ApiError(
      409,
      "PACKAGE_MODEL_UNAVAILABLE",
      `Configured model settings for package '${packageConfig?.projectName ?? packageConfig?.name ?? "Auto-Cut"}' are unavailable`,
    );
  }

  async function startClaimedTaskWithAi(claimedTask, actor, metadata, packageConfig, lease, trigger) {
    const threadId = randomUUID();
    let thread;
    let unsubscribeRun = null;
    try {
      const updatedTask = database.bindTaskAiStart(
        claimedTask.id,
        claimedTask.claimToken,
        claimedTask.version,
        threadId,
        actor,
      );
      events.emit("task.updated", { task: updatedTask });
      claimedTask.version = updatedTask.version;
      thread = await aiChat.createThread({
        id: threadId,
        projectId: claimedTask.projectId,
        issueId: claimedTask.id,
        title: `${claimedTask.identifier} · ${metadata.packageAlias}`,
        ...(packageConfig.model ? { model: packageConfig.model } : {}),
        ...(packageConfig.reasoningEffort ? { reasoningEffort: packageConfig.reasoningEffort } : {}),
        sandbox: "workspace-write",
      });
      database.verifyTaskAiStart(
        claimedTask.id,
        claimedTask.claimToken,
        claimedTask.version,
        thread.id,
      );
      unsubscribeRun = aiChat.subscribe(thread.id, (event) => {
        if (event?.type !== "ai.run" || !event.run || event.run.status === "running") return;
        unsubscribeRun?.();
        unsubscribeRun = null;
        try {
          reconcileFeishuTaskAfterRun(claimedTask.id, thread.id, event.run, actor, metadata, lease);
        } catch (error) {
          resourceScheduler.release(lease);
          console.error("Failed to reconcile Feishu task after Codex run", error);
        }
      });
    } catch (error) {
      unsubscribeRun?.();
      unsubscribeRun = null;
      try {
        const rollback = database.releaseTaskFromAiStart(
          claimedTask.id,
          claimedTask.claimToken,
          actor,
        );
        events.emit("task.updated", { task: rollback });
      } catch {}
      if (thread) {
        try { aiChat.deleteThread(thread.id); } catch {}
      }
      throw normalizePackageModelError(error, packageConfig);
    }
    let run;
    try {
      run = await aiChat.startTurn(thread.id, {
        message: packageConfig.prompt,
      }, {
        taskClaimedByServer: true,
        onRunCreated: (createdRun) => database.bindTaskAiStartRun(
          claimedTask.id,
          claimedTask.claimToken,
          thread.id,
          createdRun.id,
        ),
      });
    } catch (error) {
      unsubscribeRun?.();
      unsubscribeRun = null;
      resourceScheduler.release(lease);
      try {
        const rollback = database.getTask(claimedTask.id)
          ? database.releaseTaskFromAiStart(
            claimedTask.id,
            claimedTask.claimToken,
            actor,
          )
          : null;
        if (!rollback) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${claimedTask.id}' does not exist`);
        events.emit("task.updated", { task: rollback });
      } catch {}
      try { aiChat.deleteThread(thread.id); } catch {}
      throw normalizePackageModelError(error, packageConfig);
    }
    return {
      task: database.getTask(claimedTask.id),
      thread,
      run,
      execution: {
        executionId: lease.requestId,
        leaseId: lease.leaseId,
        state: "running",
        trigger,
        mode: executionRequestForTask(claimedTask, metadata, packageConfig).mode,
        concurrencyGroup: lease.concurrencyGroup,
        resourceGroups: lease.resourceGroups,
      },
    };
  }

  async function startTaskWithAi(
    task,
    actor,
    metadata,
    { trigger = "manual", signal = taskStartAbortController.signal, lease: providedLease = null } = {},
  ) {
    if (trigger === "automatic" && !allowAutomaticExecution) {
      throw new ApiError(
        409,
        "AUTOMATIC_EXECUTION_DISABLED",
        "Automatic Codex execution is disabled by the local policy",
      );
    }
    assertTaskStartAllowed(signal);
    const packages = await feishuPackages.read();
    assertTaskStartAllowed(signal);
    const livePackage = packages[metadata.packageAlias];
    if (!livePackage) {
      throw new ApiError(
        409,
        "UNKNOWN_PACKAGE_ALIAS",
        `Package '${metadata.packageAlias}' is not configured on this Taskboard`,
      );
    }
    if (livePackage.state && livePackage.state !== "enabled") {
      throw new ApiError(409, "PACKAGE_DISABLED", "Auto-Cut package is disabled and cannot start");
    }
    const storedSnapshot = database.getFeishuTaskPackageSnapshot(task.id);
    const packageConfig = storedSnapshot
      ? {
          ...livePackage,
          ...storedSnapshot,
          maxConcurrent: livePackage.maxConcurrent,
          state: livePackage.state,
        }
      : livePackage;
    // A Feishu subject project identifies the Base/table queue.  The trusted
    // package alias identifies the Auto-Cut workspace and may be shared by
    // multiple subject projects; never require the two identities to match.
    try {
      const workspacePath = await realpath(packageConfig.workspacePath);
      if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ApiError(
        409,
        "PACKAGE_WORKSPACE_UNAVAILABLE",
        `Configured workspace for package '${packageConfig.projectName}' is unavailable`,
      );
    }
    assertTaskStartAllowed(signal);
    const startableTask = task.threadId
      ? database.detachFailedPreStartThreadForRetry(task.id, task.version, actor)
      : task;
    const claimedTask = database.claimTaskForAiStart(
      startableTask.id,
      startableTask.version,
      actor,
    );
    events.emit("task.updated", { task: claimedTask });
    const execution = executionRequestForTask(claimedTask, metadata, packageConfig);
    let lease = providedLease;
    try {
      if (!lease) lease = await resourceScheduler.request(execution);
      assertTaskStartAllowed(signal);
      return await startClaimedTaskWithAi(
        claimedTask,
        actor,
        metadata,
        packageConfig,
        lease,
        trigger,
      );
    } catch (error) {
      if (lease) resourceScheduler.release(lease);
      try {
        const rollback = database.releaseTaskFromAiStart(
          claimedTask.id,
          claimedTask.claimToken,
          actor,
        );
        events.emit("task.updated", { task: rollback });
      } catch {}
      throw error;
    }
  }
  const executionCoordinator = createFeishuExecutionCoordinator({
    database,
    packageStore: feishuPackages,
    scheduler: resourceScheduler,
    allowAutomaticExecution,
    onTaskUpdated: (task) => events.emit("task.updated", { task }),
    startClaimedTask: (task, metadata, lease, trigger, actor) => startTaskWithAi(
      task,
      actor ?? CODEX_AGENT_ACTOR,
      metadata,
      { trigger, lease },
    ),
  });
  reconcileClaimedFeishuTasks();
  void executionCoordinator.recover().catch((error) => {
    console.error(`Failed to recover Feishu execution queue: ${error?.code ?? "RECOVERY_FAILED"}`);
  });
  const projectSummary = new ProjectSummaryService({
    database,
    codexExecutable: resolved.codexExecutable,
    processEnv: codexProcessEnvironment,
    workspacePath: PROJECT_ROOT,
  });
  const aiEventResponses = new Set();
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (resolved.instanceToken && incomingUrl.pathname !== "/health") {
        if (incomingUrl.pathname === routePrefix) {
          response.writeHead(301, { location: `${incomingUrl.pathname}/${incomingUrl.search}` });
          response.end();
          return;
        }
        if (
          incomingUrl.pathname !== routePrefix
          && !incomingUrl.pathname.startsWith(`${routePrefix}/`)
        ) {
          throw new ApiError(404, "NOT_FOUND", "Route not found");
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }

      const configuredTrustedRequest = assertTrustedNetworkRequest(
        request,
        Boolean(resolved.instanceToken),
        resolved.trustedOrigins,
      );
      const origin = request.headers.origin;
      const trustedEmbedOrigin = TRUSTED_EMBED_ORIGINS.has(origin)
        || (Boolean(resolved.instanceToken) && origin === "null");
      if (trustedEmbedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          request.headers["access-control-request-headers"] ?? "content-type",
        );
        response.setHeader("access-control-expose-headers", "x-codex-taskboard-proof");
        response.setHeader("access-control-allow-private-network", "true");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (resolved.instanceToken && origin === "app://-") {
        const challenge = request.headers["x-codex-taskboard-challenge"];
        if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
          throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
        }
        response.setHeader(
          "x-codex-taskboard-proof",
          createHmac("sha256", resolved.instanceSecret).update(challenge).digest("hex"),
        );
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      if (pathname.startsWith("/api/local/feishu/workflow/")) {
        assertLoopbackRequest(request);
        const result = await feishuWorkflowApi.handle({
          method: request.method,
          pathname,
          body: request.method === "GET" ? null : await readJson(request),
          query: url.searchParams,
        });
        if (result) return sendJson(response, result.status, result.body);
      }
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      const isDevelopmentContextsRoute = /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      if (
        configuredTrustedRequest
        && (
          pathname.startsWith("/api/local/")
          || pathname === "/api/device-workspaces"
          || isDevelopmentContextsRoute
        )
      ) {
        throw new ApiError(
          409,
          "LOCAL_COMPANION_REQUIRED",
          "This capability requires a device-local Taskboard origin",
        );
      }
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      if (pathname === "/api/local/autocut/packages"
        || pathname.startsWith("/api/local/autocut/packages/")) {
        const result = await feishuPackageApi.handle({
          method: request.method,
          pathname,
          body: request.method === "GET" ? null : (
            request.method === "DELETE" && !request.headers["content-length"]
              ? null
              : await readJson(request)
          ),
        });
        if (result) {
          if (request.method !== "GET" && pathname !== "/api/local/autocut/packages/catalog") {
            events.emit("autocut.package.updated", {});
            void executionCoordinator.wake().catch((error) => {
              console.error(`Failed to wake Auto-Cut execution queue: ${error?.code ?? "QUEUE_WAKE_FAILED"}`);
            });
          }
          return sendJson(response, result.status, result.body);
        }
      }
      if (pathname === "/api/local/board-stage-labels") {
        assertNoQuery(url.searchParams, "board stage labels");
        if (request.method === "GET") {
          return sendJson(response, 200, database.getBoardStageLabels());
        }
        if (request.method === "PATCH") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["expectedVersion", "version", "labels"]));
          const expectedVersion = body.expectedVersion ?? body.version;
          const saved = database.saveBoardStageLabels(expectedVersion, body.labels);
          events.emit("board-stage-labels.updated", {});
          return sendJson(response, 200, saved);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || isDevelopmentContextsRoute;
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (resolved.instanceToken) {
          const challenge = request.headers["x-codex-taskboard-challenge"];
          if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
            throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
          }
          return sendJson(response, 200, {
            status: "ok",
            product: "codex-taskboard",
            version: resolved.version,
            proof: createHmac("sha256", resolved.instanceSecret)
              .update(challenge)
              .digest("hex"),
          });
        }
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/client-storage") {
        if (request.method === "GET") {
          await clientStorageWrite;
          const entries = await readClientStorage();
          const config = await cloudConfig.read();
          if (config.remoteUrl) {
            assertLoopbackRequest(request);
            const shared = await readCloudJson("/api/client-storage");
            for (const key of Object.keys(entries)) {
              if (key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) delete entries[key];
            }
            for (const [key, value] of Object.entries(shared.entries)) {
              if (key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) entries[key] = value;
            }
          }
          return sendJson(response, 200, { entries });
        }
        if (request.method === "PATCH") {
          const update = parseClientStorageUpdate(await readJson(request));
          const config = await cloudConfig.read();
          if (
            config.remoteUrl
            && update.key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)
          ) {
            assertLoopbackRequest(request);
            return sendFetchResponse(
              response,
              await cloudProxy.forward(new Request("http://127.0.0.1/api/client-storage", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(update),
              })),
            );
          }
          await updateClientStorage(update);
          if (update.key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) {
            events.emit("client-storage.updated", { key: update.key });
          }
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(url.searchParams.getAll("threadId").map((value) => (
          value.trim().replace(/^(?:local|cloud):/i, "")
        )))];
        if (threadIds.length > 64 || threadIds.some((threadId) => (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ))) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
          ]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            codexProjectId: stringField(body.codexProjectId ?? null, "codexProjectId", {
              nullable: true,
              maxLength: 256,
            }),
            codexProjectKind: body.codexProjectKind === "local" || body.codexProjectKind === "remote"
              ? body.codexProjectKind
              : null,
            codexHostId: stringField(body.codexHostId ?? null, "codexHostId", {
              nullable: true,
              maxLength: 256,
            }),
            workspacePath: stringField(body.workspacePath ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
            updatedAt: Date.now(),
          };
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/jira-connection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 连接接口不接受查询参数");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { connection: await jira.status() });
        }
        if (request.method === "PUT") {
          const activeCloudConfig = await cloudConfig.read();
          if (activeCloudConfig.remoteUrl) {
            throw new ApiError(
              409,
              "JIRA_LOCAL_MODE_REQUIRED",
              "Jira 连接当前仅支持本地数据模式，请先退出云端协作模式",
            );
          }
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["baseUrl", "username", "password", "projects"]));
          const baseUrl = stringField(body.baseUrl, "baseUrl", { required: true, maxLength: 2048 });
          const username = stringField(body.username ?? "", "username", { maxLength: 254 });
          const password = body.password ?? "";
          if (typeof password !== "string") {
            throw new ApiError(400, "INVALID_FIELD", "'password' must be a string");
          }
          if (password.length > 4096) {
            throw new ApiError(400, "INVALID_FIELD", "'password' cannot exceed 4096 characters");
          }
          try {
            const connection = await jira.configure({
              baseUrl,
              username,
              password,
              projects: body.projects,
            });
            events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
            return sendJson(response, 200, { connection });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, error.code ?? "INVALID_JIRA_CONFIG", error.message);
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-connection/sync") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 同步接口不接受查询参数");
        }
        await assertEmptyRequestBody(request, "POST /api/local/jira-connection/sync");
        const connection = await jira.sync({ force: true });
        events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
        return sendJson(response, 200, { connection });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          ...(configuredTrustedRequest ? {} : { manageTaskboardSkillPath: resolved.skillPath }),
          capabilities: {
            localAiChat: !configuredTrustedRequest
              && isLoopbackAddress(request.socket.remoteAddress),
          },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: {
                transport: "websocket",
                endpoint: "/api/events",
              },
              localCapabilities: { available: !configuredTrustedRequest },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set([
          "projectId",
          "codexProjectId",
          "codexProjectKind",
          "codexHostId",
          "workspacePath",
        ]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(
          response,
          200,
          await aiChat.getCatalog(projectId, undefined, aiExecutionTargetFromQuery(url.searchParams)),
        );
      }

      if (pathname === "/api/local/ai/composer/candidates") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const query = parseComposerCandidateQuery(url.searchParams);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.candidatesForSurface(
            await aiChat.getComposerCandidates(query),
            query,
          ),
        );
      }

      if (pathname === "/api/local/ai/composer/rebind") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/composer/rebind");
        const input = parseComposerRebindRequest(await readJson(request));
        const { workspacePath, composerCatalog } = await resolveComposerRebindWorkspace(aiChat, input);
        return sendJson(
          response,
          200,
          await composerCatalog.rebindPersistedReferences({
            workspacePath,
            nodes: input.document.nodes,
          }),
        );
      }

      const projectSummaryRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/summary$/);
      if (projectSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/summary");
        const projectId = validateProjectId(
          decodeRouteSegment(projectSummaryRoute[1], "Project id"),
        );
        return sendJson(response, 200, projectSummary.get(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadCompactRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/compact$/);
      if (aiThreadCompactRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/compact");
        const threadId = decodeRouteSegment(aiThreadCompactRoute[1], "Thread id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/threads/:id/compact");
        const thread = await aiChat.compactThread(threadId);
        return sendJson(response, 200, { thread });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }


      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          const unknown = [...new Set([...url.searchParams.keys()].filter((key) => key !== "includeArchived"))];
          if (unknown.length > 0 || url.searchParams.getAll("includeArchived").length > 1) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknown[0] ?? "includeArchived"}`);
          }
          const includeArchivedValue = url.searchParams.get("includeArchived");
          if (includeArchivedValue !== null && !["true", "false"].includes(includeArchivedValue)) {
            throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'includeArchived' must be true or false");
          }
          const projects = database.listProjects({ includeArchived: includeArchivedValue === "true" }).map((project) => ({
            ...project,
            workspacePath: project.id === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig?.projectMappings[project.id] ?? project.workspacePath,
          }));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "DELETE") {
          database.deleteProject(projectId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["DELETE"]);
      }

      const projectArchiveRoute = pathname.match(/^\/api\/projects\/([^/]+)\/archive$/);
      if (projectArchiveRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/projects/:id/archive");
        const projectId = decodeRouteSegment(projectArchiveRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["archived"]));
        if (typeof body.archived !== "boolean") throw new ApiError(400, "INVALID_FIELD", "'archived' must be a boolean");
        const project = database.setProjectArchived(projectId, body.archived);
        events.emit("project.updated", { project });
        return sendJson(response, 200, { project });
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
          events.emit("workflow.updated", {
            projectId,
            workflowVersion: workflow.version,
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const projectLabelsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
      if (projectLabelsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project label routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectLabelsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST" && request.method !== "DELETE") {
          return methodNotAllowed(response, ["POST", "DELETE"]);
        }
        if (request.method === "DELETE" && projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
            "Jira 标签目录由同步管理，不能在 Taskboard 中删除",
          );
        }
        const label = parseProjectLabel(await readJson(request));
        const project = request.method === "POST"
          ? database.addProjectLabel(projectId, label)
          : database.deleteProjectLabel(projectId, label);
        events.emit("project.labels.updated", { project });
        return sendJson(response, 200, { project });
      }

      const projectReadmeAttachmentsRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/readme\/attachments$/,
      );
      if (projectReadmeAttachmentsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README attachment routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const metadata = parseAttachmentHeaders(request);
        if (metadata.kind !== "inline") {
          throw new ApiError(400, "INVALID_ATTACHMENT_KIND", "Project README attachments must be inline");
        }
        const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
        const id = randomUUID();
        await mkdir(resolved.attachmentsDirectory, { recursive: true });
        const storagePath = path.join(resolved.attachmentsDirectory, id);
        await writeFile(storagePath, body, { flag: "wx" });
        let attachment;
        try {
          attachment = database.createProjectReadmeAttachment(projectId, {
            id,
            ...metadata,
            size: body.length,
          });
        } catch (error) {
          await unlink(storagePath);
          throw error;
        }
        return sendJson(response, 201, { attachment });
      }

      const projectReadmeRoute = pathname.match(/^\/api\/projects\/([^/]+)\/readme$/);
      if (projectReadmeRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { readme: database.getProjectReadme(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseProjectReadmeSave(await readJson(
            request,
            PROJECT_README_BODY_LIMIT,
            "Project README request cannot exceed 3 MiB",
          ));
          const readme = database.saveProjectReadme(projectId, input.content, input.version);
          events.emit("project.readme.updated", {
            projectId,
            readmeVersion: readme.version,
          });
          return sendJson(response, 200, { readme });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: projectId === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(
          response,
          200,
          await scanDevelopmentContexts(workspacePath, codexProcessEnvironment),
        );
      }

      if (pathname === "/api/local/feishu/tasks" && request.method === "POST") {
        assertFeishuBridgeRequest(request, resolved.feishuBridgeSecret);
        const actor = actorFromRequest(request);
        const { assigneeTarget, ...input } = parseTaskCreate(await readJson(request));
        const metadata = parseFeishuTaskMetadata(input.description);
        if (!metadata || !metadata.baseToken || !metadata.tableId || !metadata.recordId || !metadata.eventId) {
          throw new ApiError(400, "INVALID_FEISHU_ORIGIN", "Feishu task description does not contain valid workflow metadata");
        }
        validateFeishuTaskRegistration(input, metadata);
        let packageSnapshot;
        if (metadata.packageAlias) {
          const packageRecord = typeof feishuPackages.get === "function"
            ? await feishuPackages.get(metadata.packageAlias)
            : null;
          if (typeof feishuPackages.get === "function" && !packageRecord) {
            throw new ApiError(
              409,
              "UNKNOWN_PACKAGE_ALIAS",
              `Package '${metadata.packageAlias}' is not configured on this Taskboard`,
            );
          }
          if (packageRecord) packageSnapshot = {
            packageAlias: packageRecord.alias ?? metadata.packageAlias,
            packageRevision: packageRecord.revision ?? 1,
            name: packageRecord.name ?? packageRecord.projectName ?? packageRecord.alias ?? metadata.packageAlias,
            projectId: packageRecord.projectId ?? null,
            workspacePath: packageRecord.workspacePath,
            model: packageRecord.model ?? null,
            reasoningEffort: packageRecord.reasoningEffort ?? null,
            prompt: packageRecord.prompt,
            zipSourceDirectory: packageRecord.zipSourceDirectory ?? packageRecord.artifactSourcePath ?? null,
            maxConcurrent: packageRecord.maxConcurrent,
          };
        }
        const create = packageSnapshot || !metadata.packageAlias
          ? database.createFeishuTask
          : database.createTask;
        const task = create.call(database, {
          ...input,
          actor,
          assignee: resolveAssignee(assigneeTarget, actor),
          feishuOrigin: metadata,
        }, packageSnapshot);
        events.emit("task.created", { task });
        if (allowAutomaticExecution && !closing) {
          const metadata = trustedFeishuTaskOrigin(task, { requirePackage: true });
          if (metadata && executionModeForMetadata(metadata) === "automatic") {
            void startTrackedTask(task.id, () => executionCoordinator.schedule(
              task, metadata, "automatic", { actor: CODEX_AGENT_ACTOR },
            )).catch((error) => {
              if (["SERVER_SHUTTING_DOWN", "REQUEST_CANCELLED"].includes(error?.code)) return;
              console.error(`Automatic execution failed for task '${task.id}': ${error.code ?? "EXECUTION_FAILED"}`);
            });
          }
        }
        return sendJson(response, 201, { task });
      }

      const feishuTaskArchiveRoute = pathname.match(/^\/api\/local\/feishu\/tasks\/([^/]+)\/archive$/);
      if (feishuTaskArchiveRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertFeishuBridgeRequest(request, resolved.feishuBridgeSecret);
        assertNoQuery(url.searchParams, "POST /api/local/feishu/tasks/:id/archive");
        const id = decodeRouteSegment(feishuTaskArchiveRoute[1], "Task id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["version"]));
        const version = parseVersion(body.version);
        const task = database.getTask(id);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
        requireTrustedFeishuTask(task);
        const archived = database.archiveFeishuTask(id, version, actorFromRequest(request));
        events.emit("task.archived", { task: archived });
        return sendJson(response, 200, { task: archived });
      }

      if (pathname === "/api/local/feishu/tasks" && request.method === "GET") {
        assertFeishuBridgeRequest(request, resolved.feishuBridgeSecret);
        assertAllowedQuery(url.searchParams, new Set([
          "eventId", "projectId", "archived", "status", "baseToken", "tableId", "recordId",
          "triggerFieldId", "triggerField", "triggerValue",
        ]), "GET /api/local/feishu/tasks");
        const archivedQuery = url.searchParams.get("archived");
        if (archivedQuery !== null && archivedQuery !== "all" && archivedQuery !== "false") {
          throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be all or false");
        }
        const eventId = url.searchParams.get("eventId");
        const projectId = url.searchParams.get("projectId");
        if (eventId) {
          const task = database.findFeishuTaskByEventId(eventId, projectId || null);
          return sendJson(response, 200, {
            task: task
              && (archivedQuery !== "false" || task.archivedAt === null)
              && trustedFeishuTaskOrigin(task)
              ? task
              : null,
          });
        }
        const scope = {
          projectId: projectId || null,
          status: url.searchParams.get("status") || null,
          archived: url.searchParams.get("archived") === "false" ? false : undefined,
          baseToken: url.searchParams.get("baseToken") ?? undefined,
          tableId: url.searchParams.get("tableId") ?? undefined,
          recordId: url.searchParams.get("recordId") ?? undefined,
          triggerFieldId: url.searchParams.get("triggerFieldId") ?? undefined,
          triggerField: url.searchParams.get("triggerField") ?? undefined,
          triggerValue: url.searchParams.get("triggerValue") ?? undefined,
        };
        const tasks = database.listFeishuTasks(scope).filter((task) => trustedFeishuTaskOrigin(task));
        return sendJson(response, 200, { tasks });
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (!filters.projectId || filters.projectId === JIRA_PROJECT_ID) await jira.sync();
          return sendJson(response, 200, { tasks: database.listTasks(filters) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...parsedInput } = parseTaskCreate(await readJson(request));
          const input = resolveInputThreadBinding(parsedInput);
          if (input.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_CREATE_UNAVAILABLE",
              "请在 Jira 中新建议题，Taskboard 当前只同步已分配给你的任务",
            );
          }
          const task = database.createTask({
            ...input,
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          events.emit("task.created", { task });
          if (allowAutomaticExecution && !closing) {
            const metadata = parseFeishuTaskMetadata(task.description);
            if (metadata && trustedFeishuTaskOrigin(task) && executionModeForMetadata(metadata) === "automatic") {
              void startTrackedTask(task.id, () => executionCoordinator.schedule(
                task, metadata, "automatic", { actor: CODEX_AGENT_ACTOR },
              ))
                .catch((error) => {
                  if (["SERVER_SHUTTING_DOWN", "REQUEST_CANCELLED"].includes(error?.code)) return;
                  console.error(`Automatic execution failed for task '${task.id}': ${error.code ?? "EXECUTION_FAILED"}`);
                });
            }
          }
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId, threadBinding, origin } = resolveInputThreadBinding(
            parseRelationMutation(await readJson(request)),
          );
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId, threadBinding, origin } = resolveInputThreadBinding(
            parseRelationMutation(await readJson(request)),
          );
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskActivitiesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
      if (taskActivitiesRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskActivitiesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Activity routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { activities: database.listTaskActivities(taskId) });
        }
        return methodNotAllowed(response, ["GET"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Comment routes");
          const comments = after
            ? database.listCommentsAfter(taskId, after)
            : database.listComments(taskId);
          return sendJson(response, 200, {
            comments,
            nextCursor: nextCursor(comments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const comment = database.createComment(taskId, {
            ...resolveInputThreadBinding(parseCommentCreate(await readJson(request))),
            actor: actorFromRequest(request),
          });
          const task = database.getTask(taskId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = resolveInputThreadBinding(parseCommentPatch(await readJson(request)));
          const comment = database.updateComment(
            id,
            patch.version,
            patch.body,
            patch.threadId,
            patch.threadBinding,
          );
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listCommentAttachments(commentId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listAttachments(taskId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskArtifactsRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/artifacts$/);
      if (taskArtifactsRoute) {
        assertNoQuery(url.searchParams, "/api/local/tasks/:id/artifacts");
        const taskId = decodeRouteSegment(taskArtifactsRoute[1], "Task id");
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        if (request.method === "GET") {
          assertTaskArtifactEligible(task);
          return sendJson(response, 200, { artifacts: database.listTaskArtifacts(task.id) });
        }
        if (request.method === "POST") {
          const metadata = assertTaskCanAcceptArtifact(task);
          const completedTaskStatus = completedTaskStatusForMetadata(metadata);
          const artifactHeaders = parseArtifactHeaders(request);
          const declaredLength = Number(request.headers["content-length"] ?? 0);
          if (Number.isFinite(declaredLength) && declaredLength > ARTIFACT_MAX_BYTES) {
            throw new ApiError(413, "ARTIFACT_TOO_LARGE", "ZIP artifact cannot exceed 20 GiB");
          }
          const stored = await artifactService.acceptUpload({
            ...artifactHeaders,
            stream: request,
          });
          let artifact;
          try {
            const existing = database.listTaskArtifacts(task.id).find((candidate) => (
              candidate.filename === stored.filename && candidate.sha256 === stored.sha256
            ));
            if (existing) {
              const existingWork = database.getTaskArtifactForWork(existing.id);
              const existingContent = existingWork
                ? await artifactService.getStoredArtifactStats(existingWork.storageKey)
                : null;
              if (!existingContent?.isFile()) {
                throw new ApiError(
                  409,
                  "ARTIFACT_CONTENT_MISSING",
                  "A matching ZIP is already registered but its local content is missing; remove it before re-uploading",
                );
              }
            }
            artifact = database.createTaskArtifact(task.id, {
              ...stored,
              requiredTaskStatus: "in_progress",
              completedTaskStatus,
              actor: actorFromRequest(request),
            });
          } catch (error) {
            await artifactService.removeStoredArtifact(stored.storageKey);
            throw error;
          }
          const created = artifact.id === stored.id;
          if (!created) await artifactService.removeStoredArtifact(stored.storageKey);
          const updatedTask = database.getTask(task.id);
          if (created) events.emit("artifact.created", { artifact, task: updatedTask });
          if (updatedTask.version !== task.version) events.emit("task.updated", { task: updatedTask });
          const automaticUpload = maybeAutomaticallyEnqueueCompletedTask(updatedTask);
          return sendJson(response, created ? 201 : 200, {
            artifact,
            task: updatedTask,
            ...(automaticUpload.upload ? { upload: automaticUpload.upload } : {}),
            ...(automaticUpload.error ? { uploadEnqueueError: automaticUpload.error } : {}),
          });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/local/artifact-uploads") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const { projectId } = parseArtifactUploadListFilters(url.searchParams);
        const items = database.listArtifactUploadItems(projectId).filter(({ task }) => (
          Boolean(matchingFeishuTaskOrigin(task, task.feishuOrigin))
        ));
        return sendJson(response, 200, { items });
      }

      if (pathname === "/api/local/task-artifact-summaries") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const { projectId } = parseArtifactUploadListFilters(url.searchParams);
        const summaries = database.listTaskArtifactSummaryItems(projectId)
          .filter(({ task, origin }) => Boolean(matchingFeishuTaskOrigin(task, origin)))
          .map(({ summary }) => summary);
        return sendJson(response, 200, { summaries });
      }

      const taskArtifactUploadRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/upload(?:\/(retry))?$/);
      if (taskArtifactUploadRoute) {
        assertLoopbackRequest(request);
        const taskId = decodeRouteSegment(taskArtifactUploadRoute[1], "Task id");
        const action = taskArtifactUploadRoute[2] ?? null;
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        if (action === null && request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/local/tasks/:id/upload");
          assertTaskArtifactEligible(task);
          return sendJson(response, 200, { uploads: database.listTaskArtifactUploads(task.id) });
        }
        if (action === "retry" && request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/local/tasks/:id/upload/retry");
          assertTaskArtifactEligible(task);
          const { uploadId } = parseArtifactUploadRetry(await readJson(request));
          const existing = database.getArtifactUpload(uploadId);
          if (!existing || existing.taskId !== task.id) {
            throw new ApiError(404, "ARTIFACT_NOT_FOUND", "The upload queue item does not belong to this task");
          }
          const upload = database.retryArtifactUpload(uploadId);
          if (!upload) {
            throw new ApiError(409, "UPLOAD_NOT_RETRYABLE", "Only failed upload queue items can be retried");
          }
          emitArtifactUploadUpdated(upload);
          wakeUploadWorker();
          return sendJson(response, 202, { upload });
        }
        return methodNotAllowed(response, action === null ? ["GET", "POST"] : ["POST"]);
      }

      const taskArtifactUploadQueueRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/upload-queue$/);
      if (taskArtifactUploadQueueRoute) {
        assertLoopbackRequest(request);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/tasks/:id/upload-queue");
        const taskId = decodeRouteSegment(taskArtifactUploadQueueRoute[1], "Task id");
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        const { artifactId } = parseArtifactUploadEnqueue(await readJson(request));
        const metadata = assertTaskCanEnqueueArtifact(task);
        const artifact = database.getTaskArtifactForWork(artifactId);
        if (!artifact || artifact.taskId !== task.id) {
          throw new ApiError(404, "ARTIFACT_NOT_FOUND", "The selected ZIP does not belong to this task");
        }
        if (artifact.validationStatus !== "verified") {
          throw new ApiError(409, "ARTIFACT_NOT_VERIFIED", "Only verified ZIP artifacts can be uploaded");
        }
        const upload = enqueueArtifactUpload(task, metadata, artifact);
        return sendJson(response, 202, { upload });
      }

      const artifactDownloadRoute = pathname.match(/^\/api\/local\/artifacts\/([^/]+)\/download$/);
      if (artifactDownloadRoute) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        assertNoQuery(url.searchParams, "/api/local/artifacts/:id/download");
        const artifactId = decodeRouteSegment(artifactDownloadRoute[1], "Artifact id");
        const artifact = database.getTaskArtifactForWork(artifactId);
        if (!artifact) throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Artifact '${artifactId}' does not exist`);
        const task = database.getTask(artifact.taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${artifact.taskId}' does not exist`);
        assertTaskArtifactEligible(task);
        const details = await artifactService.getStoredArtifactStats(artifact.storageKey);
        if (!details?.isFile()) {
          throw new ApiError(404, "ARTIFACT_CONTENT_MISSING", "Artifact file is no longer available");
        }
        const encodedFilename = encodeURIComponent(artifact.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
          "content-length": details.size,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": "application/zip",
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const stream = artifactService.createDownloadStream(artifact.storageKey);
        await new Promise((resolve, reject) => {
          stream.once("error", reject);
          response.once("error", reject);
          response.once("finish", resolve);
          stream.pipe(response);
        });
        return;
      }

      const artifactRoute = pathname.match(/^\/api\/local\/artifacts\/([^/]+)$/);
      if (artifactRoute) {
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        assertNoQuery(url.searchParams, "/api/local/artifacts/:id");
        const artifactId = decodeRouteSegment(artifactRoute[1], "Artifact id");
        const artifact = database.getTaskArtifactForWork(artifactId);
        if (!artifact) throw new ApiError(404, "ARTIFACT_NOT_FOUND", `Artifact '${artifactId}' does not exist`);
        const task = database.getTask(artifact.taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${artifact.taskId}' does not exist`);
        assertTaskArtifactEligible(task);
        database.deleteTaskArtifact(artifact.id);
        await artifactService.removeStoredArtifact(artifact.storageKey);
        events.emit("artifact.deleted", { artifact, task });
        return sendEmpty(response, 204);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/(content|download)$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id) ?? database.getProjectReadmeAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = attachmentContentRoute[2] === "content"
          && (
            INLINE_ATTACHMENT_TYPES.has(attachment.contentType)
            || attachment.contentType.startsWith("video/")
          );
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const executeTaskRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/execute$/);
      if (executeTaskRoute) {
        assertAiLoopbackRequest(request);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/tasks/:id/execute");
        const id = decodeRouteSegment(executeTaskRoute[1], "Task id");
        const { trigger } = parseExecutionBody(await readJson(request));
        const task = database.getTask(id);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
        if (task.status !== "todo" && task.status !== "queued") {
          throw new ApiError(409, "TASK_NOT_STARTABLE", "Only ready tasks can be executed");
        }
        const metadata = requireTrustedFeishuTask(task, { requirePackage: true });
        return sendJson(response, 202, await startTrackedTask(task.id, () => executionCoordinator.schedule(
          task, metadata, trigger, { actor: actorFromRequest(request) },
        )));
      }

      const packageRefreshRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/package-refresh$/);
      if (packageRefreshRoute) {
        assertAiLoopbackRequest(request);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/tasks/:id/package-refresh");
        const id = decodeRouteSegment(packageRefreshRoute[1], "Task id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["version"]));
        const version = parseVersion(body.version);
        const task = database.getTask(id);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
        const origin = requireTrustedFeishuTask(task, { requirePackage: true });
        const packageRecord = typeof feishuPackages.get === "function"
          ? await feishuPackages.get(origin.packageAlias)
          : (await feishuPackages.read())[origin.packageAlias] ?? null;
        if (!packageRecord) {
          throw new ApiError(409, "UNKNOWN_PACKAGE_ALIAS", "The task's Auto-Cut package is no longer configured");
        }
        if (packageRecord.state && packageRecord.state !== "enabled") {
          throw new ApiError(409, "PACKAGE_DISABLED", "Enable the Auto-Cut package before refreshing this task");
        }
        const snapshot = {
          packageAlias: packageRecord.alias ?? origin.packageAlias,
          packageRevision: packageRecord.revision,
          name: packageRecord.name ?? packageRecord.projectName ?? origin.packageAlias,
          projectId: packageRecord.projectId ?? null,
          workspacePath: packageRecord.workspacePath,
          model: packageRecord.model ?? null,
          reasoningEffort: packageRecord.reasoningEffort ?? null,
          prompt: packageRecord.prompt,
          zipSourceDirectory: packageRecord.zipSourceDirectory ?? packageRecord.artifactSourcePath ?? null,
          maxConcurrent: packageRecord.maxConcurrent,
        };
        const refreshed = database.refreshFeishuTaskPackageSnapshot(
          task.id,
          version,
          snapshot,
          actorFromRequest(request),
        );
        events.emit("task.updated", { task: refreshed });
        return sendJson(response, 200, { task: refreshed });
      }

      const taskTreeRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/tree$/);
      if (taskTreeRoute) {
        let id;
        try {
          id = decodeURIComponent(taskTreeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const { direction, depth } = parseTaskTreeQuery(url.searchParams);
        return sendJson(response, 200, { tree: database.getTaskTree(id, direction, depth) });
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move|start-ai))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "PATCH") {
          const actor = actorFromRequest(request);
          const {
            version,
            changes,
            threadId,
            threadBinding,
            assigneeTarget,
          } = resolveInputThreadBinding(parseTaskPatch(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          let jiraChanged = false;
          if (current.source !== "jira" && changes.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_PROJECT_MOVE_UNAVAILABLE",
              "本地任务不能移入 Jira 同步项目",
            );
          }
          if (current.source === "jira") {
            if (current.version !== version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be updated");
            }
            if (Object.hasOwn(changes, "projectId")) {
              throw new ApiError(409, "JIRA_PROJECT_MOVE_UNAVAILABLE", "Jira 任务不能移到本地项目");
            }
            if (assigneeTarget !== undefined) {
              throw new ApiError(409, "JIRA_ASSIGNEE_UNAVAILABLE", "请在 Jira 中修改经办人");
            }
            const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
            const recurrence = Object.hasOwn(changes, "recurrence")
              ? changes.recurrence
              : current.recurrence;
            if (recurrence && !dueDate) {
              throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
            }
            jiraChanged = await jira.updateTask(current, changes);
          }
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actor);
          }
          let task;
          try {
            task = database.updateTask(id, version, changes, threadId, threadBinding, actor);
          } catch (error) {
            if (jiraChanged) {
              try {
                await jira.reconcile();
              } catch {
                throw new ApiError(
                  502,
                  "JIRA_RECONCILE_FAILED",
                  "Jira 已更新，但 Taskboard 重新同步失败，请手动同步",
                );
              }
            }
            throw error;
          }
          events.emit("task.updated", { task });
          const automaticUpload = maybeAutomaticallyEnqueueCompletedTask(task);
          return sendJson(response, 200, {
            task,
            ...(automaticUpload.upload ? { upload: automaticUpload.upload } : {}),
            ...(automaticUpload.error ? { uploadEnqueueError: automaticUpload.error } : {}),
          });
        }
        if (!action && request.method === "DELETE") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_DELETE_UNAVAILABLE", "Jira 任务不能从 Taskboard 永久删除");
          }
          const { version } = parseArchive(await readJson(request));
          const deleted = database.deleteArchivedTask(id, version);
          for (const attachmentId of deleted.attachmentIds) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachmentId));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          for (const storageKey of deleted.artifactStorageKeys) {
            await artifactService.removeStoredArtifact(storageKey);
          }
          events.emit("task.deleted", { task: deleted.task });
          return sendEmpty(response, 204);
        }
        if (action === "start-ai" && request.method === "POST") {
          assertAiLoopbackRequest(request);
          await parseStartAiBody(await readJson(request));
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (task.status !== "todo" && task.status !== "queued") {
            throw new ApiError(
              409,
              "TASK_NOT_STARTABLE",
              "Only ready tasks can be started with Codex",
            );
          }
          const metadata = requireTrustedFeishuTask(task, { requirePackage: true });
          return sendJson(response, 202, await startTrackedTask(task.id, () => executionCoordinator.schedule(
            task, metadata, "manual", { actor: actorFromRequest(request) },
          )));
        }
        if (action === "move" && request.method === "POST") {
          const move = resolveInputThreadBinding(parseMove(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          const marker = parseFeishuTaskMetadata(current.description);
          if (current?.status === "queued" && move.status === "in_progress") {
            throw new ApiError(
              409,
              "TASK_EXECUTION_PENDING",
              "Queued executions start automatically when their package slot is available",
            );
          }
          if (current.status === "todo" && move.status === "in_progress" && marker) {
            assertAiLoopbackRequest(request);
            const metadata = requireTrustedFeishuTask(current, { requirePackage: true });
            return sendJson(response, 202, await startTrackedTask(current.id, () => executionCoordinator.schedule(
              current, metadata, "move", { actor: actorFromRequest(request) },
            )));
          }
          if (current.source === "jira") {
            if (current.version !== move.version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: move.version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
            }
            await jira.moveTask(current, move.status);
          }
          const task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            move.threadId,
            move.threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.moved", { task });
          const automaticUpload = maybeAutomaticallyEnqueueCompletedTask(task);
          return sendJson(response, 200, {
            task,
            ...(automaticUpload.upload ? { upload: automaticUpload.upload } : {}),
            ...(automaticUpload.error ? { uploadEnqueueError: automaticUpload.error } : {}),
          });
        }
        if (action === "archive" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_ARCHIVE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动归档");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.archiveTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_RESTORE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动恢复");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.restoreTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof ArtifactServiceError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  const cloudRealtimeServer = new WebSocketServer({ noServer: true });
  const cloudRealtimeSockets = new Set();

  function rejectWebSocketUpgrade(socket, status, message) {
    const body = `${message}\n`;
    socket.end([
      `HTTP/1.1 ${status} ${message}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"));
  }

  function closeOrTerminateWebSocket(webSocket, code, reason) {
    if (webSocket.readyState !== WebSocketClient.OPEN) {
      webSocket.terminate();
      return;
    }
    if (code >= 1000 && ![1004, 1005, 1006, 1015].includes(code)) {
      webSocket.close(code, reason);
    } else {
      webSocket.terminate();
    }
  }

  server.on("upgrade", async (request, socket, head) => {
    let remoteSocket;
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (resolved.instanceToken) {
        if (!incomingUrl.pathname.startsWith(`${routePrefix}/`)) {
          rejectWebSocketUpgrade(socket, 404, "Not Found");
          return;
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }
      assertTrustedNetworkRequest(
        request,
        Boolean(resolved.instanceToken),
        resolved.trustedOrigins,
      );
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/api/events" || [...url.searchParams.keys()].length > 0) {
        rejectWebSocketUpgrade(socket, 404, "Not Found");
        return;
      }
      assertLoopbackRequest(request);
      const target = await cloudProxy.webSocketTarget("/api/events");
      remoteSocket = new WebSocketClient(target.url, { headers: target.headers });
      const pendingMessages = [];
      const queueMessage = (data, isBinary) => pendingMessages.push({ data, isBinary });
      remoteSocket.on("message", queueMessage);
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          remoteSocket.off("open", onOpen);
          remoteSocket.off("error", onError);
          remoteSocket.off("close", onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Cloud realtime connection closed before opening"));
        };
        remoteSocket.once("open", onOpen);
        remoteSocket.once("error", onError);
        remoteSocket.once("close", onClose);
      });
      cloudRealtimeServer.handleUpgrade(request, socket, head, (localSocket) => {
        const pair = { localSocket, remoteSocket };
        cloudRealtimeSockets.add(pair);
        const removePair = () => cloudRealtimeSockets.delete(pair);
        const forwardMessage = (data, isBinary) => {
          if (localSocket.readyState === WebSocketClient.OPEN) {
            localSocket.send(data, { binary: isBinary });
          }
        };

        remoteSocket.off("message", queueMessage);
        remoteSocket.on("message", forwardMessage);
        for (const { data, isBinary } of pendingMessages) forwardMessage(data, isBinary);

        localSocket.on("message", () => {
          localSocket.close(1008, "Client messages are not supported");
        });
        localSocket.on("close", (code, reason) => {
          removePair();
          closeOrTerminateWebSocket(remoteSocket, code, reason);
        });
        localSocket.on("error", () => remoteSocket.terminate());

        remoteSocket.on("close", (code, reason) => {
          removePair();
          closeOrTerminateWebSocket(localSocket, code, reason);
        });
        remoteSocket.on("error", () => {
          if (localSocket.readyState === WebSocketClient.OPEN) {
            localSocket.close(1011, "Cloud realtime connection failed");
          }
        });
      });
    } catch (error) {
      remoteSocket?.terminate();
      rejectWebSocketUpgrade(socket, error?.status ?? 502, "WebSocket connection failed");
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort(), fd = null } = {}) {
      const resolvedHost = resolveHost(host);
      if (fd !== null && (!Number.isInteger(fd) || fd < 3 || fd > 255)) {
        throw new Error("Taskboard server listen fd must be an inherited file descriptor");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (fd === null) server.listen(port, resolvedHost);
        else server.listen({ fd });
      });
      let address;
      try {
        address = assertLoopbackListenAddress(server.address());
      } catch (error) {
        await new Promise((resolve) => {
          server.close(() => resolve());
        });
        throw error;
      }
      listening = true;
      reconcileAutomaticArtifactUploads();
      startUploadWorker();
      return address;
    },
    async close() {
      closing = true;
      taskStartAbortController.abort();
      cancelQueuedTaskStarts();
      for (const { localSocket, remoteSocket } of cloudRealtimeSockets) {
        localSocket.terminate();
        remoteSocket.terminate();
      }
      cloudRealtimeSockets.clear();
      cloudRealtimeServer.close();
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await executionCoordinator.close();
      await settleTaskStarts();
      await uploadWorker.close();
      await aiChat.close();
      await projectSummary.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
