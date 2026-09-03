const get = async (u) => (await fetch(u, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 census/1.0' } })).json();

const p = await get('https://api.orcarouter.ai/api/pricing');
console.log('orcarouter top-level non-data keys:');
for (const k of Object.keys(p)) if (k !== 'data') console.log('  ', k, '=', JSON.stringify(p[k]).slice(0, 400));
const ft = p.data.filter(m => m.is_free_tier);
console.log('is_free_tier count =', ft.length);
console.log(JSON.stringify(ft.slice(0, 6), null, 1).slice(0, 2500));
const fb = p.data.filter(m => m.free_base_model);
console.log('free_base_model count =', fb.length, fb.slice(0, 10).map(m => m.model_name + '->' + m.free_base_model).join(' | '));
const tp = p.data.filter(m => m.timed_pricing || m.tiered_pricing || m.per_call_unit);
console.log('timed/tiered/per_call count =', tp.length, JSON.stringify(tp.slice(0, 2)).slice(0, 800));

const s = await get('https://api.orcarouter.ai/api/status');
const d = s.data;
console.log('\norcarouter status drop/promo fields:');
for (const k of Object.keys(d)) if (/drop|promo|signup|grant|boost|byok|quota|trial|checkin/i.test(k)) console.log('  ', k, '=', JSON.stringify(d[k]).slice(0, 300));

console.log('\ntokenrouter status extra:');
const t = (await get('https://api.tokenrouter.com/api/status')).data;
for (const k of Object.keys(t)) if (/drop|promo|signup|grant|quota|trial|checkin|price|group/i.test(k)) console.log('  ', k, '=', JSON.stringify(t[k]).slice(0, 300));

console.log('\ngroup_ratio maps (affects effective price):');
for (const [n, u] of Object.entries({ tokenrouter: 'https://api.tokenrouter.com/api/pricing', orcarouter: 'https://api.orcarouter.ai/api/pricing', bluesminds: 'https://api.bluesminds.com/api/pricing', agentrouter: 'https://agentrouter.org/api/pricing' })) {
  const j = await get(u);
  console.log(' ', n, 'group_ratio=', JSON.stringify(j.group_ratio), 'usable_group=', JSON.stringify(j.usable_group).slice(0, 250), 'user_group=', JSON.stringify(j.user_group));
}
console.log('\nnararouter usd_to_idr =', (await get('https://router.bynara.id/api/pricing')).usd_to_idr);
const nr = (await get('https://router.bynara.id/api/pricing')).data;
console.log('nara: free_for_paid true count =', nr.filter(m => m.free_for_paid).length);
console.log('nara: zero-priced count =', nr.filter(m => m.input_credit_per_1k === 0 && m.output_credit_per_1k === 0).length,
  nr.filter(m => m.input_credit_per_1k === 0 && m.output_credit_per_1k === 0).map(m => m.alias).join('|'));
console.log('nara: -free suffix but nonzero price =', nr.filter(m => /-free$/.test(m.alias) && (m.input_credit_per_1k > 0)).map(m => m.alias + ' in=' + m.input_credit_per_1k + ' minbal=' + m.free_min_balance + ' ffp=' + m.free_for_paid).join('\n   '));
