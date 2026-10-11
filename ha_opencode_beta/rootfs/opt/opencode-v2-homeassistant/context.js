import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";

export const CONTEXT_PLUGIN_ID = "homeassistant.context";
export const CONTEXT_MARKER = "<!-- ha-opencode-managed-context -->";
export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_CONTEXT_BYTES = 96 * 1024;
const OPTIONAL = new Set([
  "/data/context/home-briefing.md", "/data/context/decision-notes.md", "/homeassistant/AGENTS.local.md",
]);
const SOURCES = new Set([
  ...OPTIONAL,
  "/opt/opencode-v2-homeassistant/WORKSPACE.md",
  "/opt/ha-mcp-server/FOCUS_MODE.md",
  "/opt/ha-mcp-server/MCP_CORE_INSTRUCTIONS.md",
  "/opt/ha-mcp-server/MCP_NATIVE_INSTRUCTIONS.md",
  "/opt/ha-mcp-server/MCP_PROFILE_COMPACT.md",
  "/opt/ha-mcp-server/MCP_PROFILE_CONFIGURATION.md",
  "/opt/ha-mcp-server/MCP_PROFILE_FULL.md",
  "/opt/ha-mcp-server/USER_HOOKS.md",
]);

export async function readContextSource(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw new Error("Invalid context source");
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SOURCE_BYTES) throw new Error("Context source exceeds its size limit");
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT" && OPTIONAL.has(path)) return "";
    // File-system errors can contain data from outside this bounded allowlist.
    throw new Error(`Home Assistant context source unavailable: ${path}`);
  } finally {
    await file?.close();
  }
}

export function createContextSetup({ readSource = readContextSource } = {}) {
  return async (ctx) => {
    const files = ctx.options?.files;
    if (!Array.isArray(files) || files.some((path) => !SOURCES.has(path))) {
      throw new Error("Home Assistant context requires an allowlisted source list");
    }
    const selected = [...new Set(files)];
    const inject = async (event) => {
      const sections = [];
      for (const path of selected) {
        const text = await readSource(path);
        if (text) sections.push(`## ${path}\n\n${text}`);
      }
      const text = `${CONTEXT_MARKER}\n${sections.join("\n\n")}`;
      if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES) {
        throw new Error("Home Assistant context exceeds its total size limit");
      }
      // Model hooks receive a fresh request; replacing our own block also makes
      // reload/retry re-entry idempotent without modifying persisted history.
      event.system = event.system.filter((part) => !(part.type === "text" && part.text.startsWith(CONTEXT_MARKER)));
      event.system.push({ type: "text", text });
    };
    const registrations = [];
    try {
      for (const kind of ["context", "compaction", "generate"]) {
        registrations.push(await ctx.session.hook(kind, inject));
      }
    } catch (error) {
      await Promise.all(registrations.map((registration) => registration.dispose()));
      throw error;
    }
    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  };
}

export default Plugin.define({ id: CONTEXT_PLUGIN_ID, setup: createContextSetup() });
