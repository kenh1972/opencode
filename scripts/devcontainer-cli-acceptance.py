#!/usr/bin/env python3
"""Exercise managed CLI identity without spawning an alternative service.

Run inside the official devcontainer. Briefly stops/restarts only the test app's
managed V2 server; uses no provider and performs no Home Assistant mutations.
"""
import json
import os
import subprocess
import time

if os.environ.get("HA_MANAGED_CLI_ACCEPTANCE") != "1":
    raise SystemExit("Set HA_MANAGED_CLI_ACCEPTANCE=1 in the official devcontainer")
CHANNEL = os.environ.get("HA_ACCEPTANCE_CHANNEL", "beta")
if CHANNEL not in ("stable", "beta"):
    raise SystemExit("HA_ACCEPTANCE_CHANNEL must be stable or beta")
APP = "app_local_ha_opencode" + ("_beta" if CHANNEL == "beta" else "")
SERVICE = "/run/service/ha-opencode-v2-server"


def execute(*args, success=True):
    result = subprocess.run(["docker", "exec", APP, *args], capture_output=True, text=True, timeout=20)
    if success:
        assert result.returncode == 0, f"Managed command failed: {args[0]} ({result.returncode})"
    else:
        assert result.returncode != 0, "Unavailable/unsupported operation unexpectedly succeeded"
    return result.stdout


INSPECT = r'''
import json
from pathlib import Path
pids = []
for path in Path('/proc').glob('[0-9]*/cmdline'):
    try:
        argv = path.read_bytes().split(b'\0')
        if argv and Path(argv[0].decode()).name in {'opencode', 'opencode2', 'opencode.exe', 'opencode-v2'}:
            pids.append(int(path.parent.name))
    except (FileNotFoundError, PermissionError): pass
listeners = []
for name in ('tcp', 'tcp6'):
    for row in Path('/proc/net', name).read_text().splitlines()[1:]:
        fields = row.split()
        if fields[3] == '0A': listeners.append(fields[1])
registries = sorted(str(p.relative_to('/run/opencode-v2/tui')) for p in Path('/run/opencode-v2/tui').rglob('*')
                    if p.is_file() and ('daemon' in p.name or 'service' in p.name))
print(json.dumps({'pids': sorted(pids), 'listeners': sorted(listeners), 'registries': registries}))
'''


def snapshot():
    return json.loads(execute("python3", "-c", INSPECT))


version = execute("opencode", "--version").strip()
assert version.startswith("opencode v2.")
assert execute("opencode2", "--version").strip() == version
execute("test", "!", "-e", "/usr/local/lib/node_modules/opencode-ai")
before = snapshot()
assert len(before["pids"]) == 1, "Start with one managed server and no attached test TUI"
for command in (("opencode", "status"), ("opencode", "service", "status")):
    status = json.loads(execute(*command))
    assert status["state"] == "running" and status["endpoint"] == "http://127.0.0.1:4100"
for name in ("opencode", "opencode2"):
    info = json.loads(execute(name, "api", "GET", "/api/info"))
    assert info["version"] == version.removeprefix("opencode v")
execute("opencode", "service", "start", success=False)
execute("opencode", "api", "--standalone", "GET", "/api/info", success=False)
assert snapshot() == before, "Inspection changed processes, listeners or service registries"

try:
    execute("s6-svc", "-d", SERVICE)
    for _ in range(50):
        if execute("s6-svstat", "-o", "up", SERVICE).strip() == "false": break
        time.sleep(0.1)
    stopped = snapshot()
    assert not stopped["pids"], "Managed V2 server did not stop"
    for command in (("opencode", "status"), ("opencode", "service", "status"), ("opencode", "api", "GET", "/api/info")):
        execute(*command, success=False)
    assert snapshot() == stopped, "A diagnostic started a replacement service"
finally:
    execute("s6-svc", "-u", SERVICE)
    for _ in range(60):
        result = subprocess.run(["docker", "exec", APP, "opencode", "status"], capture_output=True, timeout=5)
        if result.returncode == 0: break
        time.sleep(0.2)
    assert result.returncode == 0, "Managed server failed to resume"
execute("opencode-v2-self-test", "--quiet")
print("PASS: canonical V2 CLI; running/stopped diagnostics never create another daemon; managed server recovered")
