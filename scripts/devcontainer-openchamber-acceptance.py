#!/usr/bin/env python3
"""Opt-in preview lifecycle test in the official HA Apps devcontainer.

Temporarily selects OpenChamber, checks its real backend and UI lifecycle, then
restores the original interface. No HA device calls are made. Set the additional
HA_OPENCHAMBER_MODEL_ACCEPTANCE=1 to send one real free-model prompt through the UI.
HA_EDITOR_LSP_ACCEPTANCE=unavailable temporarily stops only the supervised LSP
worker for the rendered unavailable check, then restores it before smoke checks.
HA_ACCEPTANCE_CHANNEL=stable selects the isolated stable app (default: beta).
"""
import json
import os
import re
import subprocess
import time

if os.environ.get("HA_OPENCHAMBER_ACCEPTANCE") != "1":
    raise SystemExit("Set HA_OPENCHAMBER_ACCEPTANCE=1 in the official devcontainer")
CHANNEL = os.environ.get("HA_ACCEPTANCE_CHANNEL", "beta")
if CHANNEL not in ("stable", "beta"):
    raise SystemExit("HA_ACCEPTANCE_CHANNEL must be stable or beta")
SLUG = "local_ha_opencode" + ("_beta" if CHANNEL == "beta" else "")
APP = "app_" + SLUG
EDITOR_MODE = os.environ.get("HA_EDITOR_LSP_ACCEPTANCE") or None
if EDITOR_MODE not in (None, "live", "unavailable"):
    raise SystemExit("HA_EDITOR_LSP_ACCEPTANCE must be live or unavailable")


def command(*args, timeout=45):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    assert result.returncode == 0, f"Acceptance command failed: {args[0]} ({result.returncode})"
    return result.stdout


def app(*args):
    return command("docker", "exec", APP, *args)


def select_interface(mode):
    # Keep Supervisor credentials and saved options within Core's process.
    command("docker", "exec", "homeassistant", "python3", "-c", r'''
import json, os, sys, urllib.request
base = "http://supervisor/addons/" + sys.argv[2]
headers = {"Authorization": "Bearer " + os.environ["SUPERVISOR_TOKEN"], "Content-Type": "application/json"}
def request(path, data=None):
    req = urllib.request.Request(base + path, headers=headers, data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(req, timeout=20) as response:
        value = json.load(response)
    assert value["result"] == "ok"
    return value.get("data", {})
options = request("/info")["options"]
options["interface_mode"] = sys.argv[1]
request("/options", {"options": options})
''', mode, SLUG)
    command("ha", "apps", "restart", SLUG, timeout=120)
    for _ in range(80):
        result = subprocess.run(["docker", "exec", APP, "opencode", "status"], capture_output=True, timeout=5)
        if result.returncode == 0:
            return
        time.sleep(0.5)
    raise AssertionError("Managed server did not become ready")


def backend_pid():
    return app("pgrep", "-f", "^/usr/local/libexec/opencode-v2 serve ").strip()


def ready():
    for _ in range(60):
        result = subprocess.run(["docker", "exec", APP, "curl", "-fsS", "--max-time", "2", "http://127.0.0.1:3010/api/info"], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            try:
                if json.loads(result.stdout).get("version") == expected_version:
                    return
            except (ValueError, AttributeError):
                pass
        time.sleep(0.5)
    raise AssertionError("OpenChamber did not reach the pinned V2 backend")


def set_lsp_running(running):
    service = "/run/service/ha-opencode-v2-lsp"
    app("s6-svc", "-u" if running else "-d", service)
    for _ in range(60):
        up = app("s6-svstat", "-o", "up", service).strip() == "true"
        if up == running:
            if not running:
                return
            socket = subprocess.run(["docker", "exec", APP, "test", "-S", "/run/opencode-v2/lsp.sock"], capture_output=True, timeout=5)
            if socket.returncode == 0:
                return
        time.sleep(0.2)
    raise AssertionError("Supervised LSP worker did not reach the requested acceptance state")


expected_version = app("cat", "/usr/local/share/opencode-v2-certified-version").strip()
original = json.loads(command("ha", "--raw-json", "apps", "info", SLUG))["data"]["options"]["interface_mode"]
lsp_suspended = False
try:
    select_interface("openchamber")
    ready()
    # The preview must also tolerate an absent backend without creating its own.
    command("env", "HA_MANAGED_CLI_ACCEPTANCE=1", "python3", "scripts/devcontainer-cli-acceptance.py", timeout=90)
    ready()
    pid = backend_pid()
    assert pid.isdigit(), "Expected one app-owned backend"
    ui_pid = app("s6-svstat", "-o", "pid", "/run/service/ha-openchamber").strip()
    assert ui_pid.isdigit()
    inspect = subprocess.run(["docker", "exec", APP, "python3", "-c", r'''
import sys
from pathlib import Path
try:
    Path("/proc", sys.argv[1], "environ").read_bytes()
except PermissionError:
    raise SystemExit(0)
raise SystemExit("Credential-bearing UI remains externally inspectable")
''', ui_pid], capture_output=True, timeout=5)
    assert inspect.returncode == 0, "Preview credential process is not hardened"
    app("test", "!", "-e", "/usr/local/lib/node_modules/@openchamber/web")
    # API data and policies are from the same server that the terminal inspects.
    for path in ("/api/session", "/api/agent"):
        proxied = json.loads(app("curl", "-fsS", "--max-time", "10", "http://127.0.0.1:3010" + path))
        direct = json.loads(app("opencode", "api", "GET", path))
        # OpenChamber deliberately omits permissions/heavy metadata from session
        # lists. Compare session identity/title and the complete agent policy.
        assert "data" in proxied and "data" in direct
        if path == "/api/session":
            records = lambda value: sorted((row["id"], row["title"]) for row in value["data"])
            assert records(proxied) == records(direct), "Preview session history differs from the managed backend"
        else:
            assert proxied["data"] == direct["data"], "Preview agent policy differs from the managed backend"
    html = app("curl", "-fsS", "--max-time", "10", "-H", "X-Ingress-Path: /api/hassio_ingress/preview-acceptance", "http://127.0.0.1:8099/")
    assert "data-ha-ingress-runtime" in html
    assets = re.findall(r'(?:src|href)="([^"]*assets/[^"]+\.(?:js|css))"', html)
    assert assets and all(not asset.startswith("/assets/") for asset in assets)
    asset = app("curl", "-fsS", "--max-time", "10", "-H", "X-Ingress-Path: /api/hassio_ingress/preview-acceptance", "http://127.0.0.1:8099/" + assets[0].lstrip("/"))
    assert "<!doctype html" not in asset.lower(), "Asset request returned the HTML shell"
    entry = json.loads(command("ha", "--raw-json", "apps", "info", SLUG))["data"]["ingress_entry"]
    session = command("docker", "exec", "homeassistant", "python3", "-c", r'''
import json, os, urllib.request
req = urllib.request.Request("http://supervisor/ingress/session", data=b"{}", headers={"Authorization": "Bearer " + os.environ["SUPERVISOR_TOKEN"], "Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=10) as response:
    print(json.load(response)["data"]["session"])
''').strip()
    if EDITOR_MODE == "unavailable":
        assert app("s6-svstat", "-o", "up", "/run/service/ha-opencode-v2-lsp").strip() == "true", "Unavailable acceptance needs an initially running worker to restore"
        lsp_suspended = True
        set_lsp_running(False)
    try:
        core_port = json.loads(command("ha", "--raw-json", "core", "info"))["data"]["port"]
        browser = subprocess.run(["docker", "exec", "-i", APP, "node", "/local_apps/opencode/scripts/devcontainer-openchamber-browser.mjs"],
                                 input=json.dumps({"entry": entry, "session": session, "corePort": core_port, "livePrompt": os.environ.get("HA_OPENCHAMBER_MODEL_ACCEPTANCE") == "1",
                                                    "editorLspMode": EDITOR_MODE, "editorLspArtifactDirectory": os.environ.get("HA_EDITOR_LSP_ARTIFACT_DIRECTORY")}),
                                 capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired as error:
        # Keep bounded checkpoints on timeout too; restoration below restarts the
        # app and reaps the browser exec even when the Docker client timed out.
        decode = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else (value or "")
        browser = subprocess.CompletedProcess([], 124, decode(error.stdout), decode(error.stderr))
    if browser.returncode != 0:
        # Preserve diagnostic location, never browser URLs/cookies or exception
        # payloads that could include credentials or real user content.
        for line in browser.stdout.splitlines():
            if line.startswith(("PASS:", "CHECK:")):
                print(line, flush=True)
        locations = re.findall(r"devcontainer-openchamber[\w-]*\.mjs:\d+:\d+", browser.stderr)
        kinds = re.findall(r"^(?:AssertionError|TimeoutError|TypeError|ReferenceError|Error)\b", browser.stderr, re.M)
        kinds += re.findall(r"net::[A-Z_]+", browser.stderr)
        markers = [word for word in ("Timeout", "Target closed", "Protocol error", "out of memory", "SIGKILL", "SIGABRT", "AssertionError", "Error") if word in browser.stderr]
        print(f"Browser failure: exit={browser.returncode}, stderr_bytes={len(browser.stderr.encode())}, "
              + ", ".join(dict.fromkeys(kinds + locations + markers)), flush=True)
        raise AssertionError("Preview browser acceptance failed at the bounded locations above")
    print(browser.stdout.strip())
    if lsp_suspended:
        set_lsp_running(True)
        lsp_suspended = False
        print("PASS: supervised LSP worker restored after real unavailable-editor acceptance")
    app("opencode-smoke-test", "--quiet")
    app("s6-svc", "-d", "/run/service/ha-openchamber")
    for _ in range(50):
        if app("s6-svstat", "-o", "up", "/run/service/ha-openchamber").strip() == "false":
            break
        time.sleep(0.2)
    else:
        raise AssertionError("OpenChamber did not stop cleanly")
    assert backend_pid() == pid, "Stopping the UI stopped/replaced the backend"
    app("opencode", "status")
    app("s6-svc", "-u", "/run/service/ha-openchamber")
    ready()
    assert backend_pid() == pid, "UI restart created/replaced the backend"
    print("PASS: pinned preview, hardened credential process, shared sessions/policy, absent-backend recovery, independent UI stop/start")
finally:
    try:
        if lsp_suspended:
            set_lsp_running(True)
    finally:
        select_interface(original)
