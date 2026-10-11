import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startAuthenticatedStreamableHttp } from "../lib/authenticated-streamable-http.js";

const SECRET = "a".repeat(64);
const openListeners = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.allSettled(openListeners.splice(0).map((listener) => listener.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function startTestServer({ callDelayMs = 0, callHandler, jsonRpcHandlers = {}, ...sessionLimits } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ha-mcp-http-"));
  temporaryDirectories.push(directory);
  const secretFile = join(directory, "secret");
  await writeFile(secretFile, `${SECRET}\n`, { mode: 0o600 });
  await chmod(secretFile, 0o600);

  const createMcpServer = () => {
  const mcpServer = new Server(
    { name: "transport-test", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "test_tool",
        description: "Transport test tool",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "test_tool") throw new Error("Unknown tool");
    if (callHandler) return callHandler(request, extra);
    if (callDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, callDelayMs));
    return { content: [{ type: "text", text: "complete" }] };
  });

  return mcpServer;
  };
  const listener = await startAuthenticatedStreamableHttp(createMcpServer, {
    secretFile,
    host: "127.0.0.1",
    port: 0,
    jsonRpcHandlers,
    ...sessionLimits,
  });
  openListeners.push(listener);
  return `http://${listener.host}:${listener.port}`;
}

function initializeRequest() {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    }),
  };
}

describe("authenticated Streamable HTTP transport", () => {
  it("rejects missing and incorrect bearer authorization", async () => {
    const baseUrl = await startTestServer();
    const missing = await fetch(`${baseUrl}/mcp`, initializeRequest());
    const wrong = await fetch(`${baseUrl}/mcp`, {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${"b".repeat(64)}` },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("initializes and lists tools through the authenticated SDK client", async () => {
    const baseUrl = await startTestServer();
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const result = await client.listTools();
    await client.close();

    expect(client.getServerVersion()?.name).toBe("transport-test");
    expect(result.tools.map((tool) => tool.name)).toEqual(["test_tool"]);
  });

  it("serves an independent authenticated stateless native MCP route", async () => {
    const nativeMessages = [];
    const nativeHandler = vi.fn(async (message, context) => {
      nativeMessages.push({
        method: message.method,
        requestedProtocolVersion: message.params?.protocolVersion,
        headerProtocolVersion: context.protocolVersion,
      });
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "homeassistant-native", version: "1" },
          },
        };
      }
      if (message.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "HassTurnOn", inputSchema: { type: "object" } }] },
        };
      }
      return null;
    });
    const baseUrl = await startTestServer({
      jsonRpcHandlers: { "/native-mcp": nativeHandler },
    });
    const missing = await fetch(`${baseUrl}/native-mcp`, initializeRequest());
    const nativeClient = new Client({ name: "native-vitest", version: "1.0.0" });
    const nativeTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/native-mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });
    const regularClient = new Client({ name: "regular-vitest", version: "1.0.0" });
    const regularTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    expect(missing.status).toBe(401);
    await Promise.all([nativeClient.connect(nativeTransport), regularClient.connect(regularTransport)]);
    expect((await nativeClient.listTools()).tools.map((tool) => tool.name)).toEqual(["HassTurnOn"]);
    expect((await regularClient.listTools()).tools.map((tool) => tool.name)).toEqual(["test_tool"]);
    await Promise.all([nativeClient.close(), regularClient.close()]);
    const initialization = nativeMessages.find(({ method }) => method === "initialize");
    const toolsList = nativeMessages.find(({ method }) => method === "tools/list");
    expect(initialization).toBeDefined();
    expect(toolsList).toBeDefined();
    expect(toolsList.headerProtocolVersion).toBe(initialization.requestedProtocolVersion);
  });

  it("keeps authenticated tool calls open beyond the former socket timeout", async () => {
    const baseUrl = await startTestServer({ callDelayMs: 15_250 });
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const result = await client.callTool({ name: "test_tool", arguments: {} });
    await client.close();

    expect(result.content).toEqual([{ type: "text", text: "complete" }]);
  }, 20_000);

  it("rejects stale bundled-route clients in native-only mode", async () => {
    const handler = vi.fn(async (message) => ({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
    const baseUrl = await startTestServer({ bundledEnabled: false, jsonRpcHandlers: { "/native-mcp": handler } });
    for (const method of ["POST", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp`, { ...initializeRequest(), method,
        headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}`, "mcp-session-id": "stale-session" },
      });
      expect(response.status).toBe(404);
    }
    expect((await fetch(`${baseUrl}/native-mcp`, initializeRequest())).status).toBe(401);
    const response = await fetch(`${baseUrl}/native-mcp`, { ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await fetch(`${baseUrl}/native-mcp/extra`, initializeRequest())).status).toBe(404);
  });

  it("delivers cancellation while an authenticated tool call is running", async () => {
    let startedResolve;
    let abortedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const aborted = new Promise((resolve) => { abortedResolve = resolve; });
    const baseUrl = await startTestServer({
      callHandler: (_request, extra) => new Promise((resolve) => {
        startedResolve();
        extra.signal.addEventListener("abort", () => {
          abortedResolve();
          resolve({ content: [{ type: "text", text: "cancelled" }] });
        }, { once: true });
      }),
    });
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });
    const controller = new AbortController();

    await client.connect(transport);
    const call = client.callTool(
      { name: "test_tool", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort("test cancellation");

    await expect(call).rejects.toThrow(/test cancellation/);
    await expect(aborted).resolves.toBeUndefined();
    await client.close();
  });

  it("cancels active work before waiting for HTTP shutdown", async () => {
    let startedResolve;
    let abortedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const aborted = new Promise((resolve) => { abortedResolve = resolve; });
    const baseUrl = await startTestServer({
      callHandler: (_request, extra) => new Promise((resolve) => {
        startedResolve();
        extra.signal.addEventListener("abort", () => {
          abortedResolve();
          resolve({ content: [{ type: "text", text: "stopped" }] });
        }, { once: true });
      }),
    });
    const listener = openListeners.at(-1);
    const client = new Client({ name: "shutdown-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    await client.connect(transport);
    const call = client.callTool({ name: "test_tool", arguments: {} });
    await started;
    const closing = listener.close();

    await expect(aborted).resolves.toBeUndefined();
    await closing;
    await expect(call).rejects.toThrow();
  });

  it("replaces a closed local client session without restarting the sidecar", async () => {
    const baseUrl = await startTestServer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = new Client({ name: `vitest-${attempt}`, version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
      });
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      await client.close();
    }
  });

  it("keeps an in-flight call and both client sessions alive when another client initializes", async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    const baseUrl = await startTestServer({ callHandler: async () => {
      started();
      await gate;
      return { content: [{ type: "text", text: "original-client-result" }] };
    } });
    const clients = ["first", "second"].map((name) => new Client({ name, version: "1" }));
    const transports = clients.map(() => new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    }));
    try {
      await clients[0].connect(transports[0]);
      const pending = clients[0].callTool({ name: "test_tool", arguments: {} }, undefined,
        { signal: AbortSignal.timeout(3000) }).then((value) => ({ value }), (error) => ({ error }));
      await entered;
      await clients[1].connect(transports[1]);
      release();
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value.content[0].text).toBe("original-client-result");
      const catalogs = await Promise.all(clients.map((client) => client.listTools()));
      expect(catalogs.map((catalog) => catalog.tools.length)).toEqual([1, 1]);
    } finally {
      release();
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  }, 6000);

  it("rejects the wrong path and every Origin header", async () => {
    const baseUrl = await startTestServer();
    const authorized = {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}` },
    };
    const wrongPath = await fetch(`${baseUrl}/mcp/`, authorized);
    const origin = await fetch(`${baseUrl}/mcp`, {
      ...authorized,
      headers: { ...authorized.headers, origin: "http://localhost" },
    });

    expect(wrongPath.status).toBe(404);
    expect(origin.status).toBe(403);
  });

  it("bounds sessions without evicting clients and releases only the explicitly terminated session", async () => {
    const baseUrl = await startTestServer({ maxSessions: 2 });
    const clients = [0, 1].map((i) => new Client({ name: `bounded-${i}`, version: "1" }));
    const transports = clients.map(() => new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    }));
    const initialize = { ...initializeRequest(), headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}` } };
    try {
      await Promise.all(clients.map((client, i) => client.connect(transports[i])));
      expect((await fetch(`${baseUrl}/mcp`, initialize)).status).toBe(503);
      expect((await clients[0].listTools()).tools).toHaveLength(1);
      const id = transports[0].sessionId;
      expect((await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": id } })).status).toBe(401);
      await transports[0].terminateSession();
      expect((await clients[1].listTools()).tools).toHaveLength(1);
      expect((await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: {
        authorization: `Bearer ${SECRET}`, "mcp-session-id": id,
      } })).status).toBe(404);
      expect((await fetch(`${baseUrl}/mcp`, initialize)).status).toBe(200);
    } finally { await Promise.allSettled(clients.map((client) => client.close())); }
  });

  it("keeps cancellation scoped to its client even when request IDs collide", async () => {
    const active = new Map();
    let entered;
    const bothStarted = new Promise((resolve) => { entered = resolve; });
    const aborted = [];
    const baseUrl = await startTestServer({ callHandler: (request, extra) => new Promise((resolve) => {
      const label = request.params.arguments.label;
      active.set(label, () => resolve({ content: [{ type: "text", text: label }] }));
      extra.signal.addEventListener("abort", () => { aborted.push(label); active.get(label)(); }, { once: true });
      if (active.size === 2) entered();
    }) });
    const clients = ["cancel", "keep"].map((name) => new Client({ name, version: "1" }));
    const controllers = clients.map(() => new AbortController());
    try {
      for (const client of clients) await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
      }));
      const calls = clients.map((client, i) => client.callTool({ name: "test_tool", arguments: { label: i ? "keep" : "cancel" } }, undefined,
        { signal: controllers[i].signal }).then((value) => ({ value }), (error) => ({ error })));
      await bothStarted;
      controllers[0].abort("cancel-one");
      expect((await calls[0]).error).toBeDefined();
      await vi.waitFor(() => expect(aborted).toEqual(["cancel"]));
      active.get("keep")();
      expect((await calls[1]).value.content[0].text).toBe("keep");
      expect((await clients[1].listTools()).tools).toHaveLength(1);
    } finally {
      for (const finish of active.values()) finish();
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  });

  it("reclaims idle sessions on initialization but preserves calls past the idle threshold", async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const baseUrl = await startTestServer({ maxSessions: 1, sessionIdleMs: 1000,
      callHandler: () => new Promise((resolve) => {
        release = () => resolve({ content: [{ type: "text", text: "preserved" }] });
        entered();
      }),
    });
    const client = new Client({ name: "idle-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
    });
    const initialize = { ...initializeRequest(), headers: { ...initializeRequest().headers, authorization: `Bearer ${SECRET}` } };
    try {
      await client.connect(transport);
      const pending = client.callTool({ name: "test_tool", arguments: {} }, undefined,
        { signal: AbortSignal.timeout(3000) }).then((value) => ({ value }), (error) => ({ error }));
      await started;
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
      expect((await fetch(`${baseUrl}/mcp`, initialize)).status).toBe(503);
      release();
      expect((await pending).value?.content[0].text).toBe("preserved");
      await client.listTools();
      clock.mockReturnValue(now + 4000);
      const replacement = await fetch(`${baseUrl}/mcp`, initialize);
      expect(replacement.status).toBe(200);
      expect(replacement.headers.get("mcp-session-id")).not.toBe(transport.sessionId);
      expect((await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: {
        authorization: `Bearer ${SECRET}`, "mcp-session-id": transport.sessionId,
      } })).status).toBe(404);
    } finally {
      release?.();
      await client.close();
    }
  });

  it("does not disclose the bearer secret in responses or logs", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      ...initializeRequest(),
      headers: { ...initializeRequest().headers, authorization: `Bearer ${"c".repeat(64)}` },
    });
    const disclosureSurface = [
      await response.text(),
      JSON.stringify(Object.fromEntries(response.headers)),
      ...errorLog.mock.calls.flat().map(String),
    ].join("\n");

    expect(disclosureSurface).not.toContain(SECRET);
    expect(disclosureSurface).not.toContain("c".repeat(64));
  });
});
