import { constants } from "node:fs";
import { open, lstat, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_CONFIG_VERSION, resolveMcpConfiguration } from "./mcp-config.js";

export const MCP_STATE_FILE = ".native-mcp-state.json";
const NATIVE_KEYS = ["native_ha_mcp_enabled", "native_ha_mcp_selection", "native_ha_mcp_api_id"];
const MCP_KEYS = ["mcp_enabled", "mcp_tool_profile", ...NATIVE_KEYS];
const MAX_BYTES = 4 * 1024 * 1024;
const fail = (message) => { throw new Error(`Native MCP startup: ${message}`); };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const project = (options) => Object.fromEntries(MCP_KEYS.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
const fingerprint = (options) => createHash("sha256").update(JSON.stringify(project(options))).digest("hex");
const nativeOptions = (configuration) => ({
  native_ha_mcp_enabled: configuration.native.enabled,
  native_ha_mcp_selection: configuration.native.selection,
  native_ha_mcp_api_id: configuration.native.selection === "custom" ? configuration.native.apiId : "",
});
const targetMatches = (options, target) => NATIVE_KEYS.every((key) => Object.hasOwn(options, key) && options[key] === target[key]);

function validateState(state) {
  if (state === null) return;
  if (!object(state) || state.version !== MCP_CONFIG_VERSION || state.channel !== "beta"
    || !["pending", "complete"].includes(state.phase) || !["new", "legacy", "current"].includes(state.provenance)
    || Object.keys(state).some((key) => !["version", "channel", "phase", "provenance", "original", "target", "compatibility", "selectionMigration"].includes(key))) {
    fail("invalid migration journal; native activation withheld (restore the journal from backup or review saved native settings)");
  }
  if (state.target === null && state.phase === "pending" && state.original === null
    && state.compatibility === null && state.selectionMigration === null) return;
  if (!/^[0-9a-f]{64}$/.test(state.original ?? "") || !object(state.target)
    || Object.keys(state.target).length !== NATIVE_KEYS.length
    || NATIVE_KEYS.some((key) => !Object.hasOwn(state.target, key))
    || ![null, "assist_to_home_assistant"].includes(state.selectionMigration)) fail("invalid migration journal settings");
  // The journal may contain only the bounded native settings, never the rest of
  // Supervisor's options (which can contain credentials or !secret references).
  const checked = resolveMcpConfiguration({ options: state.target, provenance: "current", compatibility: state.compatibility });
  if (!isDeepStrictEqual(nativeOptions(checked), state.target)) fail("noncanonical migration journal settings");
}

/** Injected persistence allows faults at every boundary to be tested without HA. */
export async function prepareMcpStartup({
  provenance, readState, writeState, readOptions, saveOptions, syncLocalOptions,
  legacyOverrides = {},
}) {
  let state = await readState();
  validateState(state);
  if (!state) {
    // Written before network access and before startup creates any old-version
    // markers. A failed first boot must not turn a fresh install into legacy.
    state = { version: MCP_CONFIG_VERSION, channel: "beta", phase: "pending", provenance,
      original: null, target: null, compatibility: null, selectionMigration: null };
    validateState(state);
    await writeState(state);
  }
  const before = await readOptions();
  if (!object(before)) fail("Supervisor returned invalid options");
  let configuration;
  let selectionMigration = null;
  const completedState = state.phase === "complete" ? state : null;
  if (state.phase === "pending" && state.target) {
    if (targetMatches(before, state.target)) {
      // POST may have succeeded before its response or the journal save was lost.
      configuration = resolveMcpConfiguration({ options: before, provenance: "current", compatibility: state.compatibility });
    } else {
      if (fingerprint(before) !== state.original) fail("native settings changed during interrupted migration; no settings overwritten");
      configuration = resolveMcpConfiguration({ options: { ...before, ...state.target }, provenance: "current", compatibility: state.compatibility });
    }
    selectionMigration = state.selectionMigration;
  } else {
    configuration = resolveMcpConfiguration({ options: before,
      provenance: state.phase === "complete" ? "current" : state.provenance,
      compatibility: state.phase === "complete" ? state.compatibility : null,
      // Native tool selection becomes authoritative once migrated. Old endpoint
      // env overrides are consumed once, not reapplied after every restart.
      overrides: state.phase === "pending" && state.provenance === "legacy" ? legacyOverrides : {},
    });
    selectionMigration = configuration.selectionMigration;
    state = { version: MCP_CONFIG_VERSION, channel: "beta", phase: "pending", provenance: state.provenance,
      original: fingerprint(before), target: nativeOptions(configuration),
      compatibility: configuration.compatibility, selectionMigration };
    if (completedState && isDeepStrictEqual(completedState.target, state.target)
      && isDeepStrictEqual(completedState.compatibility, state.compatibility)) state = completedState;
    else await writeState(state);
  }
  const desired = { ...before, ...state.target };
  // No compare-and-swap API exists. Check immediately before a replacement write
  // and verify afterward; detect observable edits without claiming atomicity.
  const latest = await readOptions();
  if (!isDeepStrictEqual(before, latest)) fail("options changed before save; restart to retry without overwriting the edit");
  let after = latest;
  if (!isDeepStrictEqual(latest, desired)) {
    try { await saveOptions(desired); } catch { /* readback decides whether a lost-response save succeeded */ }
    after = await readOptions();
    if (!isDeepStrictEqual(after, desired)) fail("Supervisor save/readback failed or options changed; native activation withheld");
  }
  // /data/options.json is generated at container start, not refreshed by the
  // options API. Patch ONLY native keys in that file; retain resolved local
  // secret values and never replace them with Supervisor's !secret references.
  await syncLocalOptions(state.target);
  const finalOptions = await readOptions();
  if (!isDeepStrictEqual(after, finalOptions)) fail("options changed after save; native activation withheld until restart");
  const checked = resolveMcpConfiguration({ options: finalOptions, provenance: "current", compatibility: state.compatibility });
  const complete = { ...state, phase: "complete", compatibility: checked.compatibility, selectionMigration: null };
  if (!isDeepStrictEqual(state, complete)) await writeState(complete);
  const settings = { options: project(finalOptions), provenance: "current", compatibility: checked.compatibility };
  return { settings, configuration: { ...checked, selectionMigration } };
}

function safeMetadata(metadata, directory = false, privateFile = false) {
  return (directory ? metadata.isDirectory() : metadata.isFile()) && !metadata.isSymbolicLink()
    && (directory || metadata.nlink === 1)
    && (process.platform === "win32" || (metadata.uid === 0 && (metadata.mode & (privateFile ? 0o077 : 0o022)) === 0));
}

export async function readStartupJson(path, { optional = false, privateFile = false } = {}) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await file.stat();
    const linkMetadata = await lstat(path);
    if (!safeMetadata(metadata, false, privateFile) || linkMetadata.isSymbolicLink()
      || metadata.size > MAX_BYTES || metadata.ino !== linkMetadata.ino) fail("unsafe or oversized configuration file");
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) fail("configuration file grew beyond its limit");
    return JSON.parse(text);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    // File paths/contents and JSON parse errors can expose user secrets.
    fail("cannot safely read configuration/journal JSON");
  } finally { await file?.close(); }
}

export async function writeStartupJson(path, value) {
  if (!safeMetadata(await lstat(dirname(path)), true)) fail("unsafe configuration directory");
  try {
    if (!safeMetadata(await lstat(path))) fail("unsafe existing configuration file");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.native-mcp-write-${randomUUID()}`);
  let file;
  try {
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function detectMcpProvenance(dataRoot) {
  if (!safeMetadata(await lstat(dataRoot), true)) fail("unsafe add-on data directory");
  // Only a genuinely empty app-data directory (apart from Supervisor options)
  // establishes fresh provenance. Old channel/version markers are read before
  // init rewrites them. Unknown user data conservatively means legacy.
  const names = await readdir(dataRoot);
  return names.every((name) => name === "options.json") ? "new" : "legacy";
}

export function createSupervisorOptionsApi({ token, fetchImpl = fetch } = {}) {
  const request = async (path, body) => {
    if (!token) fail("Supervisor credentials unavailable");
    try {
      const response = await fetchImpl(`http://supervisor/addons/self/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) fail("Supervisor options request rejected");
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BYTES) fail("Supervisor response exceeds limit");
      const envelope = JSON.parse(text);
      if (envelope.result !== "ok") fail("Supervisor options request failed");
      return envelope.data;
    } catch { fail("Supervisor options API unavailable or rejected the request"); }
  };
  return {
    readOptions: async () => { const data = await request("info"); if (!object(data?.options)) fail("invalid Supervisor options response"); return data.options; },
    saveOptions: async (options) => { await request("options", { options }); },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) fail("expected data directory and runtime-output path");
    const dataRoot = resolve(process.argv[2]);
    const output = resolve(process.argv[3]);
    const stateFile = join(dataRoot, MCP_STATE_FILE);
    const localOptionsFile = join(dataRoot, "options.json");
    const initialLocalOptions = await readStartupJson(localOptionsFile);
    const provenance = await detectMcpProvenance(dataRoot);
    const api = createSupervisorOptionsApi({ token: process.env.SUPERVISOR_TOKEN });
    const result = await prepareMcpStartup({ provenance, ...api,
      readState: () => readStartupJson(stateFile, { optional: true, privateFile: true }),
      writeState: (value) => writeStartupJson(stateFile, value),
      legacyOverrides: Object.fromEntries(["HA_NATIVE_MCP_API_ID", "HA_NATIVE_MCP_ENDPOINT_MODE"]
        .filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]])),
      syncLocalOptions: async (patch) => {
        const current = await readStartupJson(localOptionsFile);
        if (!isDeepStrictEqual(current, initialLocalOptions)) fail("local options changed; restart to retry");
        await writeStartupJson(localOptionsFile, { ...current, ...patch });
      },
    });
    await writeStartupJson(output, result);
  } catch {
    // Deliberately no underlying exceptions (Supervisor errors may echo options).
    process.stderr.write("Native MCP startup migration was not verified; native stays off for this boot. Check Supervisor access and saved native settings, then restart; the private journal preserves interrupted work.\n");
    process.exitCode = 1;
  }
}
