import assert from "node:assert/strict";
import { describe, it } from "node:test";
import plugin, {
  CALLER_SECRET_LIBRARY,
  MCP_SERVER_NAME,
  NATIVE_MCP_SERVER_NAME,
  PLUGIN_ID,
  createSetup,
  createServerConfig,
  parseOptions,
  readCallerSecret,
} from "../rootfs/opt/opencode-v2-homeassistant/plugin.js";

const DEFAULT_OPTIONS = Object.freeze({
  endpoint: "http://127.0.0.1:43110/mcp",
});
const CALLER_SECRET = "a1".repeat(32);

describe("Home Assistant OpenCode V2 plugin", () => {
  it("has a stable first-party ID", () => {
    assert.equal(PLUGIN_ID, "homeassistant.mcp");
  });

  it("normalizes a safe loopback endpoint and timeout defaults", () => {
    assert.deepEqual(parseOptions(DEFAULT_OPTIONS), {
      bundledEnabled: true,
      endpoint: "http://127.0.0.1:43110/mcp",
      nativeEnabled: false,
      nativeEndpoint: "http://127.0.0.1:43110/native-mcp",
      timeouts: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
  });

  it("rejects unsafe native endpoints and invalid enablement", () => {
    for (const nativeEndpoint of [
      "http://192.0.2.1:43110/native-mcp",
      "http://127.0.0.1:43110/mcp",
      "http://127.0.0.1:43110/native-mcp?token=secret",
    ]) {
      assert.throws(
        () => parseOptions({ ...DEFAULT_OPTIONS, nativeEnabled: true, nativeEndpoint }),
        /plain loopback HTTP URL/,
      );
    }
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, nativeEnabled: "true" }),
      /must be true or false/,
    );
  });

  it("rejects remote, credential-bearing, and non-HTTP endpoints", () => {
    for (const endpoint of [
      "https://127.0.0.1:43110/mcp",
      "http://192.0.2.1:43110/mcp",
      "http://user:password@127.0.0.1:43110/mcp",
      "http://127.0.0.1:43110/secret",
      "http://127.0.0.1:43110/mcp?api_key=secret",
      "http://127.0.0.1:43110/mcp#secret",
      "file:///tmp/mcp.sock",
    ]) {
      assert.throws(() => parseOptions({ ...DEFAULT_OPTIONS, endpoint }), /plain loopback HTTP URL/);
    }
  });

  it("keeps parsing credential, header, token, and profile options out of plugin config", () => {
    for (const name of ["credential", "headers", "supervisorToken", "token", "profile"]) {
      assert.throws(
        () => parseOptions({ ...DEFAULT_OPTIONS, [name]: "sentinel" }),
        new RegExp(`Unknown Home Assistant plugin option: ${name}`),
      );
    }

    assert.doesNotMatch(JSON.stringify(parseOptions(DEFAULT_OPTIONS)), /credential|header|profile|secret|token/i);
  });

  it("rejects invalid timeout values", () => {
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { execution: 0 } }),
      /positive integer/,
    );
    assert.throws(
      () => parseOptions({ ...DEFAULT_OPTIONS, timeouts: { request: 1000 } }),
      /Unknown Home Assistant MCP timeout option/,
    );
  });

  function nativeReader({ value = CALLER_SECRET, count = 64, fail = false } = {}) {
    const buffers = [];
    let closed = 0;
    const read = () => readCallerSecret({ loadFfi: async () => ({
      FFIType: { ptr: "ptr", int: "int" },
      ptr(buffer) { buffers.push(buffer); return buffer; },
      dlopen(file, symbols) {
        assert.equal(file, CALLER_SECRET_LIBRARY);
        assert.deepEqual(symbols.opencode_v2_copy_caller_secret, { args: ["ptr", "int"], returns: "int" });
        return {
          symbols: { opencode_v2_copy_caller_secret(buffer, length) {
            assert.equal(length, 64);
            buffer.write(value);
            if (fail) throw new Error(`Synthetic native failure: ${value}`);
            return count;
          } },
          close() { closed++; },
        };
      },
    }) });
    return { read, buffers, closed: () => closed };
  }

  it("copies the process-owned credential repeatedly and wipes temporary buffers", async () => {
    const native = nativeReader();
    assert.deepEqual(await Promise.all([native.read(), native.read(), native.read()]), Array(3).fill(CALLER_SECRET));
    assert.equal(native.closed(), 3);
    for (const buffer of native.buffers) assert.ok(buffer.every((byte) => byte === 0));
  });

  it("fails closed on missing, malformed or failed native copies without logging credentials", async () => {
    for (const options of [{ count: 0 }, { count: 63 }, { value: "A".repeat(64) }, { fail: true }]) {
      const native = nativeReader(options);
      await assert.rejects(native.read(), (error) => {
        assert.match(error.message, /caller credential is unavailable/);
        assert.doesNotMatch(error.message, new RegExp(CALLER_SECRET));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(native.closed(), 1);
      for (const buffer of native.buffers) assert.ok(buffer.every((byte) => byte === 0));
    }
    await assert.rejects(readCallerSecret({ loadFfi: async () => { throw new Error(CALLER_SECRET); } }), /caller credential is unavailable/);
  });

  it("reactivates after disposal and failed registration using fresh setup closures", async () => {
    const native = nativeReader();
    let attempts = 0;
    let disposed = 0;
    const ctx = { options: DEFAULT_OPTIONS, mcp: { async transform(callback) {
      if (++attempts === 2) throw new Error("registration failed");
      callback({ set(name, config) {
        assert.equal(name, MCP_SERVER_NAME);
        assert.equal(config.headers.Authorization, `Bearer ${CALLER_SECRET}`);
      } });
      return { async dispose() { disposed++; } };
    } } };
    const setup = createSetup({ readSecret: native.read });
    await (await setup(ctx))();
    await assert.rejects(setup(ctx), /registration failed/);
    await (await createSetup({ readSecret: native.read })(ctx))();
    assert.equal(attempts, 3);
    assert.equal(disposed, 2);
    assert.equal(native.closed(), 3);
  });

  it("rejects invalid options before acquiring credentials", async () => {
    await assert.rejects(createSetup({ readSecret() { assert.fail("must not acquire secret"); } })({
      options: { endpoint: "https://example.test/mcp" },
    }), /plain loopback HTTP URL/);
  });

  it("builds a direct-tool remote MCP config with an in-memory bearer header", () => {
    const config = createServerConfig(parseOptions(DEFAULT_OPTIONS), CALLER_SECRET);

    assert.deepEqual(config, {
      type: "remote",
      url: "http://127.0.0.1:43110/mcp",
      headers: { Authorization: `Bearer ${CALLER_SECRET}` },
      oauth: false,
      disabled: false,
      codemode: false,
      timeout: { startup: 30_000, catalog: 60_000, execution: 60_000 },
    });
    assert.doesNotMatch(JSON.stringify(DEFAULT_OPTIONS), new RegExp(CALLER_SECRET));
  });

  it("registers MCP without putting the secret in options, then disposes it", async () => {
    let transform;
    const disposed = [];
    const options = { ...DEFAULT_OPTIONS };
    const setup = createSetup({ readSecret: () => CALLER_SECRET });
    const cleanup = await setup({
      options,
      mcp: {
        async transform(callback) {
          transform = callback;
          return {
            async dispose() {
              disposed.push("mcp");
            },
          };
        },
      },
    });

    const servers = new Map();
    transform({ set: (name, value) => servers.set(name, value) });

    assert.equal(servers.size, 1);
    assert.equal(servers.get(MCP_SERVER_NAME).codemode, false);
    assert.equal(servers.get(MCP_SERVER_NAME).headers.Authorization, `Bearer ${CALLER_SECRET}`);
    assert.deepEqual(options, DEFAULT_OPTIONS);
    assert.doesNotMatch(JSON.stringify(options), new RegExp(CALLER_SECRET));

    await cleanup();
    assert.deepEqual(disposed, ["mcp"]);
  });

  it("registers native Home Assistant as a second MCP with the same in-memory bearer", async () => {
    let transform;
    const options = { ...DEFAULT_OPTIONS, nativeEnabled: true };
    const setup = createSetup({ readSecret: () => CALLER_SECRET });
    const cleanup = await setup({
      options,
      mcp: {
        async transform(callback) {
          transform = callback;
          return { async dispose() {} };
        },
      },
    });

    const servers = new Map();
    transform({ set: (name, value) => servers.set(name, value) });

    assert.deepEqual([...servers.keys()], [MCP_SERVER_NAME, NATIVE_MCP_SERVER_NAME]);
    assert.equal(servers.get(NATIVE_MCP_SERVER_NAME).url, "http://127.0.0.1:43110/native-mcp");
    assert.equal(
      servers.get(NATIVE_MCP_SERVER_NAME).headers.Authorization,
      servers.get(MCP_SERVER_NAME).headers.Authorization,
    );
    assert.doesNotMatch(JSON.stringify(options), new RegExp(CALLER_SECRET));
    await cleanup();
  });

  it("registers native-only without registering bundled tools", async () => {
    const registered = new Map();
    let reads = 0;
    const cleanup = await createSetup({ readSecret: () => { reads++; return CALLER_SECRET; } })({
      options: { bundledEnabled: false, nativeEnabled: true, nativeEndpoint: "http://127.0.0.1:43110/native-mcp" },
      mcp: { async transform(callback) { callback(registered); return { async dispose() {} }; } },
    });
    assert.equal(reads, 1);
    assert.deepEqual([...registered.keys()], [NATIVE_MCP_SERVER_NAME]);
    assert.equal(registered.get(NATIVE_MCP_SERVER_NAME).headers.Authorization, `Bearer ${CALLER_SECRET}`);
    await cleanup();
  });

  it("does not acquire credentials or register anything when both HA connections are disabled", async () => {
    const cleanup = await createSetup({ readSecret() { assert.fail("must not read the sidecar secret"); } })({
      options: { bundledEnabled: false, nativeEnabled: false },
      mcp: { transform() { assert.fail("must not register a disabled connection"); } },
    });
    await cleanup();
  });

  it("requires a native endpoint in native-only configuration and validates disabled supplied endpoints", () => {
    assert.throws(() => parseOptions({ bundledEnabled: false, nativeEnabled: true }), /nativeEndpoint.*required/);
    assert.throws(() => parseOptions({ bundledEnabled: false, nativeEndpoint: "https://remote.test/native-mcp" }), /plain loopback/);
    assert.throws(() => parseOptions({ bundledEnabled: "false" }), /bundledEnabled.*true or false/);
  });

  it("keeps the default export on the pinned Plugin.define setup contract", () => {
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(typeof plugin.setup, "function");
  });
});
