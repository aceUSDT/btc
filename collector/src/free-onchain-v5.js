const now=()=>new Date().toISOString();
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const CM='https://community-api.coinmetrics.io/v4';
const MEMPOOL='https://mempool.space/api';

async function getJson(url,timeoutMs=9000){
  const c=new AbortController();
  const tm=setTimeout(()=>c.abort(),timeoutMs);
  const started=Date.now();
  try{
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'BTC-Global-Intelligence/5.0'},signal:c.signal});
    const text=await r.text();
    if(!r.ok)throw new Error(`${r.status} ${url}: ${text.slice(0,180)}`);
    return{data:JSON.parse(text),latency_ms:Date.now()-started};
  }finally{clearTimeout(tm)}
}

async function coinMetrics(metric,days=45){
  const end=new Date().toISOString();
  const start=new Date(Date.now()-days*86400000).toISOString();
  const q=new URLSearchParams({assets:'btc',metrics:metric,frequency:'1d',start_time:start,end_time:end,page_size:String(Math.min(days+5,100)),paging_from:'end'});
  const r=await getJson(`${CM}/timeseries/asset-metrics?${q}`);
  const rows=(r.data?.data||[]).map(x=>({time:x.time,value:num(x[metric])})).filter(x=>x.value!==null).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  if(!rows.length)throw new Error(`Coin Metrics community metric unavailable: ${metric}`);
  return{metric,latest:rows.at(-1),history:rows,latency_ms:r.latency_ms};
}

async function safe(label,fn){try{return[label,{ok:true,...await fn()}]}catch(e){return[label,{ok:false,error:String(e)}]}}

export async function collectFreeOnchainV5(){
  const started=Date.now();
  const [mvrv,mvrvZ,marketCap,realizedCap,fees,mempool,difficulty,hashrate]=await Promise.all([
    safe('mvrv',()=>coinMetrics('CapMVRVCur',60)),
    safe('mvrv_z',()=>coinMetrics('CapMVRVZ',60)),
    safe('market_cap',()=>coinMetrics('CapMrktCurUSD',60)),
    safe('realized_cap',()=>coinMetrics('CapRealUSD',60)),
    safe('fees',async()=>({data:(await getJson(`${MEMPOOL}/v1/fees/recommended`)).data})),
    safe('mempool',async()=>({data:(await getJson(`${MEMPOOL}/mempool`)).data})),
    safe('difficulty',async()=>({data:(await getJson(`${MEMPOOL}/v1/difficulty-adjustment`)).data})),
    safe('hashrate',async()=>({data:(await getJson(`${MEMPOOL}/v1/mining/hashrate/1m`)).data}))
  ]);
  const r=Object.fromEntries([mvrv,mvrvZ,marketCap,realizedCap,fees,mempool,difficulty,hashrate]);
  const cap=num(r.market_cap?.latest?.value),real=num(r.realized_cap?.latest?.value);
  const derivedMvrv=cap&&real?cap/real:null;
  const successes=Object.values(r).filter(x=>x.ok).length;
  return{
    source:'coinmetrics-community+mempool.space',
    status:successes>=6?'LIVE':successes>=3?'PARTIAL':'UNAVAILABLE',
    observed_at:now(),
    latency_ms:Date.now()-started,
    valuation:{
      mvrv:num(r.mvrv?.latest?.value)??derivedMvrv,
      mvrv_direct:num(r.mvrv?.latest?.value),
      mvrv_derived_from_caps:derivedMvrv,
      mvrv_z:num(r.mvrv_z?.latest?.value),
      market_cap_usd:cap,
      realized_cap_usd:real,
      histories:{mvrv:r.mvrv?.history||[],mvrv_z:r.mvrv_z?.history||[],market_cap:r.market_cap?.history||[],realized_cap:r.realized_cap?.history||[]}
    },
    network:{
      recommended_fees:r.fees?.data||null,
      mempool:r.mempool?.data||null,
      difficulty_adjustment:r.difficulty?.data||null,
      hashrate_1m:r.hashrate?.data||null
    },
    failures:Object.fromEntries(Object.entries(r).filter(([,v])=>!v.ok).map(([k,v])=>[k,v.error])),
    integrity:{
      role:'free fallback for non-entity-adjusted on-chain/network context when Glassnode entitlement is absent',
      glassnode_gap:'Entity-adjusted SOPR/NUPL and LTH/STH cohort metrics are not fabricated from free sources.',
      mvrv:'If Coin Metrics CapMVRVCur is unavailable, MVRV is derived only as market-cap / realized-cap from the same source.',
      cadence:'valuation is daily; mempool/network fields can update faster'
    }
  };
}
