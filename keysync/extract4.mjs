const g = async u => (await fetch(u, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } })).json();

let j = await g('https://api.kilo.ai/api/gateway/models');
let a = j.data;
const kf = a.filter(m => m.isFree);
console.log('KILO isFree=true count', kf.length, 'of', a.length);
console.log('  ids:', kf.map(m => m.id).join(' | '));
console.log('  kilo isFree AND nonzero price:', kf.filter(m => Number(m.pricing?.prompt) > 0).map(m => m.id + ':' + m.pricing.prompt).join(' | ') || '(none)');
console.log('  kilo zero-price but isFree false:', a.filter(m => !m.isFree && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0).map(m => m.id).slice(0, 20).join(' | '));
console.log('  kilo per_request_limits sample:', JSON.stringify(a.find(m => m.per_request_limits)?.per_request_limits));
console.log('  kilo sample free obj:', JSON.stringify(kf[0]).slice(0, 700));

j = await g('https://api.llm7.io/v1/models'); a = j.data;
console.log('\nLLM7 tiers:', JSON.stringify(a.reduce((o, m) => (o[m.tier] = (o[m.tier] || 0) + 1, o), {})));
console.log('  pricing_mode:', JSON.stringify(a.reduce((o, m) => (o[m.pricing_mode] = (o[m.pricing_mode] || 0) + 1, o), {})));
console.log('  sample:', JSON.stringify(a[0]).slice(0, 600));
console.log('  free-ish (all prices 0):', a.filter(m => m.pricing && Number(m.pricing.input || 0) === 0 && Number(m.pricing.output || 0) === 0).map(m => m.id + '[' + m.tier + ']').join(' | '));

j = await g('https://routllm.pro/v1/models'); a = j.data;
console.log('\nROUTLLM tier_required:', a.map(m => m.id + '=t' + m.tier_required + ' in=' + m.pricing?.input).join('\n  '));

j = await g('https://api.orcarouter.ai/v1/models'); a = j.data;
console.log('\nORCA /v1/models sample:', JSON.stringify(a.find(m => /free/.test(m.id)) || a[0]).slice(0, 700));
console.log('  request_unit values:', [...new Set(a.map(m => m.pricing?.request_unit).filter(Boolean))].join(','));

j = await g('https://inference-api.nousresearch.com/v1/models'); a = j.data;
const sv = a.filter(m => m.synthesizedFreeVariant);
console.log('\nNOUS synthesizedFreeVariant count', sv.length, sv.slice(0, 8).map(m => m.id).join(' | '));
console.log('  nous zero-price count', a.filter(m => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0).length);

j = await g('https://openrouter.ai/api/v1/models'); a = j.data;
console.log('\nOPENROUTER zero-price count', a.filter(m => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0).length,
  '| :free suffix count', a.filter(m => m.id.endsWith(':free')).length);
console.log('  zero-price WITHOUT :free suffix:', a.filter(m => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && !m.id.endsWith(':free')).map(m => m.id).join(' | '));
console.log('  per_request_limits sample:', JSON.stringify(a.find(m => m.per_request_limits)?.per_request_limits));

j = await g('https://zenmux.ai/api/v1/models'); a = j.data;
console.log('\nZENMUX zero-price:', a.filter(m => Number(m.pricings?.prompt) === 0 && Number(m.pricings?.completion) === 0).map(m => m.id).join(' | '));
