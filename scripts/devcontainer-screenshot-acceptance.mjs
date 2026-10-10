// Run inside the installed app in the official HA devcontainer:
// docker exec -i -e HA_SCREENSHOT_ACCEPTANCE=1 app_local_ha_opencode node --input-type=module < scripts/devcontainer-screenshot-acceptance.mjs
// Requires screenshot_enabled and an admin LLAT in the test app's options.
// Creates a unique storage dashboard through HA's API and removes it afterwards.
// Optional HA_SCREENSHOT_BASELINE points to the pre-fix takeScreenshot function.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import WebSocket from "/opt/ha-mcp-server/node_modules/ws/wrapper.mjs";
const require = createRequire("/opt/ha-mcp-server/package.json");
const { default: puppeteer } = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { captureHomeAssistantPage } from "/opt/ha-mcp-server/lib/screenshot.js";

assert.equal(process.env.HA_SCREENSHOT_ACCEPTANCE, "1", "Opt in only in the HA devcontainer test app");
const options = JSON.parse(readFileSync("/data/options.json", "utf8"));
assert.ok(options.screenshot_enabled && options.access_token, "Configure the test app's screenshot option and LLAT first");
const token = options.access_token;
const response = await fetch("http://supervisor/core/api/config", {
  headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
});
assert.ok(response.ok, "Core config API must be reachable");
const config = await response.json();
assert.ok(config.internal_url, "Set a direct internal URL on the test Core instance");
const origin = new URL(config.internal_url).origin;
console.log(`Real HA screenshot acceptance: Core ${config.version}, ${origin}`);

const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/websocket`);
const pending = new Map();
let nextId = 1;
const authenticated = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("HA WebSocket authentication timed out")), 10000);
  ws.on("error", () => { clearTimeout(timer); reject(new Error("HA WebSocket connection failed")); });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
    if (message.type === "auth_ok") { clearTimeout(timer); resolve(); }
    if (message.type === "auth_invalid") { clearTimeout(timer); reject(new Error("HA rejected the test app's token")); }
    if (message.type === "result") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.success) entry.resolve(message.result);
      else entry.reject(new Error(`HA command failed: ${entry.type} (${message.error?.code})`));
    }
  });
});
function command(type, data = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`HA command timed out: ${type}`)); }, 10000);
    pending.set(id, { resolve, reject, timer, type });
    ws.send(JSON.stringify({ id, type, ...data }));
  });
}

let dashboard;
let browser;
let client;
const urlPath = `opencode-screenshot-${randomUUID().slice(0, 8)}`;
const marker = "OpenCode screenshot authenticated acceptance";
try {
  await authenticated;
  dashboard = await command("lovelace/dashboards/create", {
    url_path: urlPath, title: "Screenshot acceptance", mode: "storage",
    require_admin: true, show_in_sidebar: false,
  });
  await command("lovelace/config/save", {
    url_path: urlPath,
    config: { views: [{ title: "Acceptance", cards: [{ type: "markdown", content: `# ${marker}` }] }] },
  });
  browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const initialContexts = browser.browserContexts().length;
  const evidence = [];
  let authFrames = 0;
  let invalidAuthFrames = 0;

  // Observe the real rendered document and wire handshake at capture time;
  // do not mock authentication, frontend state, network, or the screenshot.
  const observedBrowser = {
    async createBrowserContext() {
      const context = await browser.createBrowserContext();
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        const session = await page.createCDPSession();
        await session.send("Network.enable");
        session.on("Network.webSocketFrameSent", ({ response }) => {
          try { if (JSON.parse(response.payloadData).type === "auth") authFrames++; } catch {}
        });
        session.on("Network.webSocketFrameReceived", ({ response }) => {
          try { if (JSON.parse(response.payloadData).type === "auth_invalid") invalidAuthFrames++; } catch {}
        });
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async (...args) => {
          evidence.push(await page.evaluate((marker) => {
            const texts = [];
            const visit = (root) => {
              for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot) visit(element.shadowRoot);
              }
              texts.push(root.textContent || "");
            };
            visit(document.body);
            const app = document.querySelector("home-assistant");
            return { path: location.pathname, connected: Boolean(app?.hass?.connection?.connected), markerVisible: texts.some(text => text.includes(marker)) };
          }, marker));
          return screenshot(...args);
        };
        return page;
      };
      return context;
    },
  };
  const captureOptions = { haCoreUrl: origin, urlPath: `/${urlPath}/0`, token, waitSeconds: 1 };

  // Real browser URL normalization: uppercase DNS names compare unequal in
  // the old hassTokens record, but Chromium canonicalizes them to lowercase.
  const nonCanonical = new URL(origin);
  const uppercaseOrigin = `${nonCanonical.protocol}//${nonCanonical.host.toUpperCase()}`;
  assert.notEqual(uppercaseOrigin, origin, "Use a DNS hostname (e.g. homeassistant), not an IP, to exercise normalization");
  if (process.env.HA_SCREENSHOT_BASELINE) {
    const baselineContext = await observedBrowser.createBrowserContext();
    try {
      const sandbox = vm.createContext({
        getSharedBrowser: async () => ({ newPage: () => baselineContext.newPage() }),
        HA_ACCESS_TOKEN: token, sendLog: () => {}, scheduleBrowserClose: () => {}, setTimeout,
      });
      vm.runInContext(readFileSync(process.env.HA_SCREENSHOT_BASELINE, "utf8"), sandbox);
      const image = await sandbox.takeScreenshot(uppercaseOrigin, captureOptions.urlPath, { waitSeconds: 3 });
      const state = evidence.at(-1);
      assert.match(state.path, /^\/auth\//);
      assert.equal(state.connected, false);
      writeFileSync("/tmp/screenshot-baseline-login.png", Buffer.from(image, "base64"));
      console.log("PASS: pre-fix implementation reproduces a successful capture of the real HA login page");
    } finally { await baselineContext.close(); }
  }

  const beforeAuth = authFrames;
  const capture = await captureHomeAssistantPage(observedBrowser, { ...captureOptions, haCoreUrl: uppercaseOrigin });
  assert.equal(capture.finalPath, captureOptions.urlPath);
  assert.deepEqual(evidence.at(-1), { path: captureOptions.urlPath, connected: true, markerVisible: true });
  assert.equal(authFrames - beforeAuth, 1, "The real frontend must send exactly one auth frame");
  assert.equal(invalidAuthFrames, 0);
  assert.equal(browser.browserContexts().length, initialContexts);
  writeFileSync("/tmp/screenshot-fixed-dashboard.png", Buffer.from(capture.image, "base64"));
  console.log("PASS: normalized origin renders the real storage dashboard, one auth frame, context cleaned up");

  const settings = await captureHomeAssistantPage(observedBrowser, { ...captureOptions, urlPath: "/config/dashboard" });
  assert.equal(evidence.at(-1).connected, true);
  writeFileSync("/tmp/screenshot-fixed-settings.png", Buffer.from(settings.image, "base64"));
  console.log(`PASS: authenticated Settings capture at ${settings.finalPath}`);

  for (const [label, path] of [
    ["app-info", "/config/app/local_ha_opencode_beta/info"],
    ["app-ingress", "/app/local_ha_opencode_beta"],
  ]) {
    const capture = await captureHomeAssistantPage(observedBrowser, { ...captureOptions, urlPath: path, waitSeconds: 5 });
    assert.equal(capture.finalPath, path);
    assert.equal(evidence.at(-1).connected, true);
    writeFileSync(`/tmp/screenshot-fixed-${label}.png`, Buffer.from(capture.image, "base64"));
    console.log(`PASS: authenticated current HA app route ${path}`);
  }
  for (const path of ["/hassio/ingress/local_ha_opencode_beta", "/hassio/addon/local_ha_opencode_beta/info"]) {
    await assert.rejects(captureHomeAssistantPage(observedBrowser, { ...captureOptions, urlPath: path }), /HTTP 404/);
  }
  console.log("PASS: obsolete /hassio frontend routes report HTTP 404 rather than a successful screenshot");

  await assert.rejects(captureHomeAssistantPage(observedBrowser, {
    ...captureOptions, token: "deliberately-invalid-test-token", timeoutMs: 5000,
  }), /authentication|connection|login/i);
  assert.ok(invalidAuthFrames > 0, "The negative test must reach real HA token validation");
  assert.equal(browser.browserContexts().length, initialContexts);
  console.log("PASS: real HA rejection returns an error and disposes browser state");

  client = new Client({ name: "screenshot-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["/opt/ha-mcp-server/index.js"], stderr: "pipe",
    env: { ...process.env, HA_ACCESS_TOKEN: token, SCREENSHOT_ENABLED: "true", OPENCODE_MCP_TOOL_PROFILE: "full" },
  });
  await client.connect(transport);
  const result = await client.callTool({ name: "screenshot_url", arguments: {
    url_path: captureOptions.urlPath, width: 1280, height: 720, wait_seconds: 3,
  } }, undefined, { timeout: 90000 });
  assert.ok(!result.isError, "Real MCP screenshot_url must succeed");
  assert.ok(result.content.some(part => part.type === "text" && part.text.includes(`Captured authenticated Home Assistant page ${captureOptions.urlPath}`)));
  const image = result.content.find(part => part.type === "image");
  assert.equal(image?.mimeType, "image/png");
  writeFileSync("/tmp/screenshot-mcp-dashboard.png", Buffer.from(image.data, "base64"));
  const failure = await client.callTool({ name: "screenshot_url", arguments: { url_path: "/auth/authorize?code=must-not-appear" } });
  assert.equal(failure.isError, true);
  assert.ok(!JSON.stringify(failure).includes("must-not-appear"));
  assert.ok(!failure.content.some(part => part.type === "image"));
  console.log("PASS: actual MCP tool returns a dashboard PNG; login requests return isError without an image or OAuth query");
} finally {
  await client?.close();
  await browser?.close();
  try {
    if (dashboard) await command("lovelace/dashboards/delete", { dashboard_id: dashboard.id });
  } finally { ws.close(); }
}
