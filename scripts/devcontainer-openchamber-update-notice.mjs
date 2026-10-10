import assert from "node:assert/strict";

const VERSION = "2.0.99";
const DISMISSED_KEY = "opencode-update-toast-dismissed-version";
const DESCRIPTION = `OpenCode ${VERSION} is available upstream. Home Assistant Supervisor manages this app's OpenCode and OpenChamber versions. Check the app's page in Home Assistant for updates; this upstream release does not mean an app update is available.`;

// Exercise the built frontend, not a rendered fixture. Only the newer-upstream
// response and preference persistence are simulated; real settings stay intact.
export async function checkManagedUpdateNotice({ browser, page, base, session }) {
  // Core may redirect its default 8123 listener to the devcontainer's port 80.
  // Intercept the origin actually serving the page, not the initial entry URL.
  const entry = new URL(base, page.url());
  assert.equal(entry.protocol, "http:");
  assert.equal(entry.hostname, "homeassistant");
  assert.ok(["", "8123"].includes(entry.port));
  const baseline = await page.evaluate(async (base) => {
    const response = await fetch(base + "api/config/settings?surface=web", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    return response.json();
  }, base);
  assert.ok(baseline && typeof baseline === "object" && !Array.isArray(baseline), "Update-notice fixture needs a readable settings document");
  console.log("CHECK: update-notice settings read");
  let settings = { ...baseline, showOpenCodeUpdateNotifications: true, openCodeUpdateToastDismissedVersion: "" };
  const context = await browser.createBrowserContext();
  try {
    const isolated = await context.newPage();
    await context.setCookie({ name: "ingress_session", value: session, domain: "homeassistant", path: "/" });
    await isolated.evaluateOnNewDocument(() => {
      window.__i8SettingsSynced = false;
      window.addEventListener("openchamber:settings-synced", () => { window.__i8SettingsSynced = true; });
      localStorage.setItem("openchamber.i18n.v1", JSON.stringify({ locale: "en" }));
      // Seed only once: resetting on reload would defeat the dismissal check.
      if (localStorage.getItem("ui-store") === null) {
        localStorage.setItem("ui-store", JSON.stringify({ state: { showOpenCodeUpdateNotifications: true }, version: 21 }));
      }
    });
    let installRequests = 0;
    let settingsReads = 0;
    let upgradeReads = 0;
    let interceptionFailed = false;
    const errors = [];
    isolated.on("pageerror", (error) => errors.push(error.name));
    await isolated.setRequestInterception(true);
    isolated.on("request", (request) => {
      void (async () => {
        const url = new URL(request.url());
        const method = request.method();
        const path = url.pathname;
        if (/\/api\/(?:opencode\/upgrade|openchamber\/update-install)\/?$/.test(path)) {
          installRequests++;
          await request.abort();
          return;
        }
        if (url.origin === entry.origin && path === base + "api/config/settings") {
          if (method === "GET") settingsReads++;
          if (method === "PUT") {
            const changes = JSON.parse(request.postData() || "{}");
            settings = { ...settings, ...changes };
          } else if (method !== "GET") {
            throw new Error("Unexpected fixture settings method");
          }
          await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(settings) });
          return;
        }
        if (url.origin === entry.origin && path === base + "api/opencode/upgrade-status" && method === "GET") {
          upgradeReads++;
          await request.respond({
            status: 200, contentType: "application/json",
            body: JSON.stringify({ available: true, currentVersion: "2.0.26", latestVersion: VERSION, upgrade: { supported: false, manager: "external", reason: "external" } }),
          });
          return;
        }
        // This isolated scenario needs reads only. Never let incidental startup
        // or preference writes modify the server, even if upstream adds one.
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          await request.abort();
          return;
        }
        await request.continue();
      })().catch(async () => {
        interceptionFailed = true;
        await request.abort().catch(() => {});
      });
    });
    const response = await isolated.goto(entry.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    assert.equal(response.status(), 200, "Update-notice fixture must load through Ingress");
    console.log("CHECK: update-notice isolated page loaded");
    const toast = await isolated.waitForFunction((description) =>
      [...document.querySelectorAll("[data-sonner-toast]")].find((element) =>
        element.querySelector("[data-description]")?.textContent === description
      ), { timeout: 20000 }, DESCRIPTION).catch(async (error) => {
        const state = await isolated.evaluate(() => ({
          hydrated: window.__i8SettingsSynced === true,
          rootReady: !!document.querySelector("#root")?.children.length,
          toastCount: document.querySelectorAll("[data-sonner-toast]").length,
          notifications: JSON.parse(localStorage.getItem("ui-store") || "{}").state?.showOpenCodeUpdateNotifications,
        })).catch(() => null);
        console.log("CHECK: update-notice timeout " + JSON.stringify({ settingsReads, upgradeReads, interceptionFailed, errors, state }));
        throw error;
      });
    const buttons = await toast.evaluate((element) => [...element.querySelectorAll("button")].map((button) => button.textContent.trim()));
    assert.deepEqual(buttons, ["Dismiss"], "Managed update notice must offer only Dismiss");
    console.log("CHECK: update-notice guidance and Dismiss rendered");

    const saved = isolated.waitForResponse((response) => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === base + "api/config/settings" &&
      settings.openCodeUpdateToastDismissedVersion === VERSION, { timeout: 10000 });
    // Keep a click failure as the primary error: context cleanup otherwise makes
    // this pending waiter reject unhandled with "Page closed", masking the cause.
    void saved.catch(() => {});
    const dismiss = await toast.asElement().$("button");
    // Sonner inserts content before its mount/entrance layout makes the button
    // hit-testable. DOM presence alone is not a rendered interaction assertion.
    await isolated.waitForFunction((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none'
        && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && hit && button.contains(hit);
    }, { timeout: 5000 }, dismiss);
    try {
      await dismiss.click();
    } catch (error) {
      const geometry = await dismiss.evaluate((button) => {
        const box = (node) => { const r = node.getBoundingClientRect(); return { tag: node.tagName, x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { viewport: [innerWidth, innerHeight], button: box(button), ancestors: [button.parentElement, button.parentElement?.parentElement].filter(Boolean).map(box) };
      }).catch(() => null);
      console.log('CHECK: update-notice click geometry ' + JSON.stringify(geometry));
      throw error;
    }
    assert.equal((await saved).status(), 200, "Dismissal must save to the isolated settings fixture");
    console.log("CHECK: update-notice dismissal saved to fixture");
    await isolated.waitForFunction((key, version) => localStorage.getItem(key) === version,
      { timeout: 10000 }, DISMISSED_KEY, VERSION);
    await toast.dispose();

    // Wait for settings hydration, then trigger the toast's own status check.
    // An unrelated version display also fetches upgrade-status, so observing any
    // startup GET alone would not prove the toast has evaluated the dismissal.
    await isolated.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await isolated.waitForFunction(() => window.__i8SettingsSynced && document.querySelector("#root")?.children.length > 0,
      { timeout: 15000 });
    const checked = isolated.waitForResponse((response) => response.request().method() === "GET" &&
      new URL(response.url()).pathname === base + "api/opencode/upgrade-status", { timeout: 20000 });
    void checked.catch(() => {});
    await isolated.evaluate((version) => window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: { version } })), VERSION);
    assert.equal((await checked).status(), 200, "Reload must recheck the controlled upstream version");
    // A bounded observation window allows the fetch continuation and React/Sonner
    // rendering to settle while also detecting a briefly reappearing notice.
    const remainedDismissed = await isolated.evaluate((description) => new Promise((resolve) => {
      let reappeared = false;
      const inspect = () => {
        if ([...document.querySelectorAll("[data-sonner-toast]")].some((element) =>
          element.querySelector("[data-description]")?.textContent === description)) reappeared = true;
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      inspect();
      setTimeout(() => { inspect(); observer.disconnect(); resolve(!reappeared); }, 1000);
    }), DESCRIPTION);
    assert.equal(remainedDismissed, true, "Dismissed upstream version must stay dismissed after reload");
    assert.equal(await isolated.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY), VERSION, "Reload must retain the fixture's dismissed version");
    assert.equal(installRequests, 0, "Managed update notice must not request a component upgrade or installation");
    assert.equal(interceptionFailed, false, "Update-notice request interception must succeed");
    assert.equal(errors.length, 0, `Update-notice page raised ${errors.length} JavaScript errors`);
    console.log("PASS: Ingress update notice directs users to Supervisor, offers only Dismiss, and stays dismissed after reload without component installation");
  } finally {
    await context.close();
  }
}
