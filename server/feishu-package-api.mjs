import { stat } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { PackageConfigError } from "./feishu-package-config.mjs";

const PACKAGE_ROOT = "/api/local/autocut/packages";
const PACKAGE_FIELDS = new Set([
  "alias", "name", "projectName", "projectId", "workspacePath", "model", "reasoningEffort",
  "prompt", "zipSourceDirectory", "maxConcurrent", "state", "updatedAt", "revision", "expectedRevision",
]);

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", `${name} must be an object`);
  }
  return value;
}

function assertAllowed(body, allowed, name) {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `${name}.${unknown} is not supported`);
}

function revision(body, { required = true } = {}) {
  const value = body?.expectedRevision ?? body?.revision;
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "revision must be a positive integer");
  }
  return value;
}

function decodeAlias(value) {
  try {
    const alias = decodeURIComponent(value);
    if (!alias || alias.length > 256 || alias.includes("\0")) throw new Error("invalid");
    return alias;
  } catch {
    throw new ApiError(400, "INVALID_PATH", "Package alias contains invalid encoding");
  }
}

function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof PackageConfigError) {
    return new ApiError(error.status ?? 409, error.code, error.message, error.details);
  }
  return new ApiError(500, "PACKAGE_REGISTRY_FAILED", "Unable to update the Auto-Cut package registry");
}

function packagePatch(body) {
  plainObject(body, "package");
  assertAllowed(body, PACKAGE_FIELDS, "package");
  const patch = { ...body };
  if (patch.name === undefined && patch.projectName !== undefined) patch.name = patch.projectName;
  delete patch.projectName;
  delete patch.state;
  delete patch.updatedAt;
  delete patch.expectedRevision;
  delete patch.revision;
  return patch;
}

export function createFeishuPackageApi({ store, getModelCatalog = null } = {}) {
  if (!store) throw new TypeError("createFeishuPackageApi requires a package store");
  return {
    async handle({ method, pathname, body }) {
      try {
        if (pathname === PACKAGE_ROOT) {
          if (method === "GET") return { status: 200, body: { packages: await store.list() } };
          if (method === "POST") {
            const input = packagePatch(body);
            const record = await store.saveDraft(input);
            return { status: 201, body: { package: record } };
          }
          throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }

        if (pathname === `${PACKAGE_ROOT}/catalog`) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "catalog");
          assertAllowed(input, new Set(["workspacePath"]), "catalog");
          if (typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath.trim())) {
            throw new ApiError(400, "INVALID_FIELD", "workspacePath must be absolute");
          }
          const workspacePath = path.normalize(input.workspacePath.trim());
          try {
            if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
          } catch {
            throw new ApiError(409, "PACKAGE_WORKSPACE_UNAVAILABLE", "workspacePath is unavailable");
          }
          if (typeof getModelCatalog !== "function") {
            throw new ApiError(503, "PACKAGE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable");
          }
          let catalog;
          try { catalog = await getModelCatalog(workspacePath); } catch {
            throw new ApiError(503, "PACKAGE_MODEL_CATALOG_UNAVAILABLE", "Codex model catalog is unavailable");
          }
          return { status: 200, body: catalog && typeof catalog === "object" ? catalog : { catalog } };
        }
        const match = pathname.match(/^\/api\/local\/autocut\/packages\/([^/]+)(?:\/(enable|disable))?$/);
        if (!match) return null;

        const alias = decodeAlias(match[1]);
        const action = match[2];
        if (action) {
          if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          const input = plainObject(body, "package action");
          assertAllowed(input, new Set(["revision", "expectedRevision"]), "package action");
          const expectedRevision = revision(input);
          const record = action === "enable"
            ? await store.enable(alias, expectedRevision, {
              modelCatalog: typeof getModelCatalog === "function"
                ? await getModelCatalog((await store.get(alias))?.workspacePath)
                : undefined,
            })
            : await store.disable(alias, expectedRevision);
          return { status: 200, body: { package: record } };
        }
        if (method === "GET") {
          const record = await store.get(alias);
          if (!record) throw new ApiError(404, "PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`);
          return { status: 200, body: { package: record } };
        }
        if (method === "PATCH") {
          const input = plainObject(body, "package");
          const expectedRevision = revision(input);
          const record = await store.saveDraft(alias, packagePatch(input), expectedRevision);
          return { status: 200, body: { package: record } };
        }
        if (method === "DELETE") {
          const input = body === null || body === undefined ? {} : plainObject(body, "package delete");
          assertAllowed(input, new Set(["revision", "expectedRevision"]), "package delete");
          const record = await store.remove(alias, revision(input, { required: false }));
          return { status: 200, body: { package: record } };
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      } catch (error) {
        throw toApiError(error);
      }
    },
  };
}
