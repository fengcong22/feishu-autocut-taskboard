import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const STATES = new Set(["draft", "enabled", "disabled"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

export class PackageConfigError extends Error {
  constructor(code, message, details = undefined, status = 409) {
    super(message);
    this.name = "PackageConfigError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function nowIso() { return new Date().toISOString(); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function requireText(value, name, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new PackageConfigError("PACKAGE_INVALID", `${name} must be a non-empty string`, undefined, 400);
  }
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new PackageConfigError("PACKAGE_INVALID", `${name} must be a non-empty string`, undefined, 400);
  }
  return value.trim();
}

function optionalPath(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const result = requireText(value, name);
  if (!path.isAbsolute(result) || result.includes("\0")) {
    throw new PackageConfigError("PACKAGE_INVALID", `${name} must be absolute`, undefined, 400);
  }
  return path.normalize(result);
}

function packageAlias(value, name = "package alias") {
  const result = requireText(value, name);
  if (!ID_PATTERN.test(result)) {
    throw new PackageConfigError("PACKAGE_INVALID", `${name} is invalid`, undefined, 400);
  }
  return result;
}

function positiveInteger(value, name, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PackageConfigError("PACKAGE_INVALID", `${name} must be a positive integer`, undefined, 400);
  }
  return value;
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageConfigError("PACKAGE_INVALID", `${name} must be an object`, undefined, 400);
  }
  return value;
}

function normalizeRecord(aliasKey, raw, { now = nowIso, legacy = false } = {}) {
  const entry = plainObject(raw, `packages.${aliasKey}`);
  const alias = packageAlias(entry.alias ?? aliasKey);
  const name = requireText(entry.name ?? entry.projectName ?? alias, `packages.${alias}.name`);
  const projectId = requireText(entry.projectId ?? alias, `packages.${alias}.projectId`);
  const workspacePath = optionalPath(entry.workspacePath, `packages.${alias}.workspacePath`);
  const zipSourceDirectory = optionalPath(
    entry.zipSourceDirectory ?? entry.artifactSourcePath,
    `packages.${alias}.zipSourceDirectory`,
  );
  const model = entry.model === undefined || entry.model === null || entry.model === ""
    ? null : requireText(entry.model, `packages.${alias}.model`);
  const reasoningEffort = entry.reasoningEffort === undefined
    || entry.reasoningEffort === null || entry.reasoningEffort === ""
    ? null : requireText(entry.reasoningEffort, `packages.${alias}.reasoningEffort`);
  const prompt = entry.prompt === undefined || entry.prompt === null || entry.prompt === ""
    ? null : requireText(entry.prompt, `packages.${alias}.prompt`);
  const state = entry.state === undefined ? (legacy ? "enabled" : "draft") : entry.state;
  if (!STATES.has(state)) {
    throw new PackageConfigError("PACKAGE_INVALID", `packages.${alias}.state is invalid`, undefined, 400);
  }
  const revision = entry.revision === undefined ? 1 : entry.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new PackageConfigError("PACKAGE_INVALID", `packages.${alias}.revision must be a positive integer`, undefined, 400);
  }
  const updatedAt = typeof entry.updatedAt === "string" && entry.updatedAt.trim()
    ? entry.updatedAt.trim() : now();
  return {
    alias,
    name,
    // Retain the old field while the existing execution path is migrated to
    // the canonical display name in a later slice.
    projectName: name,
    projectId,
    workspacePath,
    model,
    reasoningEffort,
    prompt,
    zipSourceDirectory,
    maxConcurrent: positiveInteger(entry.maxConcurrent, `packages.${alias}.maxConcurrent`),
    state,
    revision,
    updatedAt,
  };
}

/** Normalize a versioned registry or the legacy package map. */
export function normalizeFeishuPackages(value, { now = nowIso } = {}) {
  const root = plainObject(value, "Feishu package configuration");
  const wrapped = root.packages !== undefined;
  const source = wrapped ? plainObject(root.packages, "packages") : root;
  const packages = {};
  const projectIds = new Map();
  for (const [key, raw] of Object.entries(source)) {
    if (wrapped && ["version", "host", "port", "taskboardUrl", "stateFile", "tables"].includes(key)) continue;
    const record = normalizeRecord(key, raw, { now, legacy: !wrapped || raw?.state === undefined });
    if (packages[record.alias]) {
      throw new PackageConfigError("PACKAGE_ALIAS_EXISTS", `duplicate package alias: ${record.alias}`, undefined, 409);
    }
    const previous = projectIds.get(record.projectId);
    if (previous && previous !== record.alias) {
      throw new PackageConfigError("PACKAGE_PROJECT_ID_EXISTS", `duplicate package projectId: ${record.projectId}`, undefined, 409);
    }
    projectIds.set(record.projectId, record.alias);
    packages[record.alias] = record;
  }
  return packages;
}

function catalogModels(catalog) {
  if (Array.isArray(catalog)) return catalog;
  return Array.isArray(catalog?.models) ? catalog.models : [];
}

function validateModel(record, catalog) {
  if (!record.model || !record.reasoningEffort) {
    throw new PackageConfigError(
      "PACKAGE_ENABLE_INVALID",
      "Auto-Cut package requires a model and reasoning effort before enabling",
    );
  }
  if (!catalog) return;
  const model = catalogModels(catalog).find((candidate) => (
    candidate?.slug === record.model || candidate?.id === record.model
  ));
  if (!model) {
    throw new PackageConfigError("PACKAGE_MODEL_UNAVAILABLE", `Model '${record.model}' is not available on this machine`);
  }
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((entry) => (
        typeof entry === "string" ? [entry] : typeof entry?.effort === "string" ? [entry.effort] : []
      ))
      : [];
  if (!efforts.includes(record.reasoningEffort)) {
    throw new PackageConfigError(
      "PACKAGE_MODEL_UNAVAILABLE",
      `Reasoning effort '${record.reasoningEffort}' is not supported by model '${record.model}'`,
    );
  }
}

async function assertDirectory(value, code, field) {
  if (!value || !path.isAbsolute(value)) throw new PackageConfigError(code, `${field} must be an absolute directory`);
  try {
    if (!(await stat(value)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new PackageConfigError(code, `${field} is unavailable`);
  }
}

async function assertSafeRegistryPath(filename) {
  if (!filename) return;
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || info.nlink > 1) {
      throw new PackageConfigError("PACKAGE_REGISTRY_UNSAFE", "Package registry must be a single-link regular file");
    }
    if (!info.isFile()) throw new PackageConfigError("PACKAGE_REGISTRY_UNSAFE", "Package registry must be a regular file");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

export function createFeishuPackageStore({
  filename,
  packages,
  now = nowIso,
  listReferences = async () => [],
  modelCatalog = null,
  getModelCatalog = null,
} = {}) {
  let inline = packages === undefined ? null : normalizeFeishuPackages(packages, { now });
  let writeQueue = Promise.resolve();

  async function readCatalog() {
    if (inline !== null) return clone(inline);
    if (!filename) return {};
    await assertSafeRegistryPath(filename);
    try {
      return normalizeFeishuPackages(JSON.parse(await readFile(filename, "utf8")), { now });
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeCatalog(next) {
    const normalized = normalizeFeishuPackages({ version: REGISTRY_VERSION, packages: next }, { now });
    if (inline !== null) {
      inline = normalized;
      return clone(normalized);
    }
    if (!filename) throw new PackageConfigError("PACKAGE_REGISTRY_UNAVAILABLE", "Package registry path is not configured", undefined, 503);
    await assertSafeRegistryPath(filename);
    await mkdir(path.dirname(filename), { recursive: true });
    const temporaryPath = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await writeFile(temporaryPath, `${JSON.stringify({ version: REGISTRY_VERSION, packages: normalized }, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, filename);
      await chmod(filename, 0o600);
    });
    await writeQueue;
    return clone(normalized);
  }

  async function current(alias) {
    const catalog = await readCatalog();
    const normalizedAlias = packageAlias(alias);
    return { catalog, alias: normalizedAlias, record: catalog[normalizedAlias] ?? null };
  }

  function assertRevision(record, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) {
      throw new PackageConfigError("PACKAGE_REVISION_REQUIRED", "Package revision is required for this mutation");
    }
    if (expectedRevision !== record.revision) {
      throw new PackageConfigError(
        "PACKAGE_REVISION_CONFLICT",
        `Package '${record.alias}' has changed; reload it before saving`,
        { expectedRevision, actualRevision: record.revision },
      );
    }
  }

  async function saveDraft(input, expectedRevision = undefined, patch = undefined) {
    let originalAlias = null;
    let changes = input;
    if (typeof input === "string") {
      originalAlias = packageAlias(input);
      if (patch !== undefined) {
        changes = expectedRevision;
        expectedRevision = patch;
      } else {
        changes = expectedRevision;
        expectedRevision = changes?.expectedRevision;
      }
    }
    changes = plainObject(changes, "package");
    const aliasFromChanges = changes.alias === undefined ? originalAlias : packageAlias(changes.alias);
    if (!aliasFromChanges) throw new PackageConfigError("PACKAGE_INVALID", "package alias is required", undefined, 400);
    const catalog = await readCatalog();
    const existing = catalog[originalAlias ?? aliasFromChanges] ?? null;
    if (existing && !originalAlias && expectedRevision === undefined && changes.expectedRevision === undefined) {
      throw new PackageConfigError("PACKAGE_ALIAS_EXISTS", `Package alias '${aliasFromChanges}' already exists`);
    }
    if (existing) assertRevision(existing, expectedRevision ?? changes.expectedRevision);
    if (originalAlias && aliasFromChanges !== originalAlias && existing?.state !== "draft") {
      const refs = await listReferences(originalAlias);
      if (refs.length > 0) throw new PackageConfigError("PACKAGE_ALIAS_IMMUTABLE", `Package '${originalAlias}' alias is in use`);
      throw new PackageConfigError("PACKAGE_ALIAS_IMMUTABLE", `Package '${originalAlias}' alias cannot be changed after enabling`);
    }
    if (!existing && catalog[aliasFromChanges]) throw new PackageConfigError("PACKAGE_ALIAS_EXISTS", `Package alias '${aliasFromChanges}' already exists`);
    const base = existing ?? { alias: aliasFromChanges, name: aliasFromChanges, projectId: aliasFromChanges, state: "draft" };
    const record = normalizeRecord(aliasFromChanges, { ...base, ...changes, alias: aliasFromChanges }, { now, legacy: false });
    if (existing && originalAlias && aliasFromChanges !== originalAlias) delete catalog[originalAlias];
    if (existing && record.alias !== existing.alias && catalog[record.alias]) throw new PackageConfigError("PACKAGE_ALIAS_EXISTS", `Package alias '${record.alias}' already exists`);
    record.revision = (existing?.revision ?? 0) + 1;
    record.updatedAt = now();
    catalog[record.alias] = record;
    return (await writeCatalog(catalog))[record.alias];
  }

  async function enable(alias, expectedRevision, options = {}) {
    const currentValue = await current(alias);
    if (!currentValue.record) throw new PackageConfigError("PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`, undefined, 404);
    assertRevision(currentValue.record, expectedRevision);
    const record = clone(currentValue.record);
    await assertDirectory(record.workspacePath, "PACKAGE_ENABLE_INVALID", "workspacePath");
    if (!record.prompt) throw new PackageConfigError("PACKAGE_ENABLE_INVALID", "prompt is required before enabling");
    if (!Number.isSafeInteger(record.maxConcurrent) || record.maxConcurrent <= 0) throw new PackageConfigError("PACKAGE_ENABLE_INVALID", "maxConcurrent must be a positive integer");
    if (record.zipSourceDirectory) await assertDirectory(record.zipSourceDirectory, "PACKAGE_ENABLE_INVALID", "zipSourceDirectory");
    const catalog = options.modelCatalog ?? (typeof getModelCatalog === "function" ? await getModelCatalog(record.workspacePath) : modelCatalog);
    validateModel(record, catalog);
    record.state = "enabled";
    record.revision += 1;
    record.updatedAt = now();
    currentValue.catalog[record.alias] = record;
    return (await writeCatalog(currentValue.catalog))[record.alias];
  }

  async function disable(alias, expectedRevision) {
    const currentValue = await current(alias);
    if (!currentValue.record) throw new PackageConfigError("PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`, undefined, 404);
    assertRevision(currentValue.record, expectedRevision);
    const record = { ...currentValue.record, state: "disabled", revision: currentValue.record.revision + 1, updatedAt: now() };
    currentValue.catalog[record.alias] = record;
    return (await writeCatalog(currentValue.catalog))[record.alias];
  }

  async function remove(alias, expectedRevision = undefined) {
    const currentValue = await current(alias);
    if (!currentValue.record) throw new PackageConfigError("PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`, undefined, 404);
    if (expectedRevision !== undefined) assertRevision(currentValue.record, expectedRevision);
    const references = await listReferences(currentValue.alias);
    if (Array.isArray(references) && references.length > 0) {
      throw new PackageConfigError("PACKAGE_IN_USE", `Package '${currentValue.alias}' is still referenced`, { references: clone(references) });
    }
    delete currentValue.catalog[currentValue.alias];
    await writeCatalog(currentValue.catalog);
    return clone(currentValue.record);
  }

  return {
    read: readCatalog,
    async list() { return Object.values(await readCatalog()).map(clone); },
    async get(alias) {
      const result = await current(alias);
      return result.record ? clone(result.record) : null;
    },
    saveDraft,
    enable,
    disable,
    remove,
    async references(alias) { return clone(await listReferences(packageAlias(alias))); },
    async snapshot(alias) {
      const result = await current(alias);
      if (!result.record) throw new PackageConfigError("PACKAGE_NOT_FOUND", `Package '${alias}' does not exist`, undefined, 404);
      return clone(result.record);
    },
    setInline(value) { inline = normalizeFeishuPackages(value, { now }); },
  };
}
