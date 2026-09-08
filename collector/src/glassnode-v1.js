const BASE='https://api.glassnode.com/v1/metrics';
const now=()=>new Date().toISOString();
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
async function fetchMetric(path,{interval='24h',days=90}={}){
  const key=process.env.GLASSNODE_API_KEY;if(!key)throw new Error('GLASSNODE_API_KEY not configured');
  const q=new URLSearchParams({a:'BTC',i:interval,s:String(Math.floor((Date.now()-days*86400000)/1000)),u:String(Math.floor(Date.now()/1000)),f:'json'});
  const c=new AbortController(),tm=setTimeout(()=>c.abort(),10000);try{const r=await fetch(`${BASE}${path}?${q}`,{headers:{'X-Api-Key':key,accept:'application/json'},signal:c.signal});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t}};if(!r.ok)throw new Error(`${r.status} ${path}: ${t.slice(0,180)}`);return Array.isArray(j)?j:[]}finally{clearTimeout(tm)}}
function latest(rows=[]){for(let i=rows.length-1;i>=0;i--){const v=rows[i]?.v??rows[i]?.o;if(v!==null&&v!==undefined)return{time:rows[i].t?new Date(Number(rows[i].t)*1000).toISOString():null,value:v}}return null}
async function optional(name,path,opts){try{const rows=await fetchMetric(path,opts);return[name,{status:'LIVE',latest:latest(rows),history:rows.slice(-120)}]}catch(e){return[name,{status:'UNAVAILABLE',error:String(e)}]}}
export async function collectGlassnodeV1(){
  if(!process.env.GLASSNODE_API_KEY)return{source:'glassnode',status:'UNAVAILABLE',observed_at:now(),error:'GLASSNODE_API_KEY not configured; premium entity-adjusted and cohort metrics are unavailable.'};
  const started=Date.now();const specs=[
    ['mvrv','/market/mvrv',{interval:'24h',days:365}],['mvrv_z','/market/mvrv_z_score',{interval:'24h',days:365}],['sth_mvrv','/market/mvrv_less_155',{interval:'24h',days:365}],['lth_mvrv','/market/mvrv_more_155',{interval:'24h',days:365}],
    ['entity_mvrv','/indicators/mvrv_account_based',{interval:'24h',days:365}],['entity_sopr','/indicators/sopr_account_based',{interval:'24h',days:180}],['entity_nupl','/indicators/net_unrealized_profit_loss_account_based',{interval:'24h',days:365}],
    ['lth_supply','/supply/lth_sum',{interval:'24h',days:365}],['sth_supply','/supply/sth_sum',{interval:'24h',days:365}],['lth_net_change','/supply/lth_net_change',{interval:'24h',days:365}],['lth_sth_profit_loss','/supply/lth_sth_profit_loss_relative',{interval:'24h',days:180}],
    ['hash_rate','/mining/hash_rate_mean',{interval:'24h',days:90}],['difficulty','/mining/difficulty_latest',{interval:'24h',days:90}],['miner_outflow_multiple','/mining/miners_outflow_multiple',{interval:'24h',days:180}],['miner_unspent_supply','/mining/miners_unspent_supply',{interval:'24h',days:180}],['thermocap','/mining/thermocap',{interval:'24h',days:365}]
  ];
  const entries=await Promise.all(specs.map(([n,p,o])=>optional(n,p,o))),metrics=Object.fromEntries(entries),live=Object.values(metrics).filter(x=>x.status==='LIVE').length;
  return{source:'glassnode',status:live===specs.length?'LIVE':live>=6?'PARTIAL':'UNAVAILABLE',observed_at:now(),latency_ms:Date.now()-started,metrics,summary:{mvrv:num(metrics.mvrv?.latest?.value),mvrv_z:num(metrics.mvrv_z?.latest?.value),sth_mvrv:num(metrics.sth_mvrv?.latest?.value),lth_mvrv:num(metrics.lth_mvrv?.latest?.value),entity_sopr:num(metrics.entity_sopr?.latest?.value),entity_nupl:num(metrics.entity_nupl?.latest?.value),lth_supply:num(metrics.lth_supply?.latest?.value),sth_supply:num(metrics.sth_supply?.latest?.value),lth_net_change:num(metrics.lth_net_change?.latest?.value),hash_rate:num(metrics.hash_rate?.latest?.value),difficulty:num(metrics.difficulty?.latest?.value),miner_outflow_multiple:num(metrics.miner_outflow_multiple?.latest?.value)},integrity:{source:'Glassnode API',entity_adjusted:'Entity-adjusted MVRV/SOPR/NUPL are preferred when entitlement allows.',cadence:'On-chain metrics are slower regime context and never treated as tick-level signals.'}}
}
