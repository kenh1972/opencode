// Called by the official-devcontainer acceptance driver. Ingress credentials
// arrive over stdin, never via command arguments, environment or output.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { checkManagedUpdateNotice } from "./devcontainer-openchamber-update-notice.mjs";
import { checkEditorLsp } from "./devcontainer-openchamber-editor-lsp.mjs";
import { checkPromptAdmission } from "./devcontainer-openchamber-prompt.mjs";
const require = createRequire("/opt/ha-mcp-server/package.json");
const { default: puppeteer } = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { entry, session, corePort = 8123, livePrompt = false, editorLspMode = null, editorLspArtifactDirectory } = JSON.parse(input);
assert.ok(Number.isInteger(corePort) && corePort > 0 && corePort <= 65535);
assert.match(entry, /^\/api\/hassio_ingress\/[^/]+\/?$/);
const base = entry.replace(/\/$/, "") + "/";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await browser.setCookie({ name: "ingress_session", value: session, domain: "homeassistant", path: "/" });
  const errors = [];
  const escaped = [];
  const successful = new Set();
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.hostname !== "homeassistant") return;
    if (response.ok() && url.pathname.startsWith(base)) successful.add(url.pathname.slice(base.length));
    if ((url.pathname.startsWith("/assets/") || url.pathname.startsWith("/api/")) && !url.pathname.startsWith(base)) escaped.push(response.status());
  });
  const response = await page.goto(`http://homeassistant:${corePort}${base}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => document.querySelector("#root")?.children.length > 0, { timeout: 30000 });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.equal(errors.length, 0, `Preview page raised ${errors.length} JavaScript errors`);
  assert.equal(escaped.length, 0, `Preview made ${escaped.length} requests outside its Ingress prefix`);
  assert.ok([...successful].some((path) => path.startsWith("assets/") && path.endsWith(".js")), "No preview JavaScript loaded through Ingress");
  assert.ok([...successful].some((path) => path.startsWith("api/")), "No preview API request succeeded through Ingress");
  const workers = await page.evaluate(async () => "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0);
  assert.equal(workers, 0, "Ingress must not register an origin-scoped service worker");
  // GET-only bootstrap cannot detect malformed POST forwarding. Exercise actual
  // session creation/read/delete through Core's streaming Ingress proxy, without
  // contacting a model provider. Remove only this test's own disposable session.
  const creation = await page.evaluate(async (base) => {
    const title = "Ingress session regression — ✓";
    const response = await fetch(base + "api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, agent: "build", location: { directory: "/run/opencode-v2/workspace" } }),
    });
    const payload = await response.json().catch(() => null);
    const id = payload?.data?.id;
    if (!response.ok || typeof id !== "string") return { status: response.status, created: false };
    try {
      const read = await fetch(base + "api/session/" + encodeURIComponent(id));
      const saved = await read.json();
      return { status: response.status, created: read.ok && saved.data?.id === id && saved.data?.title === title };
    } finally {
      const removed = await fetch(base + "api/session/" + encodeURIComponent(id), { method: "DELETE" });
      if (!removed.ok) throw new Error("Disposable Ingress session cleanup failed");
    }
  }, base);
  assert.equal(creation.status, 200, "Session creation POST must traverse Core Ingress");
  assert.equal(creation.created, true, "Created session must be readable through Ingress");
  console.log("PASS: Chromium loaded the preview and created/read/deleted a session through Core Ingress");
  await checkPromptAdmission({ browser, page, base, session });

  console.log("CHECK: managed update notice");
  await checkManagedUpdateNotice({ browser, page, base, session });

  if (editorLspMode) {
    console.log("CHECK: rendered editor LSP");
    await checkEditorLsp({ browser, page, base, session, mode: editorLspMode, artifactDirectory: editorLspArtifactDirectory });
  }

  if (livePrompt) {
    // Separately opt in to a real free-model call. Abort before dispatch if a
    // persisted UI preference selects any other provider/model.
    let unexpectedModel = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === base + "api/session") {
        const model = JSON.parse(request.postData() || "{}").model;
        if (model?.providerID !== "opencode" || model?.id !== "big-pickle") {
          unexpectedModel = true;
          void request.abort();
          return;
        }
      }
      void request.continue();
    });
    const editor = await page.waitForSelector('[data-testid="chat-input"] [contenteditable="true"]', { timeout: 15000 });
    await editor.click();
    await page.keyboard.type("Reply only with OPENCODE_INGRESS_OK. Do not use tools or change any files.");
    const createdResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === base + "api/session", { timeout: 15000 });
    await page.click('button[aria-label="Send message"]');
    const response = await createdResponse;
    assert.equal(unexpectedModel, false, "Live acceptance requires the explicit free opencode/big-pickle model");
    assert.equal(response.status(), 200, "Sending the first UI message must create a session");
    const id = (await response.json()).data.id;
    try {
      const answer = await page.waitForFunction(async (base, id) => {
        const response = await fetch(base + "api/session/" + encodeURIComponent(id) + "/message");
        if (!response.ok) return false;
        const payload = await response.json();
        return payload.data?.find((message) => message.type === "assistant" &&
          message.content?.some((part) => part.type === "text" && part.text.includes("OPENCODE_INGRESS_OK")))?.id || false;
      }, { timeout: 45000, polling: 500 }, base, id);
      const messageID = await answer.jsonValue();
      await page.waitForFunction((id) => document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.textContent.includes("OPENCODE_INGRESS_OK"), { timeout: 10000 }, messageID);
      console.log("PASS: first UI message created a session and displayed a real free-model reply through Ingress");
    } finally {
      const removed = await page.evaluate(async (base, id) => (await fetch(base + "api/session/" + encodeURIComponent(id), { method: "DELETE" })).ok, base, id);
      assert.equal(removed, true, "Live-prompt fixture cleanup failed");
    }
  }
} finally {
  await browser.close();
}
