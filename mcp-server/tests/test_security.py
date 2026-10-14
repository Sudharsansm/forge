from forge_core import config, security


def test_unexpected_host_is_rejected(client):
    r = client.get("/api/files", headers={"Host": "evil.example.com"})
    assert r.status_code == 421
    assert client.get("/api/files", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/files", headers={"Host": "[::1]:8000"}).status_code == 200


def test_host_guard_off_when_api_key_set_unless_hosts_configured(monkeypatch):
    monkeypatch.setattr(config, "API_KEY", "k")
    monkeypatch.setattr(config, "ALLOWED_HOSTS", [])
    assert security.host_guard_enabled() is False
    monkeypatch.setattr(config, "ALLOWED_HOSTS", ["forge.example.com"])
    assert security.host_guard_enabled() is True
    assert "forge.example.com" in security.allowed_hosts()


def test_public_url_host_is_allowed(monkeypatch):
    monkeypatch.setattr(config, "PUBLIC_URL", "https://forge.example.com")
    assert "forge.example.com" in security.allowed_hosts()


def test_api_key_required_and_constant_time(monkeypatch, client):
    monkeypatch.setattr(config, "API_KEY", "s3cret")
    assert client.get("/api/files").status_code == 401
    assert client.get("/api/files", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/api/files", headers={"X-API-Key": "s3cret"}).status_code == 200
    assert client.get("/api/files", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    # the query-string token is no longer accepted for plain HTTP (it leaks into logs)
    assert client.get("/api/files?token=s3cret").status_code == 401
    assert client.get("/api/health").status_code == 200  # health stays open for probes


def test_repeated_failures_are_throttled(monkeypatch, client):
    monkeypatch.setattr(config, "API_KEY", "s3cret")
    codes = [client.get("/api/files", headers={"X-API-Key": "bad"}).status_code for _ in range(14)]
    assert 429 in codes
    # even the right key is refused while throttled
    assert client.get("/api/files", headers={"X-API-Key": "s3cret"}).status_code == 429


def test_body_limit(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_BODY_BYTES", 1000)
    r = client.post("/api/file", json={"path": "src/big.txt", "content": "x" * 5000})
    assert r.status_code == 413


def test_security_headers(client):
    r = client.get("/ui")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    if r.status_code == 200:
        assert "default-src 'none'" in r.headers["content-security-policy"]
    assert client.get("/api/files").headers["cache-control"] == "no-store"


def test_clean_env_drops_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    monkeypatch.setenv("FORGE_API_KEY", "forge-secret")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws")
    monkeypatch.setenv("npm_config_registry", "https://registry.example")
    env = security.clean_env({"X": "1"})
    assert "ANTHROPIC_API_KEY" not in env and "FORGE_API_KEY" not in env and "AWS_SECRET_ACCESS_KEY" not in env
    assert env["npm_config_registry"] == "https://registry.example" and env["X"] == "1" and "PATH" in env
