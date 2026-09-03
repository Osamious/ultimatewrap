const U = {
  zenmux: 'https://zenmux.ai/api/v1/models', routllm: 'https://routllm.pro/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models', orcarouter: 'https://api.orcarouter.ai/v1/models',
  opencode: 'https://opencode.ai/zen/v1/models', huggingface: 'https://router.huggingface.co/v1/models',
  llm7: 'https://api.llm7.io/v1/models', ollama: 'https://ollama.com/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models', aionlabs: 'https://api.aionlabs.ai/v1/models',
  kilo: 'https://api.kilo.ai/api/gateway/models', sambanova: 'https://api.sambanova.ai/v1/models',
  chutes: 'https://llm.chutes.ai/v1/models', commandcode: 'https://api.commandcode.ai/provider/v1/models',
  veniceai: 'https://api.venice.ai/api/v1/models', aihubmix: 'https://aihubmix.com/v1/models',
  nousresearch: 'https://inference-api.nousresearch.com/v1/models',
  pollinations: 'https://gen.pollinations.ai/v1/models',
  tokenrouter_pricing: 'https://api.tokenrouter.com/api/pricing',
  orcarouter_pricing: 'https://api.orcarouter.ai/api/pricing',
  nararouter_pricing: 'https://router.bynara.id/api/pricing',
  bluesminds_pricing: 'https://api.bluesminds.com/api/pricing',
  agentrouter_pricing: 'https://agentrouter.org/api/pricing',
};
console.log('#### rate-limit / quota headers on PUBLIC non-inference endpoints');
for (const [n, u] of Object.entries(U)) {
  try {
    const c=new AbortController(); const tm=setTimeout(()=>c.abort(),10000); const r = await fetch(u, { signal:c.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } }); clearTimeout(tm);
    const hit = [];
    r.headers.forEach((v, k) => { if (/ratelimit|rate-limit|retry-after|quota|credit|balance|x-chutes|remaining/i.test(k)) hit.push(k + '=' + v); });
    console.log(n.padEnd(22), r.status, hit.length ? hit.join(' ; ') : '(no quota/ratelimit headers)');
  } catch (e) { console.log(n, 'ERR', e.message); }
}
const j = await (await fetch('https://zenmux.ai/api/v1/models')).json();
console.log('\nzenmux sample model:', JSON.stringify(j.data[0]).slice(0, 900));
const zf = j.data.filter(m => JSON.stringify(m.pricings || {}).match(/"0(\.0+)?"|:0[,}]/));
console.log('zenmux candidates with a 0 in pricings:', zf.map(m => m.id).slice(0, 15).join(' | '));
console.log('zenmux free-suffixed:', j.data.filter(m => /free/i.test(m.id)).map(m => m.id + ' ' + JSON.stringify(m.pricings)).join('\n  '));
