// C1: where the router keeps its data, and the override chain that decides it. Path STRINGS only: nothing here
// touches a real file. The chain mirrors CCR 3.0.22's own resolution (see the header of menu/ccr-client.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { dataDir, configDir, usageDb, requestLogsDb, CONTRACT } from "../menu/ccr-client.mjs";

const R = path.join("X", "Roaming");            // a stand-in app-data base

test("default resolution: <app-data>/claude-code-router, and the databases sit inside it", () => {
  const env = { APPDATA: R };
  assert.equal(configDir(env), path.join(R, "claude-code-router"));
  assert.equal(dataDir(env), path.join(R, "claude-code-router"));
  assert.equal(usageDb(env), path.join(R, "claude-code-router", "usage.sqlite"));
  assert.equal(requestLogsDb(env), path.join(R, "claude-code-router", "request-logs.sqlite"));
});

test("data folder precedence: UW_CCR_DATA_DIR > CCR_INTERNAL_USER_DATA_DIR > the config folder", () => {
  const env = { UW_CCR_DATA_DIR: "T1", CCR_INTERNAL_USER_DATA_DIR: "T2", CCR_INTERNAL_APP_DATA_DIR: "T3", APPDATA: R };
  assert.equal(dataDir(env), path.resolve("T1"));
  assert.equal(dataDir({ ...env, UW_CCR_DATA_DIR: undefined }), path.resolve("T2"));
  assert.equal(dataDir({ ...env, UW_CCR_DATA_DIR: "", CCR_INTERNAL_USER_DATA_DIR: "  " }), path.join("T3", "claude-code-router"));
  assert.equal(usageDb({ UW_CCR_DATA_DIR: "T1" }), path.join(path.resolve("T1"), "usage.sqlite"));
  assert.equal(requestLogsDb({ CCR_INTERNAL_USER_DATA_DIR: "T2" }), path.join(path.resolve("T2"), "request-logs.sqlite"));
});

test("app-data base precedence: CCR_INTERNAL_APP_DATA_DIR > APPDATA > LOCALAPPDATA > USERPROFILE\\AppData\\Roaming", () => {
  const all = { CCR_INTERNAL_APP_DATA_DIR: "S", APPDATA: "A", LOCALAPPDATA: "L", USERPROFILE: "U" };
  assert.equal(configDir(all), path.join("S", "claude-code-router"));
  assert.equal(configDir({ ...all, CCR_INTERNAL_APP_DATA_DIR: " " }), path.join("A", "claude-code-router"));
  assert.equal(configDir({ ...all, CCR_INTERNAL_APP_DATA_DIR: "", APPDATA: "" }), path.join("L", "claude-code-router"));
  assert.equal(configDir({ USERPROFILE: "U" }), path.join("U", "AppData", "Roaming", "claude-code-router"));
});

test("a sandbox run never reads production: the router's own overrides beat APPDATA", () => {
  const sandbox = { CCR_INTERNAL_APP_DATA_DIR: path.join("SB", "appdata"), CCR_INTERNAL_USER_DATA_DIR: path.join("SB", "user"), APPDATA: R };
  assert.equal(dataDir(sandbox), path.resolve("SB", "user"));
  assert.equal(dataDir({ ...sandbox, CCR_INTERNAL_USER_DATA_DIR: undefined }), path.join("SB", "appdata", "claude-code-router"));
});

test("UW_CCR_DATA_DIR moves the data folder only, never the config folder", () => {
  assert.equal(configDir({ APPDATA: R, UW_CCR_DATA_DIR: "T" }), path.join(R, "claude-code-router"));
});

test("overrides are trimmed and normalised: trailing separator, forward slashes, surrounding blanks", () => {
  const want = path.resolve("C:/tmp/ccr");
  assert.equal(dataDir({ UW_CCR_DATA_DIR: "C:/tmp/ccr/" }), want);
  assert.equal(dataDir({ UW_CCR_DATA_DIR: `  ${path.resolve("C:/tmp/ccr")}${path.sep}  ` }), want);
  assert.equal(path.basename(usageDb({ UW_CCR_DATA_DIR: "C:/tmp/ccr/" })), "usage.sqlite");
});

test("a UNC override survives normalisation", { skip: process.platform !== "win32" }, () => {
  assert.equal(dataDir({ UW_CCR_DATA_DIR: "\\\\srv\\share\\ccr\\" }), "\\\\srv\\share\\ccr");
  assert.equal(usageDb({ UW_CCR_DATA_DIR: "\\\\srv\\share\\ccr" }), "\\\\srv\\share\\ccr\\usage.sqlite");
});

test("blank overrides are ignored; with no base at all the answer is null, never a cwd-relative path", () => {
  assert.equal(dataDir({ UW_CCR_DATA_DIR: "   ", APPDATA: "A" }), path.join("A", "claude-code-router"));
  assert.equal(dataDir({}), null);
  assert.equal(dataDir({ UW_CCR_DATA_DIR: "", CCR_INTERNAL_USER_DATA_DIR: "\t", APPDATA: " ", USERPROFILE: "" }), null);
  assert.equal(configDir({}), null);
  assert.equal(usageDb({}), null);
  assert.equal(requestLogsDb({}), null);
});

test("CONTRACT.dataDir / usageDb / requestLogsDb are getters over the live environment", () => {
  const desc = Object.getOwnPropertyDescriptor(CONTRACT, "usageDb");
  assert.equal(typeof desc.get, "function", "a getter, so Object.freeze does not pin it at import");
  const saved = process.env.UW_CCR_DATA_DIR;
  try {
    process.env.UW_CCR_DATA_DIR = path.resolve("Q");
    assert.equal(CONTRACT.dataDir, path.resolve("Q"));
    assert.equal(CONTRACT.usageDb, path.join(path.resolve("Q"), "usage.sqlite"));
    assert.equal(CONTRACT.requestLogsDb, path.join(path.resolve("Q"), "request-logs.sqlite"));
  } finally {
    if (saved === undefined) delete process.env.UW_CCR_DATA_DIR; else process.env.UW_CCR_DATA_DIR = saved;
  }
});

test("servicePath and the default data folder share one base, so they cannot disagree", () => {
  const { UW_CCR_DATA_DIR, CCR_INTERNAL_USER_DATA_DIR, ...rest } = process.env;
  assert.equal(path.dirname(CONTRACT.servicePath), dataDir(rest));
  assert.equal(path.dirname(CONTRACT.servicePath), configDir(rest));
});
