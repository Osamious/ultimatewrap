const T = [
 ['veniceai','https://api.venice.ai/api/v1/billing/usage-history'],
 ['veniceai','https://api.venice.ai/api/v1/models/compatibility_mapping'],
 ['huggingface','https://huggingface.co/api/whoami-v2'],
 ['llm7','https://api.llm7.io/v1/balance'],
 ['openrouter','https://openrouter.ai/api/v1/credits'],
 ['openrouter','https://openrouter.ai/api/v1/key'],
 ['pollinations','https://enter.pollinations.ai/api/docs'],
 ['pollinations','https://gen.pollinations.ai/v1/models'],
 ['orcarouter','https://api.orcarouter.ai/v1/balance'],
 ['teamorouter','https://api.teamorouter.com/v1/usage'],
 ['chutes','https://api.chutes.ai/users/me'],
 ['bluesminds','https://api.bluesminds.com/api/ratio_config'],
 ['orcarouter','https://api.orcarouter.ai/api/pricing'],
 ['bluesminds','https://api.bluesminds.com/api/pricing'],
 ['seekai','https://seekai.cc/api/status'],
 ['aihubmix','https://aihubmix.com/api/status'],
 ['agentrouter','https://agentrouter.org/api/status'],
];
let i = 0;
const out = [];
async function w() {
  while (i < T.length) {
    const [p, url] = T[i++];
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch(url, { signal: c.signal, redirect: 'manual', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } });
      const b = await r.text();
      const hdrs = {};
      r.headers.forEach((v, k) => { hdrs[k] = v; });
      out.push('=== ' + p + '  ' + r.status + '  ' + url + '\nHEADERS: ' + JSON.stringify(hdrs) + '\nBODY[0:1500]: ' + b.slice(0, 1500).replace(/\s+/g, ' ') + '\nLEN=' + b.length);
    } catch (e) {
      out.push('=== ' + p + '  ERR  ' + url + '  ' + e.message);
    } finally { clearTimeout(t); }
  }
}
await Promise.all(Array.from({ length: 8 }, w));
console.log(out.join('\n\n'));
