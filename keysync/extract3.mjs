const U = {
  zenmux: 'https://zenmux.ai/api/v1/models',
  routllm: 'https://routllm.pro/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  orcarouter: 'https://api.orcarouter.ai/v1/models',
  opencode: 'https://opencode.ai/zen/v1/models',
  huggingface: 'https://router.huggingface.co/v1/models',
  llm7: 'https://api.llm7.io/v1/models',
  ollama: 'https://ollama.com/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models',
  aionlabs: 'https://api.aionlabs.ai/v1/models',
  kilo: 'https://api.kilo.ai/api/gateway/models',
  sambanova: 'https://api.sambanova.ai/v1/models',
  chutes: 'https://llm.chutes.ai/v1/models',
  commandcode: 'https://api.commandcode.ai/provider/v1/models',
  veniceai: 'https://api.venice.ai/api/v1/models',
  aihubmix: 'https://aihubmix.com/v1/models',
  nousresearch: 'https://inference-api.nousresearch.com/v1/models',
};
const flat = (o, p = '', out = {}) => {
  for (const k of Object.keys(o || {})) {
    const v = o[k]; const kk = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, kk, out); else out[kk] = true;
  }
  return out;
};
for (const [n, u] of Object.entries(U)) {
  try {
    const r = await fetch(u, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } });
    const j = await r.json();
    const arr = j.data || j.models || [];
    const keys = new Set();
    arr.slice(0, 400).forEach(m => Object.keys(flat(m)).forEach(k => keys.add(k)));
    const pay = [...keys].filter(k => /pric|cost|free|tier|quota|rpm|limit|credit|usd|billing|plan|paid|rate/i.test(k));
    console.log('== ' + n + ' status=' + r.status + ' n=' + arr.length);
    console.log('   payment-relevant keys: ' + (pay.join(', ') || '(NONE)'));
  } catch (e) { console.log('== ' + n + ' ERR ' + e.message); }
}
