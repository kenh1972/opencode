#!/usr/bin/env python3
"""Opt-in supervised LAN qualification. Run inside devcontainer Core.

Temporarily enables the beta LAN frontends, uses a local certificate-verified
HTTPS reverse proxy, rotates credentials through an app restart, then restores
the original options. Requires a prior Supervisor backup. Prints no credentials.
Set HA_LAN_EXPECTED_VERSION to the candidate's build.yaml OPENCODE_V2_VERSION
(for example, 2.0.26); this is checked before any test configuration changes.
"""
import base64
import datetime
import http.client
import http.server
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import tempfile
import threading
import time
import urllib.request

if os.environ.get("HA_LAN_ACCEPTANCE") != "1":
    raise SystemExit("Set HA_LAN_ACCEPTANCE=1 inside the official devcontainer Core")
EXPECTED_VERSION = os.environ.get("HA_LAN_EXPECTED_VERSION")
if not EXPECTED_VERSION:
    raise SystemExit("Set HA_LAN_EXPECTED_VERSION to the candidate's pinned OpenCode version before LAN qualification")
HOST = str(ipaddress.ip_address(os.environ["HA_LAN_APP_HOST"]))
SLUG = "local_ha_opencode_beta"
BASE = "http://supervisor/addons/" + SLUG
TOKEN = os.environ["SUPERVISOR_TOKEN"]


def supervisor(route, payload=None):
    request = urllib.request.Request(BASE + route, headers={"Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json"}, data=None if payload is None else json.dumps(payload).encode())
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
    assert result["result"] == "ok", "Supervisor operation failed"
    return result.get("data", {})


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def forward(self):
        connection = http.client.HTTPConnection(HOST, self.server.upstream_port, timeout=15)
        headers = dict(self.headers)
        for key in list(headers):
            if key.lower() in ("connection", "forwarded", "transfer-encoding") or key.lower().startswith("x-forwarded-"):
                del headers[key]
        headers["X-Forwarded-Proto"] = "https"
        headers["X-Forwarded-For"] = self.client_address[0]
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            connection.request(self.command, self.path, body=body or None, headers=headers)
            reply = connection.getresponse()
            self.send_response(reply.status)
            for key, value in reply.getheaders():
                if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            while chunk := reply.read1(8192):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            connection.close()

    do_GET = do_POST = do_OPTIONS = forward


def make_certificate(root):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .sign(key, hashes.SHA256()))
    key_path, cert_path = root / "key.pem", root / "cert.pem"
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context, ssl.create_default_context(cafile=cert_path)


original = supervisor("/info")["options"]
password = secrets.token_urlsafe(32)
with tempfile.TemporaryDirectory(prefix="ha-lan-acceptance-") as temp:
    root = Path(temp)
    saved = root / "original-options.json"
    with os.fdopen(os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(original, file)
    server_context, client_context = make_certificate(root)
    proxies = []
    for upstream_port in (4096, 4097):
        proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        proxy.daemon_threads = True
        proxy.upstream_port = upstream_port
        proxy.socket = server_context.wrap_socket(proxy.socket, server_side=True)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        proxies.append(proxy)
    origins = [f"https://localhost:{proxy.server_port}" for proxy in proxies]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect((HOST, 4096))
        proxy_ip = route.getsockname()[0]

    def request(which, route, method="GET", body=None, headers=None, stream=False):
        connection = http.client.HTTPSConnection("localhost", proxies[which].server_port, context=client_context, timeout=10)
        headers = dict(headers or {})
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, route, body=None if body is None else json.dumps(body).encode(), headers=headers)
        response = connection.getresponse()
        if stream:
            return connection, response
        text = response.read()
        result = (response.status, {key.lower(): value for key, value in response.getheaders()}, text)
        connection.close()
        return result

    def basic(value):
        return "Basic " + base64.b64encode(("opencode:" + value).encode()).decode()

    def restart(options):
        supervisor("/options", {"options": options})
        supervisor("/restart", {})
        for _ in range(60):
            try:
                if request(0, "/api/info")[0] == 401 and request(1, "/auth/session")[0] == 401:
                    return
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.5)
        raise AssertionError("Supervised LAN listeners did not become ready")

    options = {**original, "interface_mode": "openchamber", "enable_server": True, "enable_openchamber_lan": True,
        "lan_password": password, "lan_trusted_proxies": [proxy_ip], "server_public_url": origins[0],
        "openchamber_public_url": origins[1], "cors_origins": ["https://client.fixture.test"]}
    stage = "activate LAN"
    stream_connection = None
    try:
        restart(options)
        stage = "API authentication and origins"
        status, _, payload = request(0, "/api/info", headers={"Authorization": basic(password)})
        assert status == 200 and json.loads(payload).get("version") == EXPECTED_VERSION
        assert request(0, "/api/info", headers={"Authorization": basic(password), "Origin": "https://evil.test"})[0] == 403
        assert request(0, "/api/info", method="OPTIONS", headers={"Origin": "https://client.fixture.test", "Access-Control-Request-Method": "POST"})[0] == 204
        assert request(1, "/api/ha-editor-lsp/diagnostics", method="POST", body={}, headers={"Origin": origins[1]})[0] == 403
        stage = "native UI login"
        assert request(1, "/auth/session", method="POST", body={"password": "wrong"}, headers={"Origin": origins[1]})[0] == 401
        status, headers, payload = request(1, "/auth/session", method="POST", body={"password": password, "issueClientToken": True}, headers={"Origin": origins[1]})
        assert status == 200
        stage = "native UI cookie and paired-token verification"
        cookie_header = headers["set-cookie"]
        assert "Secure" in cookie_header and "HttpOnly" in cookie_header
        cookie = cookie_header.split(";", 1)[0]
        client_token = json.loads(payload)["clientToken"]
        assert request(1, "/api/info", headers={"Cookie": cookie})[0] == 200
        assert request(1, "/auth/session", headers={"Authorization": "Bearer " + client_token})[0] == 200
        stage = "shared backend session verification"
        api_sessions = json.loads(request(0, "/api/session", headers={"Authorization": basic(password)})[2])["data"]
        ui_sessions = json.loads(request(1, "/api/session", headers={"Cookie": cookie})[2])["data"]
        assert sorted(row["id"] for row in api_sessions) == sorted(row["id"] for row in ui_sessions)
        stage = "rotation and stream shutdown"
        stream_connection, stream = request(0, "/api/event", headers={"Authorization": basic(password)}, stream=True)
        assert stream.status == 200 and stream.read(1)
        rotated = secrets.token_urlsafe(32)
        restart({**options, "lan_password": rotated})
        # A dead pre-restart stream must reach EOF rather than stay connected.
        stream.read()
        assert request(0, "/api/info", headers={"Authorization": basic(password)})[0] == 401
        assert request(0, "/api/info", headers={"Authorization": basic(rotated)})[0] == 200
        assert request(1, "/auth/session", headers={"Cookie": cookie})[0] == 401
        assert request(1, "/auth/session", headers={"Authorization": "Bearer " + client_token})[0] == 401
        assert request(1, "/auth/session", method="POST", body={"password": rotated}, headers={"Origin": origins[1]})[0] == 200
        print("Supervised HTTPS LAN passed: API/UI auth, origins, shared sessions, stream shutdown and cookie/client-token rotation")
    except Exception:
        raise SystemExit("LAN acceptance failed during " + stage) from None
    finally:
        if stream_connection:
            stream_connection.close()
        try:
            supervisor("/options", {"options": original})
            supervisor("/restart", {})
            print("Restored original beta options and restarted the app")
        except Exception:
            # Retain protected recovery information if restoration cannot finish.
            recovery = Path("/tmp/ha-lan-options-recovery.json")
            with os.fdopen(os.open(recovery, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
                json.dump(original, file)
            raise SystemExit("Option restoration failed; protected recovery file: /tmp/ha-lan-options-recovery.json") from None
        finally:
            for proxy in proxies:
                proxy.shutdown()
                proxy.server_close()
