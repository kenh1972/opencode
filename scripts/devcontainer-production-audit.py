#!/usr/bin/env python3
"""Read-only audit of the installed stable/beta in the isolated HA devcontainer.

Run after installing/updating through Supervisor, with --version and the expected
Docker image ID. Report exact installed versions; never print app options/tokens.
"""
import argparse
import json
import os
import subprocess

if os.environ.get("HA_PRODUCTION_AUDIT") != "1":
    raise SystemExit("Set HA_PRODUCTION_AUDIT=1 in the official test devcontainer")

parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True)
parser.add_argument("--image", required=True)
parser.add_argument("--channel", choices=("stable", "beta"), default="beta")
args = parser.parse_args()
slug = "local_ha_opencode" + ("_beta" if args.channel == "beta" else "")
app = "app_" + slug


def command(*argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, f"Audit command failed: {argv[0]} (exit {result.returncode})"
    return result.stdout.strip()


info = json.loads(command("ha", "--raw-json", "apps", "info", slug))["data"]
assert info["version"] == args.version and info["state"] == "started", "Install and start the expected app first"
image = command("docker", "inspect", "--format", "{{.Image}}", app)
assert image == args.image, "Installed image differs from the qualification artifact"
assert command("docker", "inspect", "--format", "{{.State.Health.Status}}", app) == "healthy"
print(f"Installed {args.channel} {args.version}: {image}", flush=True)
for label, path in {
    "OpenCode CLI": "/opt/opencode-v2-homeassistant/node_modules/@opencode/cli/package.json",
    "OpenCode plugin": "/opt/opencode-v2-homeassistant/node_modules/@opencode/plugin/package.json",
    "OpenChamber": "/opt/openchamber-preview/packages/web/package.json",
    "Puppeteer": "/opt/ha-mcp-server/node_modules/puppeteer-core/package.json",
}.items():
    version = command("docker", "exec", app, "node", "-e", "console.log(require(process.argv[1]).version)", path)
    print(f"{label}: {version}", flush=True)

failed = False
for tree in ("opencode-v2-homeassistant", "ha-mcp-server", "ha-lsp-server", "ppq-private-runtime"):
    audit = subprocess.run(["docker", "exec", "--workdir", f"/opt/{tree}", app,
                            "npm", "audit", "--omit=dev", "--json"],
                           capture_output=True, text=True, timeout=120)
    try:
        report = json.loads(audit.stdout)
        counts = report["metadata"]["vulnerabilities"]
        assert audit.returncode in (0, 1) and not report.get("error")
    except (ValueError, KeyError, AssertionError):
        raise SystemExit(f"Audit unavailable for {tree}; do not treat this as a clean result")
    print(f"{tree}: {json.dumps(counts, sort_keys=True)}", flush=True)
    failed |= counts["total"] != 0 or audit.returncode != 0
    for name, finding in report.get("vulnerabilities", {}).items():
        print(f"  {name}: {finding['severity']} ({finding['range']})", flush=True)

openchamber = subprocess.run(["docker", "exec", app, "node", "/opt/openchamber/audit-installed.mjs"],
                            capture_output=True, text=True, timeout=120)
if openchamber.returncode not in (0, 1):
    raise SystemExit("Installed OpenChamber audit unavailable")
report = json.loads(openchamber.stdout)
assert isinstance(report.get("unmitigated"), int), "Incomplete OpenChamber audit"
print(json.dumps(report, sort_keys=True), flush=True)
failed |= openchamber.returncode != 0 or report["unmitigated"] != 0
print("Scope: four installed npm production trees plus installed OpenChamber packages; excludes OS packages and bundled browser code.")
raise SystemExit(1 if failed else 0)
