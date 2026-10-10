// Actual pinned relay and authentication implementations against loopback only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const upstream = process.env.OPENCHAMBER_TEST_ROOT || "/opt/openchamber-preview";
const web = path.join(upstream, "packages/web");
const require = createRequire(path.join(web, "package.json"));
const { WebSocketServer } = require("ws");
const { createRelayService } = await import(pathToFileURL(path.join(web, "server/lib/relay/service.js")));
const { createRemoteClientAuthRuntime } = await import(pathToFileURL(path.join(web, "server/lib/client-auth/remote-clients.js")));

for (const lan of [false, true]) {
  test(`passive relay restart preserves the ${lan ? "activation-scoped LAN" : "persistent Ingress-only"} authentication contract`, { timeout: 15000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ha-relay-restart-"));
    const data = path.join(root, "persistent");
    const auth = lan ? path.join(root, "runtime-auth") : data;
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const services = [];
    let connections = 0;
    relay.on("connection", () => { connections++; });
    try {
      await once(relay, "listening");
      await fs.mkdir(data, { recursive: true, mode: 0o700 });
      await fs.mkdir(auth, { recursive: true, mode: 0o700 });
      const settingsFile = path.join(data, "settings.json");
      await fs.writeFile(settingsFile, JSON.stringify({
        fixture: "preserve",
        privateRelay: { enabled: true, relayUrl: `ws://127.0.0.1:${relay.address().port}/ws` },
      }), { mode: 0o600 });
      const readSettings = async () => JSON.parse(await fs.readFile(settingsFile, "utf8"));
      const activate = (allowPassiveHost) => {
        const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(auth, "remote-clients.json") });
        const service = createRelayService({
          crypto, allowPassiveHost,
          readSettingsFromDiskMigrated: readSettings,
          readSettingsStrict: readSettings,
          writeSettingsToDisk: (next) => fs.writeFile(settingsFile, JSON.stringify(next), { mode: 0o600 }),
          getLocalPort: () => 1,
          hasRelayDemand: () => clients.hasActiveRelayClients(),
          logger: { warn() {} },
        });
        services.push(service);
        return { clients, service };
      };

      const disabled = activate(false);
      const paired = await disabled.clients.createClient({ label: "Fixture phone", usesRelay: true });
      await disabled.service.reconcile();
      assert.equal((await disabled.service.getStatus()).state, "standby");
      assert.equal(connections, 0);
      disabled.service.stop();

      const first = activate(true);
      let connected = once(relay, "connection", { signal: AbortSignal.timeout(5000) });
      await first.service.reconcile();
      const [, request] = await connected;
      const serverId = new URL(request.url, "http://localhost").searchParams.get("serverId");
      assert.ok(serverId);
      assert.equal(new URL(request.url, "http://localhost").searchParams.get("role"), "host-control");
      assert.equal((await first.clients.authenticateBearerToken(paired.token))?.ok, true);
      first.service.stop();

      // App restart recreates only /run authentication; /data is retained.
      if (lan) {
        await fs.rm(auth, { recursive: true });
        await fs.mkdir(auth, { mode: 0o700 });
      }
      const second = activate(true);
      if (lan) {
        await second.service.reconcile();
        assert.equal(await second.clients.authenticateBearerToken(paired.token), null);
        assert.equal((await second.service.getStatus()).state, "disabled");
        assert.equal(connections, 1);
      } else {
        connected = once(relay, "connection", { signal: AbortSignal.timeout(5000) });
        await second.service.reconcile();
        const [, restartedRequest] = await connected;
        assert.equal(new URL(restartedRequest.url, "http://localhost").searchParams.get("serverId"), serverId);
        assert.equal((await second.clients.authenticateBearerToken(paired.token))?.ok, true);
        assert.equal(connections, 2);
        await second.clients.revokeClient(paired.client.id);
        await second.service.reconcile();
        assert.equal((await second.service.getStatus()).state, "disabled");
        assert.equal(await second.clients.authenticateBearerToken(paired.token), null);
      }
      assert.equal((await readSettings()).fixture, "preserve");
    } finally {
      for (const service of services) service.stop();
      for (const socket of relay.clients) socket.terminate();
      await new Promise((resolve) => relay.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
