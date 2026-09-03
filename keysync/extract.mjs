const get = async (u) => {
  const r = await fetch(u, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const statusHosts = {
  tokenrouter: 'https://api.tokenrouter.com/api/status',
  orcarouter: 'https://api.orcarouter.ai/api/status',
  bluesminds: 'https://api.bluesminds.com/api/status',
  agentrouter: 'https://agentrouter.org/api/status',
  seekai: 'https://seekai.cc/api/status',
  aihubmix: 'https://aihubmix.com/api/status',
};
console.log('##### /api/status  billing-relevant fields');
for (const [n, u] of Object.entries(statusHosts)) {
  const { status, json } = await get(u);
  if (!json || !json.data) { console.log(n, status, 'no data'); continue; }
  const d = json.data;
  const pick = {};
  for (const k of Object.keys(d)) {
    if (/quota|price|currency|checkin|topup|top_up|unit|display|rate|sign|group|usd|credit|balance|free|limit/i.test(k)) pick[k] = typeof d[k] === 'string' && d[k].length > 200 ? d[k].slice(0, 200) + '...' : d[k];
  }
  console.log('--', n, status, JSON.stringify(pick));
  console.log('   allkeys:', Object.keys(d).join(','));
}

console.log('\n##### /api/pricing  schemas + correct-free counts');
const pricing = {
  tokenrouter: 'https://api.tokenrouter.com/api/pricing',
  orcarouter: 'https://api.orcarouter.ai/api/pricing',
  bluesminds: 'https://api.bluesminds.com/api/pricing',
  agentrouter: 'https://agentrouter.org/api/pricing',
  nararouter: 'https://router.bynara.id/api/pricing',
};
for (const [n, u] of Object.entries(pricing)) {
  const { status, json } = await get(u);
  if (!json) { console.log(n, status, 'nojson'); continue; }
  const arr = json.data || [];
  const keys = new Set();
  arr.forEach(m => Object.keys(m).forEach(k => keys.add(k)));
  console.log('--', n, status, 'entries=' + arr.length, 'topkeys=' + Object.keys(json).join(','));
  console.log('   modelkeys:', [...keys].join(','));
  if ('quota_type' in (arr[0] || {})) {
    const free = arr.filter(m => (m.quota_type === 0 && m.model_ratio === 0) || (m.quota_type === 1 && m.model_price === 0));
    const naive = arr.filter(m => m.model_price === 0);
    console.log('   correct-free=' + free.length + ' naive-free=' + naive.length + '  freeIds=' + free.map(m => m.model_name).slice(0, 12).join('|'));
  } else {
    console.log('   sample:', JSON.stringify(arr[0]));
    console.log('   sample2:', JSON.stringify(arr.find(m => /free/i.test(JSON.stringify(m))) || {}).slice(0, 500));
  }
}

console.log('\n##### pollinations per_user_rpm / tier');
{
  const { json } = await get('https://gen.pollinations.ai/v1/models');
  const arr = json.data || [];
  const keys = new Set(); arr.forEach(m => Object.keys(m).forEach(k => keys.add(k)));
  console.log('models=' + arr.length, 'keys=' + [...keys].join(','));
  const withRpm = arr.filter(m => m.per_user_rpm != null);
  console.log('with per_user_rpm=' + withRpm.length, JSON.stringify(withRpm.slice(0, 3)));
  const free = arr.filter(m => m.pricing && Object.values(m.pricing).every(v => v === 'pollen' || Number(v) === 0));
  console.log('zero-pollen-price=' + free.length, free.slice(0, 8).map(m => m.id).join('|'));
}

console.log('\n##### venice traits/compat + model pricing keys');
{
  const { json } = await get('https://api.venice.ai/api/v1/models');
  const arr = json.data || [];
  console.log('venice models=' + arr.length, 'spec keys=' + Object.keys(arr[0].model_spec || {}).join(','));
  console.log('pricing sample=' + JSON.stringify(arr[0].model_spec?.pricing));
  const cons = arr.filter(m => m.model_spec?.constraints);
  console.log('with constraints=' + cons.length);
}
