// #114: provider text is redacted before it is stored and again when it is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactMessage } from "../menu/redact.mjs";

const SECRET_LIKE = [
  /\d{4}\w{2}\*{3,}/, /\bsk-[A-Za-z0-9]/, /https?:\/\//, /\.(com|ai|io)\b/, /@\w+\.\w+/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-/, /Bearer\s+\w/,
];
const clean = (s) => SECRET_LIKE.every((re) => !re.test(s));

test("the real sambanova sentence keeps its words and loses the masked key", () => {
  const out = redactMessage("sambanova: Incorrect API key provided: 7f3a9c*****e21d.");
  assert.equal(out, "sambanova: Incorrect API key provided: [masked-key].");
  assert.ok(!out.includes("7f3a9c") && !out.includes("e21d"));
});

test("URLs, domain/path links and bare hostnames become [url]; the sentence around them stays", () => {
  assert.equal(redactMessage("Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints."),
    "Your Go plan doesn't include API access. Upgrade to Provider or higher at [url] to use these endpoints.");
  assert.equal(redactMessage("Check the model ID at https://aihubmix.com/models?x=1&y=2, try again"), "Check the model ID at [url], try again");
  assert.equal(redactMessage("You can find it at platform.openai.com/account/api-keys"), "You can find it at [url]");
  assert.equal(redactMessage("see example.com for details"), "see [url] for details");
  assert.equal(redactMessage("head to: https://ai.google.dev/gemini-api/docs/rate-limits."), "head to: [url].");
});

test("credential shapes: sk-, provider prefixes, Bearer, key=value, raw long tokens", () => {
  for (const s of ["Incorrect API key provided: sk-proj-abc123DEF456ghi789", "key gsk_1234567890abcdef1234", "hf_abcdEFGH1234ijklMNOP was rejected",
                   "nvapi-1234567890abcdefgh", "Authorization: Bearer eyJhbGciOi.abc123.def456", "api_key=abcd1234efgh5678", "token: abcd1234efgh",
                   "AIzaSyA1234567890abcdefghijklmnopqrstu"]) {
    const out = redactMessage(s);
    assert.match(out, /\[(key|masked-key|id)\]/, `${s} -> ${out}`);
    assert.ok(!/abc123DEF456ghi789|1234567890abcdef|eyJhbGciOi|abcd1234efgh|AIzaSyA1234/.test(out), out);
  }
});

test("identifiers: UUIDs and long request ids are labelled, e-mail addresses too", () => {
  assert.equal(redactMessage("Insufficient Balance (request_id: 08cade87-e9e3-4bce-98d2-bda5e9a90298)"), "Insufficient Balance (request_id: [id])");
  assert.equal(redactMessage("No available channel for model x under group default (request id: 202609291244402094605388268d9d64Tzhgrq"),
    "No available channel for model x under group default (request id: [id]");
  assert.equal(redactMessage("user bob.smith@example.com is blocked"), "user [email] is blocked");
});

test("what a later reader needs survives: model ids, prices, plain sentences, ordinary words with colons", () => {
  for (const s of [
    "The model `gpt-4o-mini-audio-preview-2024-12-17` does not exist or you do not have access to it.",
    "Model qwen3.5-397b-a17b not found", "This model cannot use part of your gift balance, remaining eligible quota: $-0.41",
    "Invalid token: expired", "max tokens: 96", "Insufficient Balance", "Upstream request failed.", "no complete answer within 35000 ms; first token at 20187 ms",
    "The model deepseek-v4.1-flash-free cannot be served at the moment", "hf-internal-testing is not a valid model", "Please top up your balance and try again in a few minutes.",
  ]) assert.equal(redactMessage(s), s, s);
});

test("hostile input: controls and invisible characters cannot hide a secret from the patterns", () => {
  assert.ok(clean(redactMessage("sk-\x00abcdefgh12345")), "a NUL inside the key");
  assert.ok(!redactMessage("sk-\u200babcdefgh12345").includes("abcdefgh"), "a zero-width space inside the key");
  assert.ok(!redactMessage("http\u202e://evil.example.com/a").includes("evil"), "a bidi override inside a scheme");
  assert.ok(!redactMessage("\x1b[31m7f3a9c*****e21d\x1b[0m").includes("7f3a9c"));
  const out = redactMessage("\x1b]0;pwned\x07bad\u202Etxt\u200b\x00 end");
  assert.equal(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e]/.test(out), false);
  assert.equal(redactMessage(null), ""); assert.equal(redactMessage(undefined), "");
  assert.equal(redactMessage(42), "42");
});

test("redaction is idempotent, and safe on very large or pathological input", () => {
  const s = "sambanova: Incorrect API key provided: 7f3a9c*****e21d. See https://x.ai/keys, sk-abcdefgh1234 bob@x.io " + "a".repeat(200);
  assert.equal(redactMessage(redactMessage(s)), redactMessage(s));
  const t0 = performance.now();
  redactMessage("a.".repeat(20000) + "b".repeat(50000) + "*".repeat(20000));
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});

test("a realistic mix from the study stays readable and clean", () => {
  const real = [
    "sambanova: Incorrect API key provided: 7f3a9c*****e21d.",
    "commandcode: Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
    "tokenrouter: This model cannot use part of your gift balance, remaining eligible quota: ＄-0.410084, required pre-deduction amount: ＄0.000022 (request id: 20260929142423629508442xJ1FGP4Y)",
    "google: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
  ];
  for (const r of real) { const o = redactMessage(r); assert.ok(clean(o), o); assert.ok(o.length > 20, o); }
});

// ------------------------------------------------- the reviewer's false negatives

const gone = (s, ...frags) => { const out = redactMessage(s); for (const f of frags) assert.ok(!out.includes(f), `${JSON.stringify(f)} survived in ${JSON.stringify(out)}`); return out; };

test("a JWT is masked whole: header, payload AND signature", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  gone(`Invalid token ${jwt} for this workspace`, "eyJhbGci", "eyJzdWIi", "dozjgNry", "THsR8U");
  gone(`Bearer ${jwt}`, "eyJzdWIi", "dozjgNry");
  gone(`{"token":"${jwt}"}`, "eyJzdWIi", "dozjgNry");
  assert.equal(redactMessage(`rejected: ${jwt}.`), "rejected: [key].");
});

test("letters-only keys are masked when the shape says key", () => {
  gone("Incorrect API key provided: hf_abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop");
  gone("Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx", "abcdefghijklmnop");
  gone("bad key gsk_abcdefghijkl", "abcdefghijkl");
  gone("key ghp_abcdefghijklmnop", "abcdefghijklmnop");
  gone('api_key: "abcdefghijkl"', "abcdefghijkl");
  gone("api_key=abcdefghijkl", "abcdefghijkl");
  gone('{"api_key":"abcdefghijklmnop"}', "abcdefghijklmnop");
  gone('{"secret": "abcdefghijklmnop"}', "abcdefghijklmnop");
  gone('password = "hunter2hunter2"', "hunter2");
  gone('{"token":"abcdefghijklmnopqrstuv"}', "abcdefghijklmnop");
  gone("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnop");
  gone("AKIAIOSFODNN7EXAMPLE was rejected", "IOSFODNN7");
});

test("bullet and ellipsis masks are masked, however the provider elides the middle", () => {
  gone("Incorrect API key provided: sk-abc••••wxyz", "wxyz", "sk-abc");
  gone("Incorrect API key provided: sk-abc●●●●wxyz", "wxyz");
  gone("Incorrect API key provided: sk-abcd...wxyz", "wxyz", "sk-abcd");
  gone("Incorrect API key provided: 7f3a9c…e21d", "7f3a9c", "e21d");
  gone("Incorrect API key provided: 7f3a9c...e21d.", "7f3a9c", "e21d");
  gone("key sk_live_abcd****wxyz", "wxyz");
});

test("request ids of the common providers are labelled", () => {
  assert.equal(redactMessage("overloaded_error (request_id: req_011CSxYz1234567890abcdef)"), "overloaded_error (request_id: [id])");
  gone("error from chatcmpl-9Abc123def456ghi789", "9Abc123def");
  gone("msg_01XFDUDYJgAACzvnptvVoYEL failed", "XFDUDYJg");
  gone("resp_68abc123def456abc123", "68abc123");
});

test("what must survive still does, after the new rules", () => {
  for (const s of [
    "hf-internal-testing is not a valid model", "Invalid token: expired", "token: expired", "loading...done", "wait... what happened",
    "sk-turbo is not available", "gen-ai models are listed at the provider", "The message was rejected", "request_id is required",
    "Rate limit reached for model gpt-4o in organization org-abc on requests per min", "Model qwen3.5-397b-a17b not found",
    "The model `gpt-4o-mini-audio-preview-2024-12-17` does not exist or you do not have access to it.",
    "Insufficient Balance", "no complete answer within 240000 ms; first token at 20187 ms", "password required", "secret is missing",
    "authorization failed", "API key not provided", "the token limit is 8192",
  ]) assert.equal(redactMessage(s), s, s);
});

test("idempotent over every sample above, so a second --redact only changes what is newly matched", () => {
  const samples = [
    "sambanova: Incorrect API key provided: 7f3a9c*****e21d.", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    'api_key: "abcdefghijkl" at https://x.ai/keys by bob@x.io req_011CSxYz1234567890abcdef', "sk-abc••••wxyz and 7f3a9c…e21d", "hf_abcdefghijklmnopqrstuvwxyz",
  ];
  for (const s of samples) { const once = redactMessage(s); assert.equal(redactMessage(once), once, s); }
});

test("pathological 10,000-character inputs finish quickly (the input is bounded and no rule backtracks badly)", () => {
  const n = 10_000;
  const shapes = {
    dots: "a.".repeat(n / 2), hostname: "a-b.".repeat(n / 4) + "com", stars: "*".repeat(n), bullets: "•".repeat(n), ellipsis: "a...".repeat(n / 4),
    prefix: "sk-" + "a".repeat(n), underscore: "hf_" + "a1".repeat(n / 2), jwt: "eyJ" + "a.".repeat(n / 2), keyed: 'api_key: "'.repeat(n / 10),
    quotes: '"token":"'.repeat(n / 9), digits: "1".repeat(n), spaces: " ".repeat(n), mixed: "a1b2.".repeat(n / 5), http: "http://".repeat(n / 7),
    at: "a@".repeat(n / 2), req: "req_".repeat(n / 4), bearer: "Bearer ".repeat(n / 7), star_run: "a*".repeat(n / 2), uuid: "0123456789abcdef-".repeat(n / 17),
  };
  for (const [name, s] of Object.entries(shapes)) {
    const t0 = performance.now();
    const out = redactMessage(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${name}: ${Math.round(ms)} ms`);
    assert.equal(typeof out, "string");
    const t1 = performance.now();
    assert.equal(redactMessage(out), out, `${name}: not idempotent`);
    assert.ok(performance.now() - t1 < 250, `${name} (second pass)`);
  }
});

// ------------------------------------------------- second review: the remaining gaps

test("case, fullwidth forms and whitespace controls cannot hide a key", () => {
  gone("bad key SK-ABCDEFGH12345678", "ABCDEFGH1234");
  gone("bad key Sk-abcdefghijklmnopqrstuvwx", "abcdefghijkl");
  gone("bad key sk-ａｂｃｄｅｆ1234567890abcdef", "1234567890abcdef");           // fullwidth letters fold under NFKC
  gone("Bearer\tabcdef1234567890", "abcdef1234567890");
  gone("api_key:\nabcdefghijkl", "abcdefghijkl");
});

test("x-runs and truncated masks: masked when they sit inside a token, left alone as plain text", () => {
  gone("Incorrect API key provided: sk-abcdXXXXXXXXwxyz", "wxyz", "sk-abcd");
  gone("key 7f3a9cxxxxxxxxe21d", "e21d");
  assert.equal(redactMessage("x".repeat(200)), "x".repeat(200), "a bare run of x's is just text");
  assert.equal(redactMessage("XXXXXXXX"), "XXXXXXXX");
  gone("Incorrect API key provided: 7f3a9c*", "7f3a9c");                            // a `p` cut off by the 40-character clip mid-mask
  assert.equal(redactMessage("the wildcard * is not allowed"), "the wildcard * is not allowed");
});

test("digit-only request and trace ids, and account-shaped ids, are labelled", () => {
  assert.equal(redactMessage("(request id: 20260929124634209460538826)"), "(request id: [id])");
  assert.equal(redactMessage("model x (tid: 2026092913012297768875872534966)"), "model x (tid: [id])");
  gone("org-abcdef1234567890abcd rejected", "abcdef1234567890");
  gone("acct_1234567890abcdef", "1234567890abcdef");
  gone("fw_abcdefghijklmnopqrst", "abcdefghijklmnop");
  assert.equal(redactMessage("in organization org-abc on requests per min"), "in organization org-abc on requests per min");
  assert.equal(redactMessage("retry after 1790000000 ms is too long"), "retry after 1790000000 ms is too long", "ten digits is a number, not an id");
});

test("more hosts and IP addresses are masked; English words that look like a TLD are not", () => {
  assert.equal(redactMessage("see dashboard.example-corp.co/keys for details"), "see [url] for details");
  assert.equal(redactMessage("open acme.tech now"), "open [url] now");
  assert.equal(redactMessage("connect ECONNREFUSED 127.0.0.1:3456"), "connect ECONNREFUSED [ip]");
  assert.equal(redactMessage("upstream 10.0.0.5 said no"), "upstream [ip] said no");
  assert.equal(redactMessage("failed.to retry, done.in a minute"), "failed.to retry, done.in a minute");
  assert.equal(redactMessage("gpt-4.5 and qwen3.5-397b and v2.0.1"), "gpt-4.5 and qwen3.5-397b and v2.0.1");
});

test("an e-mail inside a URL leaves no stray bracket", () => {
  assert.equal(redactMessage("go to https://pay.example.com/topup?u=alice@example.com now"), "go to [url] now");
  assert.equal(redactMessage("write to alice@example.com."), "write to [email].");
});

test("links:false keeps links, hosts and addresses (an answer's content) but still masks credentials and ids", () => {
  const s = "See https://example.com/docs and bob@example.com, key sk-abcdefghijklmnopqrstuvwx, req_011CTbgXq2LmNv7Bc1Rt5Yw8";
  const out = redactMessage(s, { links: false });
  assert.match(out, /See https:\/\/example\.com\/docs and bob@example\.com, key \[key\], \[id\]/);
  assert.equal(redactMessage("10.0.0.5", { links: false }), "10.0.0.5");
});

test("idempotence and speed hold with the new rules too", () => {
  const s = "SK-ABCDEFGH12345678 10.0.0.5:8080 acme.tech/x org-abcdef1234567890abcd (tid: 2026092913012297768875872534966) 7f3a9c* sk-abcdXXXXXXXXwxyz";
  const once = redactMessage(s);
  assert.equal(redactMessage(once), once);
  for (const bad of ["1.".repeat(5000), "1.1.1.".repeat(2000), "9".repeat(10000), "a".repeat(9990) + "*", "xX".repeat(5000), ("a-".repeat(3000) + "com").repeat(2)]) {
    const t0 = performance.now(); redactMessage(bad);
    assert.ok(performance.now() - t0 < 250, `${bad.slice(0, 12)}...: ${Math.round(performance.now() - t0)} ms`);
  }
});

// ------------------------------------------------- round 2: hosts with a path, IPv6, clipping

import { redactClip } from "../menu/redact.mjs";

test("any host followed by a path or a port is a link, whatever its top-level domain; a bare 'failed.to retry' is not", () => {
  assert.equal(redactMessage("see dash.example.us/keys now"), "see [url] now");
  assert.equal(redactMessage("gw.corp.me:8443 refused"), "[url] refused");
  assert.equal(redactMessage("open panel.acme.sh/x?y=1."), "open [url].");
  assert.equal(redactMessage("failed.to retry, done.in a minute, e.g. this"), "failed.to retry, done.in a minute, e.g. this");
  assert.equal(redactMessage("meta/llama-3.1-8b-instruct and qwen3.5-397b/x"), "meta/llama-3.1-8b-instruct and qwen3.5-397b/x");
});

test("IPv6 addresses are masked (full and compressed); clock times and plain colons are not", () => {
  assert.equal(redactMessage("connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 failed"), "connect to [ip] failed");
  assert.equal(redactMessage("upstream fe80::1 said no"), "upstream [ip] said no");
  assert.equal(redactMessage("upstream 2001:db8::ff00:42:8329 said no"), "upstream [ip] said no");
  assert.equal(redactMessage("ECONNREFUSED [::1]:3456"), "ECONNREFUSED [ip]", "the port that followed the address goes with it");
  for (const s of ["at 12:30:45 UTC", "ratio 3:2:1", "error: code: 42", "key: value: other"]) assert.equal(redactMessage(s), s, s);
});

test("redactClip clips AFTER redacting and never leaves half a label at the end", () => {
  const s = "Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.";
  const c = redactClip(s, 40);
  assert.equal(c, "Upgrade to Provider or higher at [url] t");
  // a clip that lands inside a label drops the fragment: 'Upgrade to Provider or higher at' + '[ur'
  const cut = redactClip("Upgrade to Provider or higher at https://commandcode.ai/billing", 35);
  assert.equal(cut, "Upgrade to Provider or higher at", cut);
  assert.equal(/\[[a-z-]*$/.test(redactClip("x".repeat(30) + " key 7f3a9c*****e21d", 40)), false);
  assert.equal(redactClip("plain sentence", 40), "plain sentence");
  assert.equal(redactClip("a [b] c", 40), "a [b] c", "a complete bracket group is not touched");
  assert.equal(redactClip(null, 40), "");
});

test("the speed and idempotence checks hold with the new host and IPv6 rules", () => {
  for (const bad of ["a.b.".repeat(2500), ("a:" .repeat(2500)), "1:".repeat(5000), ("ab:cd::".repeat(1400)), "http://".repeat(1400) + "a.b/", "x.y.z/".repeat(1600)]) {
    const t0 = performance.now(); const out = redactMessage(bad);
    assert.ok(performance.now() - t0 < 300, `${bad.slice(0, 10)}...: ${Math.round(performance.now() - t0)} ms`);
    assert.equal(redactMessage(out), out);
  }
});

// ------------------------------------------------- 120-character previews

import { PREVIEW_CHARS } from "../menu/bench-data.mjs";

test("a 120-character ok preview keeps its links and prose but masks a credential inside it", () => {
  assert.equal(PREVIEW_CHARS, 120);
  const p = "Sure! Details are at https://example.com/docs/hello and, for the record, the key sk-abcdefghijklmnopqrstuvwx is not mine ok.";
  const out = redactClip(p, PREVIEW_CHARS, { links: false });
  assert.match(out, /^Sure! Details are at https:\/\/example\.com\/docs\/hello and, for the record, the key \[key\] is not/);
  assert.ok([...out].length <= PREVIEW_CHARS);
  const nonOk = redactClip(p, PREVIEW_CHARS);
  assert.equal(/example\.com|sk-abcdef/.test(nonOk), false, "the head of a PROVIDER sentence loses its links too");
});

test("redaction of 120-character inputs is fast for every pathological shape", () => {
  const shapes = ["a.".repeat(60), "*".repeat(120), "sk-" + "a".repeat(117), "a...".repeat(30), "1.".repeat(60), "http://".repeat(17), "a@".repeat(60), "x.y.z/".repeat(20), "ab:cd::".repeat(17)];
  for (const s of shapes) {
    const t0 = performance.now(); const out = redactClip(s, PREVIEW_CHARS);
    assert.ok(performance.now() - t0 < 50, `${s.slice(0, 8)}...: ${performance.now() - t0} ms`);
    assert.equal(redactClip(out, PREVIEW_CHARS), out, "idempotent");
  }
});
