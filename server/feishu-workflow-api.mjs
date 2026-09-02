import { ApiError } from "./database.mjs";

const BRIDGE_MACHINE_LOCAL_DIAGNOSTIC_CODES = new Set([
  "ARTIFACT_SOURCE_PATH_UNBOUND",
  "UPLOAD_TARGET_PATH_UNBOUND",
]);

function mergeDiagnostics(...groups) {
  const diagnostics = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const key = `${entry.code ?? ""}\u0000${entry.path ?? ""}\u0000${entry.alias ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(entry);
    }
  }
  return diagnostics;
}

function requireObjectBody(body, label) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", `${label} body must be an object`);
  }
}

function assertBodyKeys(body, allowed, label) {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown ${label} field '${unknown}'`);
}

function requireSubjectKey(body) {
  if (typeof body.subjectKey !== "string" || body.subjectKey.trim() === "") {
    throw new ApiError(400, "INVALID_FIELD", "subjectKey is required");
  }
  return body.subjectKey;
}

function requireStateRevision(body) {
  if (!Number.isSafeInteger(body.stateRevision) || body.stateRevision < 1) {
    throw new ApiError(400, "INVALID_FIELD", "stateRevision must be a positive integer");
  }
  return body.stateRevision;
}

function assertNoQuery(query, label) {
  for (const key of query.keys()) {
    throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${label} does not accept query parameter '${key}'`);
  }
}

function viewSubjectKeyFromQuery(query) {
  for (const key of query.keys()) {
    if (key !== "subjectKey") {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Workflow views GET does not accept query parameter '${key}'`);
    }
  }
  const values = query.getAll("subjectKey");
  if (values.length !== 1 || values[0].trim() === "") {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Exactly one subjectKey query parameter is required");
  }
  return values[0];
}

function stageDisplaySubjectKeyFromQuery(query) {
  for (const key of query.keys()) {
    if (key !== "subjectKey") {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Stage display GET does not accept query parameter '${key}'`);
    }
  }
  const values = query.getAll("subjectKey");
  if (values.length !== 1 || values[0].trim() === "") {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Exactly one subjectKey query parameter is required");
  }
  return values[0];
}

export function createFeishuWorkflowApi({ database, store, previewBase = null, inspectShareImport = null }) {
  return {
    async handle({ method, pathname, body, query = new URLSearchParams() }) {
      if (pathname === "/api/local/feishu/workflow/stage-displays") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        const subjectKey = stageDisplaySubjectKeyFromQuery(query);
        return {
          status: 200,
          body: { overrides: database.getStageDisplayOverrides(subjectKey) },
        };
      }
      const stageDisplayMatch = pathname.match(/^\/api\/local\/feishu\/workflow\/stage-displays\/([^/]+)$/);
      if (stageDisplayMatch) {
        if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        assertNoQuery(query, "Stage display mutations");
        let stageId;
        try {
          stageId = decodeURIComponent(stageDisplayMatch[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Stage id contains invalid encoding");
        }
        requireObjectBody(body, "Stage display update");
        assertBodyKeys(body, new Set([
          "subjectKey", "revision", "zhName", "enName", "zhDescription", "enDescription",
        ]), "stage display update");
        const subjectKey = requireSubjectKey(body);
        if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
          throw new ApiError(400, "INVALID_FIELD", "revision must be a positive integer");
        }
        const patch = {};
        for (const field of ["zhName", "enName", "zhDescription", "enDescription"]) {
          if (Object.hasOwn(body, field)) patch[field] = body[field];
        }
        return {
          status: 200,
          body: {
            overrides: database.saveStageDisplayOverride(subjectKey, stageId, body.revision, patch),
          },
        };
      }
      if (pathname === "/api/local/feishu/workflow/views") {
        if (method === "GET") {
          const subjectKey = viewSubjectKeyFromQuery(query);
          return { status: 200, body: { state: database.getUnifiedWorkflowViews(subjectKey) } };
        }
        assertNoQuery(query, "Workflow view mutations");
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        requireObjectBody(body, "Workflow view create");
        assertBodyKeys(body, new Set(["subjectKey", "name", "stageIds", "stateRevision"]), "workflow view create");
        requireSubjectKey(body);
        requireStateRevision(body);
        if (!Object.hasOwn(body, "name") || !Object.hasOwn(body, "stageIds")) {
          throw new ApiError(400, "INVALID_FIELD", "name and stageIds are required");
        }
        return { status: 201, body: { state: database.createUnifiedWorkflowView(body) } };
      }
      const viewMatch = pathname.match(/^\/api\/local\/feishu\/workflow\/views\/([^/]+)$/);
      if (viewMatch) {
        assertNoQuery(query, "Workflow view mutations");
        let viewId;
        try { viewId = decodeURIComponent(viewMatch[1]); } catch { throw new ApiError(400, "INVALID_PATH", "View id contains invalid encoding"); }
        if (method !== "PATCH" && method !== "DELETE") {
          throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }
        requireObjectBody(body, "Workflow view mutation");
        if (method === "DELETE") {
          assertBodyKeys(body, new Set(["subjectKey", "stateRevision"]), "workflow view delete");
          const subjectKey = requireSubjectKey(body);
          const stateRevision = requireStateRevision(body);
          return {
            status: 200,
            body: { state: database.deleteUnifiedWorkflowView(viewId, { subjectKey, stateRevision }) },
          };
        }
        assertBodyKeys(body, new Set([
          "subjectKey", "stateRevision", "viewRevision", "name", "stageIds", "defaultViewId", "activeViewId",
        ]), "workflow view update");
        const subjectKey = requireSubjectKey(body);
        const stateRevision = requireStateRevision(body);
        const updatesView = Object.hasOwn(body, "name") || Object.hasOwn(body, "stageIds");
        const updatesState = Object.hasOwn(body, "defaultViewId") || Object.hasOwn(body, "activeViewId");
        if (!updatesView && !updatesState) {
          throw new ApiError(400, "INVALID_FIELD", "A workflow view or view-state field is required");
        }
        if (updatesView) {
          if (!Number.isSafeInteger(body.viewRevision) || body.viewRevision < 1) {
            throw new ApiError(400, "INVALID_FIELD", "viewRevision must be a positive integer");
          }
          return { status: 200, body: { state: database.updateUnifiedWorkflowView(viewId, body) } };
        }
        if (Object.hasOwn(body, "viewRevision")) {
          throw new ApiError(400, "INVALID_FIELD", "viewRevision is only valid when updating a view");
        }
        return {
          status: 200,
          body: { state: database.updateUnifiedWorkflowView(viewId, {
            subjectKey,
            stateRevision,
            ...(Object.hasOwn(body, "defaultViewId") ? { defaultViewId: body.defaultViewId } : {}),
            ...(Object.hasOwn(body, "activeViewId") ? { activeViewId: body.activeViewId } : {}),
          }) },
        };
      }
      if (pathname === "/api/local/feishu/workflow/share/export") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { configuration: await store.exportShareable() } };
      }
      if (pathname === "/api/local/feishu/workflow/share/import") {
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new ApiError(400, "INVALID_BODY", "Share import body must be an object");
        }
        const unknown = Object.keys(body).find((key) => !new Set(["configuration", "dryRun"]).has(key));
        if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown share import field '${unknown}'`);
        if (!Object.hasOwn(body, "configuration")) {
          throw new ApiError(400, "INVALID_FIELD", "configuration is required");
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          throw new ApiError(400, "INVALID_FIELD", "dryRun must be boolean");
        }
        const localPreview = await store.importShareable(body.configuration, { dryRun: true });
        const bridgePreview = typeof inspectShareImport === "function"
          ? await inspectShareImport(localPreview.configuration)
          : null;
        const bridgeDiagnostics = Array.isArray(bridgePreview?.diagnostics)
          ? bridgePreview.diagnostics.filter((entry) => (
            !BRIDGE_MACHINE_LOCAL_DIAGNOSTIC_CODES.has(entry?.code)
          ))
          : [];
        if (body.dryRun === true) {
          const diagnostics = mergeDiagnostics(bridgeDiagnostics, localPreview.diagnostics);
          const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
          return {
            status: 200,
            body: { ...localPreview, diagnostics, diagnosticsOk, dryRun: true },
          };
        }
        const result = await store.importShareable(localPreview.configuration, { dryRun: false });
        const diagnostics = mergeDiagnostics(bridgeDiagnostics, result.diagnostics);
        const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
        return {
          status: 200,
          body: { ...result, diagnostics, diagnosticsOk, dryRun: false },
        };
      }
      if (pathname === "/api/local/feishu/workflow/subjects") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { subjects: (await store.listCatalog()).flatMap((base) => base.subjects) } };
      }
      if (pathname === "/api/local/feishu/workflow/package-aliases") {
        if (method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        return { status: 200, body: { aliases: await store.packageAliases() } };
      }
      if (pathname === "/api/local/feishu/workflow/catalog") {
        if (method === "GET") return { status: 200, body: { catalog: await store.listCatalog() } };
        if (method === "POST") {
          let preview = body;
          if (typeof body?.url === "string") {
            if (typeof previewBase !== "function") {
              throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Feishu Bridge preview is unavailable");
            }
            preview = await previewBase(body.url);
          }
          return { status: 201, body: { catalog: [await store.upsertBasePreview(preview)] } };
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      const baseMatch = pathname.match(/^\/api\/local\/feishu\/workflow\/bases\/([^/]+)$/);
      if (baseMatch) {
        if (method !== "DELETE") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        let baseToken;
        try { baseToken = decodeURIComponent(baseMatch[1]); } catch { throw new ApiError(400, "INVALID_PATH", "Base token contains invalid encoding"); }
        return { status: 200, body: { catalog: await store.removeBase(baseToken) } };
      }
      const match = pathname.match(/^\/api\/local\/feishu\/workflow\/subjects\/([^/]+)(?:\/(enable|disable|display))?$/);
      if (!match) return null;
      let subjectKey;
      try { subjectKey = decodeURIComponent(match[1]); } catch { throw new ApiError(400, "INVALID_PATH", "Subject key contains invalid encoding"); }
      if (match[2]) {
        if (match[2] === "display") {
          if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          if (typeof body?.displayEnabled !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
          }
          const subject = await store.setSubjectDisplayEnabled(subjectKey, body.displayEnabled);
          return { status: 200, body: { subject } };
        }
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        if (!Number.isInteger(body?.expectedVersion)) throw new ApiError(400, "INVALID_FIELD", "expectedVersion must be an integer");
        const subject = match[2] === "enable"
          ? await store.enableSubject(subjectKey, body.expectedVersion)
          : await store.disableSubject(subjectKey, body.expectedVersion);
        return { status: 200, body: { subject } };
      }
      if (method === "GET") {
        return { status: 200, body: { subject: await store.getSubject(subjectKey) } };
      }
      if (method === "DELETE") {
        return { status: 200, body: { catalog: await store.removeSubject(subjectKey) } };
      }
      if (method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return { status: 200, body: { subject: await store.saveSubjectDraft(subjectKey, body) } };
    },
  };
}
