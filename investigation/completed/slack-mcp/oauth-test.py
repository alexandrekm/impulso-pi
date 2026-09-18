#!/usr/bin/env python3
"""One-shot OAuth PKCE flow against Slack's official MCP server (mcp.slack.com).

Uses the public client_id Slack publishes for MCP clients (see
https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude). No client
secret: public client + PKCE (S256), local callback on 127.0.0.1:3118.

On success writes ~/.config/mcpshim/slack-mcp.json (mode 600) with the
token response, then probes initialize + tools/list against the MCP endpoint.

Usage:
  python3 oauth-test.py                # prints URL, waits for callback
  python3 oauth-test.py --manual       # prints URL, you paste the redirect URL
  python3 oauth-test.py --probe-only   # skip OAuth, just re-probe with saved token
"""
import hashlib, base64, json, os, secrets, sys, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

# The public client_id Slack publishes for MCP clients (see
# https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude). Kept out of
# the repo: set SLACK_MCP_CLIENT_ID in the environment.
CLIENT_ID = os.environ.get("SLACK_MCP_CLIENT_ID")
if not CLIENT_ID:
    sys.exit("Set SLACK_MCP_CLIENT_ID (the public client_id from Slack's MCP docs).")
CALLBACK_PORT = 3118
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/callback"
AUTHORIZE = "https://slack.com/oauth/v2_user/authorize"
TOKEN = "https://slack.com/api/oauth.v2.user.access"
MCP_URL = "https://mcp.slack.com/mcp"
OUT = os.path.expanduser("~/.config/mcpshim/slack-mcp.json")

SCOPES = [
    "channels:read", "channels:history",
    "groups:read", "groups:history",
    "im:read", "im:history", "mpim:read", "mpim:history",
    "chat:write", "users:read",
    "reactions:read", "reactions:write", "emoji:read", "files:read",
]


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def post_form(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def probe(access_token: str) -> None:
    """Minimal MCP handshake + tools/list over streamable HTTP."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {access_token}",
    }

    def rpc(method, params, rid, session=None):
        h = dict(headers)
        if session:
            h["Mcp-Session-Id"] = session
        req = urllib.request.Request(
            MCP_URL, data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method,
                                      "params": params}).encode(), headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                sid = r.headers.get("Mcp-Session-Id", session)
        except urllib.error.HTTPError as e:
            print(f"  [{method}] HTTP {e.code}: {e.read().decode()[:400]}")
            return None, session
        # SSE or plain JSON
        payload = None
        for line in raw.splitlines():
            if line.startswith("data:"):
                payload = json.loads(line[5:].strip())
        if payload is None:
            payload = json.loads(raw)
        return payload, sid

    init, sid = rpc("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "mcpshim-oauth-test", "version": "0.1.0"},
    }, 1)
    if not init:
        return
    server = init.get("result", {}).get("serverInfo", {})
    print(f"  initialize OK — server: {server.get('name')} {server.get('version')}"
          f" (session {sid})")

    # notifications/initialized
    h = dict(headers)
    if sid:
        h["Mcp-Session-Id"] = sid
    req = urllib.request.Request(MCP_URL, data=json.dumps(
        {"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(), headers=h)
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except urllib.error.HTTPError as e:
        print(f"  [notifications/initialized] HTTP {e.code} (continuing)")

    tools, _ = rpc("tools/list", {}, 2, sid)
    if tools is None:
        return
    names = [t.get("name") for t in tools.get("result", {}).get("tools", [])]
    print(f"  tools/list OK — {len(names)} tools:")
    for n in names:
        print("   -", n)


def main() -> None:
    if "--probe-only" in sys.argv:
        tok = json.load(open(OUT))["access_token"]
        probe(tok)
        return

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state = secrets.token_urlsafe(16)

    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": ",".join(SCOPES),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = f"{AUTHORIZE}?{urllib.parse.urlencode(params)}"
    print("\nOpen this URL in your browser and approve:\n")
    print(url)
    print()

    manual = "--manual" in sys.argv
    code = None
    if manual:
        pasted = input("Paste the full redirect URL (or just the code): ").strip()
        if "code=" in pasted:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query)
            code = q.get("code", [None])[0]
            if q.get("state", [state])[0] != state:
                print("WARNING: state mismatch")
        else:
            code = pasted
    else:
        got = {}

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                got.update(q)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"Auth complete - you can close this tab.")

            def log_message(self, *a):
                pass

        print(f"Waiting for callback on {REDIRECT_URI} ...")
        srv = HTTPServer(("127.0.0.1", CALLBACK_PORT), H)
        srv.handle_request()
        code = got.get("code", [None])[0]
        if got.get("state", [state])[0] != state:
            print("WARNING: state mismatch")
        if got.get("error"):
            print("Slack returned error:", got["error"][0])
            sys.exit(1)

    if not code:
        print("No code received.")
        sys.exit(1)
    print(f"Got code ({code[:8]}...), exchanging at {TOKEN} ...")

    resp = post_form(TOKEN, {
        "client_id": CLIENT_ID,
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    })
    if not resp.get("ok", True):  # slack-style error body
        print("Token exchange failed:", json.dumps(resp, indent=2)[:800])
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(resp, f, indent=2)
    os.chmod(OUT, 0o600)
    print(f"Token response saved to {OUT}")
    print("  keys:", list(resp.keys()))

    access = resp.get("access_token")
    if not access:
        print("No access_token in response; inspect the file.")
        sys.exit(1)
    print(f"  access_token: {access[:12]}...")
    print("\nProbing MCP endpoint:")
    probe(access)


if __name__ == "__main__":
    main()
