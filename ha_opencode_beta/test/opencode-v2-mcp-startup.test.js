import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, writeFile, symlink, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareMcpStartup, detectMcpProvenance, readStartupJson, writeStartupJson, createSupervisorOptionsApi } from "../rootfs/opt/opencode-v2-homeassistant/mcp-startup.js";
import { buildManagedConfig, DEFAULT_PLUGIN_PACKAGE } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/mcp-saved-options.json", import.meta.url), "utf8"));
const rootFilesUnavailable = process.platform !== "win32" && process.getuid?.() !== 0;
function fixture(options = {}, provenance = "legacy", legacyOverrides = {}) {
  const memory = { options: structuredClone(options), state: null, writes: 0, journals: 0, local: { ...options, access_token: "synthetic-resolved-local-secret" } };
  memory.dependencies = {
    provenance, legacyOverrides,
    readState: async () => structuredClone(memory.state),
    writeState: async (state) => { memory.state = structuredClone(state); memory.journals++; },
    readOptions: async () => structuredClone(memory.options),
    saveOptions: async (value) => { memory.options = structuredClone(value); memory.writes++; },
    syncLocalOptions: async (patch) => { memory.local = { ...memory.local, ...patch }; },
  };
  return memory;
}

describe("native MCP startup persistence and recovery", () => {
  for (const saved of fixtures) {
    it(`persists and activates ${saved.name}`, async () => {
      const memory = fixture({ ...saved.options, ppq_api_key: "!secret ppq_key" }, saved.provenance, saved.overrides);
      const result = await prepareMcpStartup(memory.dependencies);
      assert.equal(result.configuration.native.enabled, saved.expected.native);
      assert.equal(result.configuration.native.selection, saved.expected.selection);
      assert.equal(result.configuration.native.endpointMode, saved.expected.mode);
      assert.equal(memory.options.ppq_api_key, "!secret ppq_key", "preserve unrelated and secret-reference options");
      assert.equal(memory.local.access_token, "synthetic-resolved-local-secret", "do not write raw Supervisor secret references over resolved local values");
      assert.equal(memory.state.phase, "complete");
      assert.doesNotMatch(JSON.stringify(memory.state), /ppq|secret|access_token/);
      assert.doesNotMatch(JSON.stringify(result), /ppq|secret|access_token/);
      const writes = memory.writes, journals = memory.journals;
      const restarted = await prepareMcpStartup({ ...memory.dependencies, provenance: "legacy" });
      assert.equal(memory.writes, writes, "no repeated Supervisor writes");
      assert.equal(memory.journals, journals, "no repeated journal writes");
      assert.deepEqual(restarted.configuration.native, result.configuration.native);
      assert.equal(restarted.configuration.selectionMigration, null);
      const config = buildManagedConfig({ mcpSettings: restarted.settings });
      const plugin = config.plugins.find(({ package: name }) => name === DEFAULT_PLUGIN_PACKAGE);
      assert.equal(plugin?.options.nativeEnabled ?? false, saved.expected.native);
      assert.equal(plugin?.options.bundledEnabled ?? false, saved.expected.bundled);
    });
  }

  it("journals fresh provenance before an API outage and retains it after version markers are created", async () => {
    const memory = fixture({}, "new");
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, readOptions: async () => { throw new Error("offline"); } }));
    assert.equal(memory.state.provenance, "new");
    assert.equal(memory.state.phase, "pending");
    assert.equal(memory.writes, 0);
    const restarted = await prepareMcpStartup({ ...memory.dependencies, provenance: "legacy" });
    assert.equal(restarted.configuration.native.enabled, true);
    assert.equal(restarted.configuration.native.selection, "home_assistant");
  });

  it("recovers a saved options update after a lost POST response without replay", async () => {
    const memory = fixture({ native_ha_mcp_enabled: true, native_ha_mcp_api_id: "assist" });
    const result = await prepareMcpStartup({ ...memory.dependencies, saveOptions: async (options) => {
      await memory.dependencies.saveOptions(options); throw new Error("response lost");
    } });
    assert.equal(result.configuration.native.selection, "home_assistant");
    assert.equal(memory.writes, 1);
    assert.equal(memory.state.phase, "complete");
  });

  it("recovers interruption after options save but before local synchronization", async () => {
    const memory = fixture({ native_ha_mcp_enabled: true, native_ha_mcp_api_id: "custom-api" });
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, syncLocalOptions: async () => { throw new Error("interrupted"); } }));
    assert.equal(memory.state.phase, "pending");
    assert.equal(memory.writes, 1);
    const resumed = await prepareMcpStartup(memory.dependencies);
    assert.equal(memory.writes, 1);
    assert.equal(resumed.configuration.native.apiId, "custom-api");
    assert.equal(resumed.configuration.native.endpointMode, "auto");
  });

  it("withholds activation on failed save/readback and can retry preserved work", async () => {
    const memory = fixture({}, "new");
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, saveOptions: async () => { throw new Error("rejected"); } }), /save\/readback failed/);
    assert.equal(memory.state.phase, "pending");
    assert.deepEqual(memory.options, {});
    assert.equal((await prepareMcpStartup(memory.dependencies)).configuration.native.enabled, true);
  });

  it("rejects observable concurrent unrelated edits before save without overwriting them", async () => {
    const memory = fixture({ unrelated: "before" }, "new");
    let reads = 0;
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, readOptions: async () => {
      if (++reads === 2) memory.options.unrelated = "edited";
      return structuredClone(memory.options);
    } }), /changed before save/);
    assert.equal(memory.writes, 0);
    assert.equal(memory.options.unrelated, "edited");
    await prepareMcpStartup(memory.dependencies);
    assert.equal(memory.options.unrelated, "edited");
  });

  it("does not overwrite native edits made during interrupted migration", async () => {
    const memory = fixture({ native_ha_mcp_api_id: "assist" });
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, saveOptions: async () => {} }), /save\/readback failed/);
    memory.options.native_ha_mcp_api_id = "chosen-custom";
    await assert.rejects(prepareMcpStartup(memory.dependencies), /native settings changed/);
    assert.equal(memory.options.native_ha_mcp_api_id, "chosen-custom");
    assert.equal(memory.writes, 0);
  });

  it("detects an edit after POST rather than activating inconsistent settings", async () => {
    const memory = fixture({}, "new");
    await assert.rejects(prepareMcpStartup({ ...memory.dependencies, saveOptions: async (options) => {
      await memory.dependencies.saveOptions(options); memory.options.unrelated = "concurrent";
    } }), /save\/readback failed/);
    assert.equal(memory.state.phase, "pending");
  });

  it("retains explicit Assist opt-back and retires custom fallback durably", async () => {
    const memory = fixture({ native_ha_mcp_enabled: true, native_ha_mcp_api_id: "custom-api" });
    await prepareMcpStartup(memory.dependencies);
    assert.equal(memory.state.compatibility.endpointMode, "auto");
    memory.options.native_ha_mcp_selection = "assist";
    memory.options.native_ha_mcp_api_id = "";
    const changed = await prepareMcpStartup(memory.dependencies);
    assert.equal(changed.configuration.native.endpointMode, "keyed");
    assert.equal(memory.state.compatibility, null);
    assert.equal(changed.configuration.selectionMigration, null);
    assert.equal((await prepareMcpStartup(memory.dependencies)).configuration.native.selection, "assist");
  });

  it("does not let stale endpoint overrides undo a migrated selection", async () => {
    const memory = fixture({ native_ha_mcp_enabled: true, native_ha_mcp_api_id: "assist" }, "legacy", { HA_NATIVE_MCP_ENDPOINT_MODE: "keyed" });
    await prepareMcpStartup(memory.dependencies);
    const restarted = await prepareMcpStartup(memory.dependencies);
    assert.equal(restarted.configuration.native.endpointMode, "configured");
    assert.equal(restarted.configuration.native.apiId, null);
  });

  it("rejects invalid/future/cross-channel journal data without a write", async () => {
    for (const state of [{}, { version: 99 }, { version: 1, channel: "stable", phase: "pending", provenance: "new" }, { secret: "synthetic-secret-marker" }]) {
      const memory = fixture({}, "new"); memory.state = state;
      await assert.rejects(prepareMcpStartup(memory.dependencies), (error) => {
        assert.doesNotMatch(error.message, /synthetic-secret-marker/); return /journal/.test(error.message);
      });
      assert.equal(memory.writes, 0);
      assert.equal(memory.journals, 0);
    }
  });
});

describe("native MCP startup file and API boundary", () => {
  it("runs the actual startup CLI through fresh, upgrade and explicit opt-back restarts", { skip: rootFilesUnavailable }, async () => {
    const parent = join(tmpdir(), "opencode"); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "mcp-startup-cli-"));
    try {
      const mock = join(root, "supervisor.mjs"), remote = join(root, "supervisor.json");
      // Image fixtures reach /opt through a temporary rootfs symlink. Invoke the
      // actual file so the production CLI entrypoint guard executes, not merely
      // imports the module and exits successfully without doing migration work.
      const startupCli = await realpath(fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/mcp-startup.js", import.meta.url)));
      await writeFile(mock, `
        import { readFileSync, writeFileSync } from "node:fs";
        globalThis.fetch = async (url, init) => {
          if (init.headers.Authorization !== "Bearer fixture-supervisor") throw new Error("unexpected credential");
          const file = process.env.FIXTURE_OPTIONS;
          if (url === "http://supervisor/addons/self/options" && init.method === "POST")
            writeFileSync(file, JSON.stringify(JSON.parse(init.body).options));
          else if (url !== "http://supervisor/addons/self/info") throw new Error("unexpected API");
          return new Response(JSON.stringify({result:"ok",data:{options:JSON.parse(readFileSync(file,"utf8"))}}));
        };
      `);
      for (const legacy of [false, true]) {
        const data = join(root, legacy ? "legacy" : "fresh"); await mkdir(data);
        const options = { mcp_enabled: true, ppq_api_key: "!secret fixture_key",
          ...(legacy ? { native_ha_mcp_enabled: true, native_ha_mcp_api_id: "assist" } : {}) };
        await writeFile(remote, JSON.stringify(options));
        await writeFile(join(data, "options.json"), JSON.stringify({ ...options, ppq_api_key: "fixture-resolved-key" }));
        if (legacy) await writeFile(join(data, ".addon_version"), "3.2.2b0");
        const output = join(root, "runtime.json");
        const run = () => {
          const child = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href,
            startupCli, data, output], {
            encoding: "utf8", timeout: 10000,
            env: { ...process.env, SUPERVISOR_TOKEN: "fixture-supervisor", FIXTURE_OPTIONS: remote },
          });
          assert.equal(child.status, 0, child.stderr);
          assert.doesNotMatch(child.stdout + child.stderr, /fixture-supervisor|fixture-resolved-key/);
        };
        run();
        let result = JSON.parse(await readFile(output, "utf8"));
        assert.equal(result.configuration.native.enabled, true);
        assert.equal(result.configuration.native.endpointMode, "configured");
        assert.equal(result.configuration.selectionMigration, legacy ? "assist_to_home_assistant" : null);
        assert.equal(JSON.parse(await readFile(join(data, "options.json"), "utf8")).ppq_api_key, "fixture-resolved-key");
        const saved = JSON.parse(await readFile(remote, "utf8"));
        assert.equal(saved.ppq_api_key, "!secret fixture_key");
        run();
        assert.equal(JSON.parse(await readFile(output, "utf8")).configuration.selectionMigration, null);
        await writeFile(remote, JSON.stringify({ ...saved, mcp_enabled: false, native_ha_mcp_selection: "assist" }));
        // Supervisor regenerates local options on a real container restart.
        await writeFile(join(data, "options.json"), JSON.stringify({ ...saved, mcp_enabled: false, native_ha_mcp_selection: "assist", ppq_api_key: "fixture-resolved-key" }));
        run();
        result = JSON.parse(await readFile(output, "utf8"));
        assert.equal(result.configuration.bundled.enabled, false);
        assert.equal(result.configuration.native.enabled, true);
        assert.equal(result.configuration.native.selection, "assist");
        assert.equal(result.configuration.native.endpointMode, "keyed");
        assert.equal(result.configuration.selectionMigration, null);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes genuinely new data from old markers and unknown user data before initialization", { skip: rootFilesUnavailable }, async () => {
    const parent = join(tmpdir(), "opencode"); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "mcp-provenance-"));
    try {
      await writeFile(join(root, "options.json"), "{}");
      assert.equal(await detectMcpProvenance(root), "new");
      await writeFile(join(root, ".addon_version"), "3.2.2b0");
      assert.equal(await detectMcpProvenance(root), "legacy");
      await rm(join(root, ".addon_version")); await mkdir(join(root, "unknown-user-work"));
      assert.equal(await detectMcpProvenance(root), "legacy");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes private JSON atomically, validates reads, and leaves the source on invalid input", { skip: rootFilesUnavailable }, async () => {
    const parent = join(tmpdir(), "opencode"); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "mcp-journal-"));
    try {
      const file = join(root, "record.json");
      await writeStartupJson(file, { version: 1 });
      assert.deepEqual(await readStartupJson(file, { privateFile: true }), { version: 1 });
      await writeStartupJson(file, { version: 2 });
      assert.deepEqual(await readStartupJson(file, { privateFile: true }), { version: 2 });
      await writeFile(file, '{"synthetic-secret-marker":');
      await assert.rejects(readStartupJson(file), (error) => { assert.doesNotMatch(error.message, /synthetic-secret-marker/); return true; });
      assert.match(await readFile(file, "utf8"), /synthetic-secret-marker/);
      assert.equal(await readStartupJson(join(root, "missing"), { optional: true }), null);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses linked or writable journals on Linux", { skip: process.platform === "win32" || rootFilesUnavailable }, async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-links-"));
    try {
      const file = join(root, "record.json"), link = join(root, "linked.json");
      await writeStartupJson(file, {}); await symlink(file, link);
      await assert.rejects(readStartupJson(link));
      await assert.rejects(writeStartupJson(link, {}));
      await chmod(file, 0o666);
      await assert.rejects(readStartupJson(file));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses Supervisor self/options, preserves secret refs in the payload and never echoes errors", async () => {
    const calls = [];
    const api = createSupervisorOptionsApi({ token: "synthetic-supervisor-token", fetchImpl: async (url, input) => {
      calls.push({ url, input });
      return new Response(JSON.stringify({ result: "ok", data: { options: { ppq_api_key: "!secret ppq_key" } } }));
    } });
    const options = await api.readOptions(); await api.saveOptions({ ...options, native_ha_mcp_enabled: true });
    assert.equal(calls[0].url, "http://supervisor/addons/self/info");
    assert.equal(calls[1].url, "http://supervisor/addons/self/options");
    assert.equal(calls[1].input.method, "POST");
    assert.equal(calls[1].input.redirect, "error");
    assert.equal(JSON.parse(calls[1].input.body).options.ppq_api_key, "!secret ppq_key");
    const failed = createSupervisorOptionsApi({ token: "synthetic-secret-marker", fetchImpl: async () => new Response("synthetic-secret-marker", { status: 403 }) });
    await assert.rejects(failed.readOptions(), (error) => { assert.doesNotMatch(error.message, /synthetic-secret-marker/); return true; });
  });
});
