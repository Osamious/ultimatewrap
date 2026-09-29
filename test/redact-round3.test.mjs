// Redaction, third pass: NFKC expansion, hyphen-form keys, bracketed IPv6 with a port, bare `token:` words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactMessage, redactClip } from "../menu/redact.mjs";

const gone = (s, ...frags) => { const out = redactMessage(s); for (const f of frags) assert.ok(!out.includes(f), `${JSON.stringify(f)} survived in ${JSON.stringify(out)}`); return out; };

test("the input bound is applied AGAIN after NFKC (compatibility characters expand: U+33C2 becomes four)", () => {
  const t0 = performance.now();
  const out = redactMessage("㏂".repeat(2048));
  assert.ok(performance.now() - t0 < 250, `${Math.round(performance.now() - t0)} ms for 2,048 expanding characters (was ~450 ms)`);
  assert.ok([...out].length <= 2048, `${[...out].length} characters out`);
  assert.equal(redactMessage(out), out, "idempotent");
  // a fullwidth key placed after the cut is dropped with the rest, one before it is still masked
  assert.equal(/sk-abcdefgh12345678/.test(redactMessage("ｓｋ-ａｂｃｄｅｆｇｈ12345678 tail")), false);
});

test("hyphen-form keys are masked like the underscore form (csk-, gsk-, ghp-, hf-), and organisations are not", () => {
  gone("bad key csk-abcdefghijklmnopqrstuvwx", "abcdefghijkl");
  gone("bad key csk-1a2b3c4d5e6f", "1a2b3c4d");
  gone("bad key gsk-abcdefghijklmnopqrstuvwx", "abcdefghijkl");
  gone("bad key ghp-abcdefghijklmnopqrstuvwx", "abcdefghijkl");
  gone("bad key hf-abcdefghijklmnopqrstuvwxyz", "abcdefghijkl");
  assert.equal(redactMessage("hf-internal-testing is not a valid model"), "hf-internal-testing is not a valid model");
  assert.equal(redactMessage("csk-turbo is offline"), "csk-turbo is offline", "a short letters-only word is not a key");
});

test("a bracketed IPv6 address takes its port with it; a bracketed time or a plain bracket is left alone", () => {
  assert.equal(redactMessage("ECONNREFUSED [::1]:3456"), "ECONNREFUSED [ip]");
  assert.equal(redactMessage("connect [2001:db8::1]:8080 failed"), "connect [ip] failed");
  assert.equal(redactMessage("connect [2001:0db8:85a3:0000:0000:8a2e:0370:7334]:443 failed"), "connect [ip] failed");
  assert.equal(redactMessage("upstream [fe80::1] said no"), "upstream [ip] said no");
  assert.equal(redactMessage("[12:30:45] request failed"), "[12:30:45] request failed");
  assert.equal(redactMessage("see [1] and [note]"), "see [1] and [note]");
  assert.equal(redactMessage("::1 refused"), "[ip] refused");
});

test("a bare word after `token:` is masked when it is a token (mixed letters and digits, or 20+ letters), and left when it is prose", () => {
  gone("token: abcdefghijklmnopqrstuv", "abcdefghijklmnop");
  gone('token = "abcdefghijklmnopqrstuvwxyz"', "abcdefghijklmnop");
  gone("Authorization: abcdefghijklmnopqrstuv", "abcdefghijklmnop");
  gone("token: a1b2c3d4e5f6g7", "a1b2c3d4");
  gone("token: abcd1234efgh", "abcd1234");
  for (const s of ["Invalid token: expired", "token: unavailable", "token: required", "the token: unauthorized", "token limit: 8192"]) assert.equal(redactMessage(s), s, s);
});

test("speed and idempotence still hold on 10,000-character inputs with the new rules", () => {
  for (const bad of ["[".repeat(10000), "[::".repeat(3300), "[a:".repeat(3300), "csk-".repeat(2500), "token:".repeat(1600), "token: ".repeat(1400) + "a".repeat(100), "㏂".repeat(5000)]) {
    const t0 = performance.now(); const out = redactMessage(bad);
    assert.ok(performance.now() - t0 < 300, `${bad.slice(0, 6)}...: ${Math.round(performance.now() - t0)} ms`);
    assert.equal(redactMessage(out), out);
    assert.ok(redactClip(bad, 120).length <= 120);
  }
});
