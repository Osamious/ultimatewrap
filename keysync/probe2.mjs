const T = [
 ['openrouter','https://openrouter.ai/api/v1/activity'],
 ['openrouter','https://openrouter.ai/api/v1/keys'],
 ['openrouter','https://openrouter.ai/api/v1/auth/key'],
 ['deepseek','https://api.deepseek.com/user/balance'],
 ['deepseek','https://api.deepseek.com/v1/user/balance'],
 ['xai','https://api.x.ai/v1/api-key'],
 ['xai','https://api.x.ai/v1/language-models'],
 ['xai','https://management-api.x.ai/auth/users/me'],
 ['veniceai','https://api.venice.ai/api/v1/api_keys/rate_limits'],
 ['veniceai','https://api.venice.ai/api/v1/api_keys/rate_limits/log'],
 ['veniceai','https://api.venice.ai/api/v1/billing/usage'],
 ['veniceai','https://api.venice.ai/api/v1/api_keys'],
 ['anthropic','https://api.anthropic.com/v1/organizations/me'],
 ['anthropic','https://api.anthropic.com/v1/organizations/cost_report'],
 ['anthropic','https://api.anthropic.com/v1/organizations/usage_report/messages'],
 ['anthropic','https://api.anthropic.com/v1/organizations/api_keys'],
 ['openai','https://api.openai.com/v1/organization/usage/completions'],
 ['openai','https://api.openai.com/v1/organization/projects'],
 ['chutes','https://api.chutes.ai/users/me'],
 ['chutes','https://api.chutes.ai/users/me/quota_usage'],
 ['chutes','https://api.chutes.ai/quota_usage'],
 ['huggingface','https://huggingface.co/api/whoami-v2'],
 ['huggingface','https://router.huggingface.co/v1/credits'],
 ['huggingface','https://huggingface.co/api/billing/usage'],
 ['kilo','https://api.kilo.ai/api/gateway/key'],
 ['kilo','https://api.kilo.ai/api/gateway/credits'],
 ['kilo','https://api.kilo.ai/api/gateway/usage'],
 ['nousresearch','https://inference-api.nousresearch.com/v1/key'],
 ['nousresearch','https://inference-api.nousresearch.com/v1/credits'],
 ['nousresearch','https://inference-api.nousresearch.com/v1/auth/key'],
 ['zenmux','https://zenmux.ai/api/v1/key'],
 ['zenmux','https://zenmux.ai/api/v1/credits'],
 ['zenmux','https://zenmux.ai/api/v1/user/balance'],
 ['zenmux','https://zenmux.ai/api/v1/usage'],
 ['routllm','https://routllm.pro/v1/key'],
 ['routllm','https://routllm.pro/v1/user'],
 ['routllm','https://routllm.pro/api/user/self'],
 ['pollinations','https://gen.pollinations.ai/v1/usage'],
 ['pollinations','https://gen.pollinations.ai/v1/user'],
 ['pollinations','https://enter.pollinations.ai/api/user'],
 ['pollinations','https://gen.pollinations.ai/v1/pollen'],
 ['ollama','https://ollama.com/api/user'],
 ['ollama','https://ollama.com/api/me'],
 ['mistral','https://api.mistral.ai/v1/billing'],
 ['mistral','https://api.mistral.ai/v1/usage'],
 ['groq','https://api.groq.com/openai/v1/usage'],
 ['cerebras','https://api.cerebras.ai/v1/usage'],
 ['cerebras','https://api.cerebras.ai/v1/account'],
 ['tokenrouter','https://api.tokenrouter.com/v1/dashboard/billing/usage'],
 ['orcarouter','https://api.orcarouter.ai/v1/dashboard/billing/usage'],
 ['bluesminds','https://api.bluesminds.com/v1/dashboard/billing/usage'],
 ['agentrouter','https://agentrouter.org/v1/dashboard/billing/usage'],
 ['seekai','https://seekai.cc/v1/dashboard/billing/usage'],
 ['aihubmix','https://aihubmix.com/v1/dashboard/billing/usage'],
 ['agnes','https://apihub.agnes-ai.com/v1/dashboard/billing/usage'],
 ['tokenrouter','https://api.tokenrouter.com/api/user/self/groups'],
 ['orcarouter','https://api.orcarouter.ai/api/user/self/groups'],
 ['bluesminds','https://api.bluesminds.com/api/user/self/groups'],
 ['agentrouter','https://agentrouter.org/api/user/self/groups'],
 ['teamorouter','https://api.teamorouter.com/v1/key'],
 ['teamorouter','https://api.teamorouter.com/v1/credits'],
 ['teamorouter','https://api.teamorouter.com/v1/balance'],
 ['teamorouter','https://api.teamorouter.com/api/pricing'],
 ['tokenharbor','https://tokenharbor.ai/v1/key'],
 ['tokenharbor','https://tokenharbor.ai/v1/credits'],
 ['tokenharbor','https://tokenharbor.ai/v1/usage'],
 ['tokenharbor','https://tokenharbor.ai/api/pricing'],
 ['indeedwebid','https://ineed.web.id/v1/usage'],
 ['indeedwebid','https://ineed.web.id/v1/key'],
 ['indeedwebid','https://ineed.web.id/api/pricing'],
 ['gmicloudai','https://api.gmi-serving.com/v1/usage'],
 ['gmicloudai','https://api.gmi-serving.com/v1/account'],
 ['commandcode','https://api.commandcode.ai/provider/v1/credits'],
 ['commandcode','https://api.commandcode.ai/provider/v1/usage'],
 ['commandcode','https://api.commandcode.ai/provider/v1/balance'],
 ['opencode','https://opencode.ai/zen/v1/key'],
 ['opencode','https://opencode.ai/zen/v1/credits'],
 ['opencode','https://opencode.ai/zen/v1/usage'],
 ['aionlabs','https://api.aionlabs.ai/v1/credits'],
 ['aionlabs','https://api.aionlabs.ai/v1/key'],
 ['llm7','https://api.llm7.io/v1/usage'],
 ['llm7','https://api.llm7.io/v1/key'],
 ['llm7','https://api.llm7.io/v1/rate_limits'],
 ['sambanova','https://api.sambanova.ai/v1/usage'],
 ['nscale','https://inference.api.nscale.com/v1/usage'],
 ['fanar','https://api.fanar.qa/v1/usage'],
 ['nvidia','https://integrate.api.nvidia.com/v1/usage'],
 ['veniceai','https://api.venice.ai/api/v1/models/traits'],
];
let i = 0;
const out = [];
async function w() {
  while (i < T.length) {
    const [p, url] = T[i++];
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(url, { signal: c.signal, redirect: 'manual', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } });
      const b = (await r.text()).slice(0, 300).replace(/\s+/g, ' ');
      const rl = [...r.headers.keys()].filter(h => /ratelimit|retry-after|credit|quota|balance/i.test(h));
      out.push(p + '\t' + r.status + '\t' + url + '\t[' + rl.join(',') + ']\t' + b);
    } catch (e) {
      out.push(p + '\tERR\t' + url + '\t\t' + e.message);
    } finally { clearTimeout(t); }
  }
}
await Promise.all(Array.from({ length: 16 }, w));
out.sort();
console.log(out.join('\n'));
