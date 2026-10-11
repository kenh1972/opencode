import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { OpenCode } from "../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";

const runtime = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
const cli = join(runtime, "node_modules/@opencode/cli/bin/opencode.exe");

test("pinned V2 loads an opted-in local plugin through its native loader and omits it after disable/restart", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-v2-plugin-runtime-"));
  const marker = join(root, "loaded.json");
  const optionsFile = join(root, "options.json");
  const managedFile = join(root, "managed.json");
  let server;
  let logs = "";
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "Fixture complete" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
  try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    for (const leaf of ["home", "config", "data", "state", "cache", "project", "plugin"]) await mkdir(join(root, leaf));
    await writeFile(join(root, "plugin/package.json"), '{"type":"module"}');
    await writeFile(join(root, "plugin/index.js"), `
      import { writeFileSync } from "node:fs";
      import { Plugin } from "@opencode/plugin";
      export default Plugin.define({ id: "fixture.third-party", setup(ctx) {
        writeFileSync(ctx.options.marker, JSON.stringify(ctx.options));
      } });
    `);
    const custom = {
      plugins: [{ package: pathToFileURL(join(root, "plugin")).href, options: { marker, enabled: true } }],
      model: "fixture/coding",
      providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-key" },
        models: { coding: { modelID: "fixture", limit: { context: 8192, output: 1000 } } },
      } },
    };
    for (const enabled of [true, false]) {
      await writeFile(optionsFile, JSON.stringify({ custom_plugins_enabled: enabled, opencode_config: JSON.stringify(custom) }));
      const generated = spawnSync(process.execPath, [join(runtime, "managed-config.js"),
        "--options-file", optionsFile, "--environment-output", join(root, "provider-env"),
      ], { encoding: "utf8", timeout: 10_000 });
      assert.equal(generated.status, 0, generated.stderr);
      const managed = JSON.parse(generated.stdout);
      // Resolve bundled image paths to this checkout for the desktop-host test.
      for (const entry of managed.plugins) {
        if (entry.package.startsWith("file:///opt/opencode-v2-homeassistant/")) {
          if (entry.package.endsWith("/context-plugin")) entry.options.files = [join(runtime, "WORKSPACE.md")];
          entry.package = pathToFileURL(join(runtime, entry.package.split("/").at(-1))).href;
        }
      }
      await writeFile(managedFile, JSON.stringify(managed));
      const reservation = createServer();
      await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], {
        cwd: join(root, "project"), stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
          HOME: join(root, "home"), USERPROFILE: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG: managedFile, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_SERVER_PASSWORD: "fixture-server-password",
        },
      });
      for (const pipe of [server.stdout, server.stderr]) pipe.on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
        headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-server-password").toString("base64")}` },
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await client.server.info({ signal: AbortSignal.timeout(100) }); ready = true; break; }
        catch { await sleep(50); }
      }
      assert.ok(ready, logs);
      const session = await client.session.create({ title: "Third-party plugin fixture", model: { providerID: "fixture", id: "coding" } });
      await client.session.prompt({ sessionID: session.id, text: "Finish the synthetic fixture." });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
      if (enabled) {
        assert.ok(await readFile(marker).then(() => true, () => false), logs);
        assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { marker, enabled: true });
        await rm(marker);
      } else {
        await assert.rejects(readFile(marker), { code: "ENOENT" });
      }
      await stop();
    }
  } finally {
    await stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
