import json, sqlite3, sys
try:
    con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("select value_json from app_config where key='default'")
    row = cur.fetchone()
    if not row:
        print(json.dumps({"ok": False, "error": "no config row"}))
        sys.exit(0)
    cfg = json.loads(row[0])
    gw = cfg.get("gateway", {}) or {}
    proxy = cfg.get("proxy", {}) or {}
    print(json.dumps({
        "ok": True,
        "host": gw.get("host", "127.0.0.1"),
        "port": gw.get("port", 3456),
        "enabled": bool(gw.get("enabled", True)),
        "proxyEnabled": bool(proxy.get("enabled", False)),
        "proxyMode": proxy.get("mode", ""),
    }))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
