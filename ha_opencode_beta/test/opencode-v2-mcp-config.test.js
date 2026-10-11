import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createNativeMcpForwarder } from "../rootfs/opt/ha-mcp-server/lib/ha-native-mcp.js";
import { resolveMcpConfiguration } from "../rootfs/opt/opencode-v2-homeassistant/mcp-config.js";
import { buildManagedConfig, DEFAULT_PLUGIN_PACKAGE, READ_ONLY_AGENT_ID, buildReadOnlyPermissions } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";
import { createSetup } from "../rootfs/opt/opencode-v2-homeassistant/plugin.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/mcp-saved-options.json", import.meta.url), "utf8"));
const current = (selection = "home_assistant", id = "") => ({
  native_ha_mcp_enabled: true, native_ha_mcp_selection: selection, native_ha_mcp_api_id: id,
});

describe("Home Assistant MCP configuration contract", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const before = structuredClone(fixture);
      const result = resolveMcpConfiguration(fixture);
      assert.deepEqual(result.bundled, {
        enabled: fixture.expected.bundled, profile: fixture.options.mcp_tool_profile ?? "full",
      });
      assert.deepEqual(result.native, {
        enabled: fixture.expected.native, selection: fixture.expected.selection,
        apiId: fixture.expected.apiId, endpointMode: fixture.expected.mode,
      });
      assert.equal(result.hab.available, fixture.expected.hab);
      assert.equal(result.sidecarRequired, fixture.expected.bundled || fixture.expected.native);
      assert.equal(result.selectionMigration, fixture.expected.selectionMigration ?? null);
      assert.deepEqual(fixture, before, "resolution must not modify saved options or overrides");
      const restarted = resolveMcpConfiguration({
        options: { ...fixture.options, ...result.optionPatch }, provenance: "current",
        compatibility: result.compatibility,
      });
      assert.deepEqual(restarted.optionPatch, {}, "migration must converge without repeated option writes");
      assert.deepEqual(restarted.native, result.native);
      assert.deepEqual(restarted.compatibility, result.compatibility);
      assert.equal(restarted.selectionMigration, null, "migration must be reported only once");
    });

    it(`registers exactly the resolved connections for ${fixture.name}`, async () => {
      const config = buildManagedConfig({ mcpSettings: fixture });
      const plugin = config.plugins.find(({ package: name }) => name === DEFAULT_PLUGIN_PACKAGE);
      const registered = new Map();
      let reads = 0;
      if (plugin) {
        const cleanup = await createSetup({ readSecret: async () => { reads++; return "a".repeat(64); } })({
          options: plugin.options,
          mcp: { async transform(callback) { callback(registered); return { async dispose() {} }; } },
        });
        await cleanup();
      }
      assert.deepEqual([...registered.keys()], [
        ...(fixture.expected.bundled ? ["homeassistant"] : []),
        ...(fixture.expected.native ? ["homeassistant_native"] : []),
      ]);
      assert.equal(reads, fixture.expected.bundled || fixture.expected.native ? 1 : 0);
      assert.deepEqual(config.agents[READ_ONLY_AGENT_ID].permissions, buildReadOnlyPermissions());
      assert.doesNotMatch(JSON.stringify(config), /Bearer |SUPERVISOR_TOKEN/);
    });
  }

  it("never infers a fresh installation from absent settings", () => {
    for (const provenance of [undefined, null, "", "unknown"]) {
      assert.throws(() => resolveMcpConfiguration({ options: {}, provenance }), /explicit.*provenance/);
    }
    assert.equal(resolveMcpConfiguration({ provenance: "new" }).native.enabled, true);
    assert.equal(resolveMcpConfiguration({ provenance: "legacy" }).native.enabled, false);
  });

  it("requires complete persisted native settings on current installations", () => {
    for (const key of Object.keys(current())) {
      const options = current();
      delete options[key];
      assert.throws(() => resolveMcpConfiguration({ provenance: "current", options }), /complete persisted/);
    }
  });

  it("rejects inconsistent provenance instead of remigrating explicit choices", () => {
    assert.throws(() => resolveMcpConfiguration({ provenance: "legacy", options: current() }), /provenance conflicts/);
  });

  for (const selection of ["home_assistant", "assist", "custom"]) {
    it(`resolves explicit ${selection} without implicit fallback`, () => {
      const result = resolveMcpConfiguration({ provenance: "new", options: current(selection, "custom-api") });
      assert.equal(result.native.endpointMode, selection === "home_assistant" ? "configured" : "keyed");
      assert.equal(result.native.apiId, selection === "home_assistant" ? null : selection === "assist" ? "assist" : "custom-api");
      assert.equal(result.compatibility, null);
    });
  }

  it("ignores unused custom ID content without copying it into the resolved configuration", () => {
    const result = resolveMcpConfiguration({ provenance: "current", options: current("assist", "https://user:secret@example.test/") });
    assert.equal(result.native.apiId, "assist");
    assert.equal(result.optionPatch.native_ha_mcp_api_id, "");
    assert.doesNotMatch(JSON.stringify(result), /user:secret/);
  });

  for (const id of ["", "  ", "https://example.test/api/mcp", "custom/api", "custom\\api", "a?secret", "a#fragment", "{env:SECRET}", "a\nb", "x".repeat(257)]) {
    it(`rejects invalid specific API input ${JSON.stringify(id).slice(0, 55)}`, () => {
      assert.throws(() => resolveMcpConfiguration({ provenance: "current", options: current("custom", id) }), /requires an API ID/);
    });
  }

  it("normalizes surrounding whitespace on actual API IDs", () => {
    const result = resolveMcpConfiguration({ provenance: "legacy", options: { native_ha_mcp_api_id: " custom.api:1 " } });
    assert.equal(result.native.apiId, "custom.api:1");
    assert.equal(result.optionPatch.native_ha_mcp_api_id, "custom.api:1");
  });

  it("projects only MCP settings into migration patches and results", () => {
    const options = { ...current(), access_token: "secret-marker", ppq_api_key: "secret-marker", env_vars: ["SECRET=secret-marker"] };
    const result = resolveMcpConfiguration({ provenance: "current", options });
    assert.deepEqual(result.optionPatch, {});
    assert.doesNotMatch(JSON.stringify(result), /secret-marker|access_token|ppq_api_key|env_vars/);
    assert.equal(options.access_token, "secret-marker");
  });

  it("preserves legacy environment selection while rejecting new conflicts", () => {
    const result = resolveMcpConfiguration({
      provenance: "legacy", options: { native_ha_mcp_enabled: true },
      overrides: { HA_NATIVE_MCP_API_ID: "custom-api" },
    });
    assert.equal(result.native.apiId, "custom-api");
    assert.equal(result.optionPatch.native_ha_mcp_api_id, "custom-api");
    assert.throws(() => resolveMcpConfiguration({
      provenance: "current", options: current("assist"), overrides: { HA_NATIVE_MCP_API_ID: "custom-api" },
    }), /conflicts with the selected API/);
  });

  for (const [selection, id, mode] of [["home_assistant", "", "configured"], ["assist", "", "keyed"], ["custom", "custom-api", "keyed"]]) {
    it(`accepts matching overrides for ${selection}`, () => {
      const result = resolveMcpConfiguration({
        provenance: "current", options: current(selection, id),
        overrides: { HA_NATIVE_MCP_API_ID: selection === "assist" ? "assist" : id, HA_NATIVE_MCP_ENDPOINT_MODE: mode },
      });
      assert.equal(result.native.endpointMode, mode);
    });
  }

  it("does not allow overrides to introduce fallback or broaden a newly selected API", () => {
    for (const mode of ["auto", "configured"]) {
      assert.throws(() => resolveMcpConfiguration({
        provenance: "new", options: current("assist"), overrides: { HA_NATIVE_MCP_ENDPOINT_MODE: mode },
      }), /conflicts with the resolved selection/);
    }
  });

  it("retires compatibility after a selection change and does not revive it on return", () => {
    const legacy = resolveMcpConfiguration({ provenance: "legacy", options: { native_ha_mcp_enabled: true, native_ha_mcp_api_id: "old-custom-api" } });
    assert.ok(legacy.compatibility, "unchanged custom APIs retain their existing legacy fallback policy");
    const changed = resolveMcpConfiguration({ provenance: "current", options: current("custom", "custom-api"), compatibility: legacy.compatibility });
    assert.equal(changed.compatibility, null);
    const returned = resolveMcpConfiguration({ provenance: "current", options: current("custom", "old-custom-api"), compatibility: changed.compatibility });
    assert.equal(returned.native.endpointMode, "keyed");
    assert.equal(returned.compatibility, null);
  });

  it("rejects malformed compatibility records without echoing values", () => {
    for (const compatibility of [[], {}, { version: 99 }, {
      version: 1, selection: "custom", apiId: "secret-marker", endpointMode: "auto", token: "secret-marker",
    }, { version: 1, selection: "assist", apiId: "custom-api", endpointMode: "auto" }]) {
      assert.throws(() => resolveMcpConfiguration({ provenance: "current", options: current(), compatibility }), (error) => {
        assert.doesNotMatch(error.message, /secret-marker/);
        return error instanceof TypeError;
      });
    }
  });

  it("checks compatibility provenance before applying a record", () => {
    const compatibility = resolveMcpConfiguration({ provenance: "legacy", options: { native_ha_mcp_api_id: "custom-api" } }).compatibility;
    assert.throws(() => resolveMcpConfiguration({ provenance: "new", compatibility }), /records require current/);
  });

  for (const [label, input] of [
    ["options array", { options: [] }], ["overrides array", { overrides: [] }],
    ["boolean string", { options: { native_ha_mcp_enabled: "true" } }],
    ["null boolean", { options: { mcp_enabled: null } }],
    ["unknown profile", { options: { mcp_tool_profile: "secret-marker" } }],
    ["null profile", { options: { mcp_tool_profile: null } }],
    ["unknown selection", { options: { native_ha_mcp_selection: "secret-marker" } }],
    ["null API ID", { options: { native_ha_mcp_api_id: null } }],
    ["unknown override", { overrides: { SECRET: "secret-marker" } }],
    ["invalid mode", { overrides: { HA_NATIVE_MCP_ENDPOINT_MODE: "secret-marker" } }],
  ]) {
    it(`rejects ${label} with a secret-free error`, () => {
      assert.throws(() => resolveMcpConfiguration({ provenance: "new", ...input }), (error) => {
        assert.doesNotMatch(error.message, /secret-marker/);
        return error instanceof TypeError;
      });
    });
  }

  for (const provenance of ["new", "legacy", "current"]) {
    it(`passes the resolved ${provenance} endpoint to the existing forwarder`, async () => {
      const config = resolveMcpConfiguration({ provenance, options: provenance === "current" ? current("assist") : { native_ha_mcp_enabled: true } });
      const paths = [];
      const forwarder = createNativeMcpForwarder({
        supervisorToken: "synthetic-fixture-token", apiId: config.native.apiId,
        endpointMode: config.native.endpointMode,
        fetchImpl: async (url) => { paths.push(new URL(url).pathname); return new Response("Not Found", { status: 404 }); },
      });
      await forwarder.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
      assert.deepEqual(paths, provenance === "current" ? ["/core/api/mcp/assist"] : ["/core/api/mcp"]);
    });
  }

  it("preserves a deliberate Assist selection after one-time migration", () => {
    const options = { native_ha_mcp_enabled: true };
    const migrated = resolveMcpConfiguration({ provenance: "legacy", options });
    const selectedAssist = resolveMcpConfiguration({
      provenance: "current", options: { ...options, ...migrated.optionPatch, native_ha_mcp_selection: "assist" },
      compatibility: migrated.compatibility,
    });
    assert.deepEqual(selectedAssist.native, { enabled: true, selection: "assist", apiId: "assist", endpointMode: "keyed" });
    assert.equal(selectedAssist.selectionMigration, null);
    assert.equal(selectedAssist.compatibility, null);
  });

  it("never migrates invalid custom IDs to a broader configured endpoint", () => {
    assert.throws(() => resolveMcpConfiguration({
      provenance: "legacy", options: { native_ha_mcp_api_id: "https://custom.test/mcp" },
    }), /requires an API ID/);
  });

  it("preserves custom endpoint/fallback behavior across restart", async () => {
    const options = { native_ha_mcp_enabled: true, native_ha_mcp_api_id: "custom-api" };
    const initial = resolveMcpConfiguration({ provenance: "legacy", options });
    const restarted = resolveMcpConfiguration({ provenance: "current", options: { ...options, ...initial.optionPatch }, compatibility: initial.compatibility });
    const paths = [];
    const forwarder = createNativeMcpForwarder({
      supervisorToken: "synthetic-fixture-token", apiId: restarted.native.apiId, endpointMode: restarted.native.endpointMode,
      fetchImpl: async (url) => { paths.push(new URL(url).pathname); return new Response("Not Found", { status: 404 }); },
    });
    await forwarder.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.deepEqual(paths, ["/core/api/mcp/custom-api", "/core/api/mcp"], "retain only pre-existing custom fallback, not a new selection migration");
    assert.equal(restarted.selectionMigration, null);
  });
});
