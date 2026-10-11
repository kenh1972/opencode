import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextSetup, CONTEXT_MARKER } from "../rootfs/opt/opencode-v2-homeassistant/context.js";
import { buildManagedConfig, DEFAULT_CONTEXT_PACKAGE } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

test("context reaches initial and continuation requests with MCP disabled, updates, and never accumulates", async () => {
  const config = buildManagedConfig({ pluginEnabled: false });
  const options = config.plugins.find((plugin) => plugin.package === DEFAULT_CONTEXT_PACKAGE).options;
  const hooks = new Map();
  const disposed = [];
  let briefing = "fixture-home-context";
  const dispose = await createContextSetup({
    readSource: async (path) => path.endsWith("home-briefing.md") ? briefing : "",
  })({ options, session: { async hook(name, fn) {
    hooks.set(name, fn);
    return { async dispose() { disposed.push(name); } };
  } } });
  const event = { agent: "build", system: [{ type: "text", text: "upstream-provider-identity" }], messages: [] };
  await hooks.get("context")(event);
  assert.match(event.system[1].text, /fixture-home-context/);
  briefing = "updated-after-tool-call";
  await hooks.get("context")(event);
  assert.equal(event.system.length, 2);
  assert.match(event.system[1].text, /updated-after-tool-call/);
  assert.doesNotMatch(event.system[1].text, /fixture-home-context/);
  assert.equal(event.system[0].text, "upstream-provider-identity");
  assert.deepEqual(event.messages, []);
  for (const kind of ["compaction", "generate"]) {
    await hooks.get(kind)(event);
    assert.equal(event.system.filter((part) => part.text.startsWith(CONTEXT_MARKER)).length, 1);
  }
  await dispose();
  assert.deepEqual(disposed.sort(), ["compaction", "context", "generate"]);
});

test("context rejects arbitrary files before reading them", async () => {
  let read = false;
  await assert.rejects(createContextSetup({ readSource: async () => { read = true; } })({
    options: { files: ["/data/options.json"] },
  }), /allowlisted/);
  assert.equal(read, false);
});

test("native-only configuration loads its bounded instructions without requiring bundled capabilities", async () => {
  const config = buildManagedConfig({ nativeMcpEnabled: true });
  const options = config.plugins.find((plugin) => plugin.package === DEFAULT_CONTEXT_PACKAGE).options;
  const hooks = new Map();
  const dispose = await createContextSetup({
    readSource: async (path) => path.endsWith("MCP_NATIVE_INSTRUCTIONS.md") ? "fixture-native-routing" : "",
  })({ options, session: { async hook(kind, fn) { hooks.set(kind, fn); return { async dispose() {} }; } } });
  const event = { system: [], messages: [] };
  await hooks.get("context")(event);
  assert.match(event.system[0].text, /fixture-native-routing/);
  await dispose();
});
