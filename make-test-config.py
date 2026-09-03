import sqlite3, json, sys

path = sys.argv[1]
port = int(sys.argv[2])
enabled = sys.argv[3].lower() == "true"
proxy_enabled = sys.argv[4].lower() == "true" if len(sys.argv) > 4 else False
proxy_mode = sys.argv[5] if len(sys.argv) > 5 else ""

con = sqlite3.connect(path)
cur = con.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT)")
cfg = {
    "gateway": {"host": "127.0.0.1", "port": port, "enabled": enabled, "coreHost": "127.0.0.1", "corePort": port + 1},
    "proxy": {"enabled": proxy_enabled, "mode": proxy_mode},
}
cur.execute(
    "INSERT INTO app_config (key, value_json, updated_at) VALUES ('default', ?, '2026-09-01T00:00:00Z') "
    "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    (json.dumps(cfg),),
)
con.commit()
con.close()
print("wrote", path, "port=", port, "enabled=", enabled)
