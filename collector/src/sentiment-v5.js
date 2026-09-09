const now=()=>new Date().toISOString();
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};

async function getJson(url,timeoutMs=8000){
  const c=new AbortController();
  const tm=setTimeout(()=>c.abort(),timeoutMs);
  const started=Date.now();
  try{
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'BTC-Global-Intelligence/5.0'},signal:c.signal});
    const text=await r.text();
    if(!r.ok)throw new Error(`${r.status} ${url}: ${text.slice(0,160)}`);
    return{data:JSON.parse(text),latency_ms:Date.now()-started};
  }finally{clearTimeout(tm)}
}

export async function collectFearGreed(){
  const started=Date.now();
  try{
    const r=await getJson('https://api.alternative.me/fng/?limit=8&format=json');
    const rows=(r.data?.data||[]).map(x=>({
      value:num(x.value),
      classification:x.value_classification||null,
      timestamp:x.timestamp?new Date(Number(x.timestamp)*1000).toISOString():null,
      time_until_update_seconds:num(x.time_until_update)
    })).filter(x=>x.value!==null);
    const latest=rows[0]||null;
    const oneDay=rows[1]||null;
    const sevenDay=rows[7]||rows.at(-1)||null;
    const sourceAgeMs=latest?.timestamp?Date.now()-Date.parse(latest.timestamp):null;
    return{
      source:'alternative.me',
      status:sourceAgeMs!==null&&sourceAgeMs>36*60*60*1000?'STALE':'LIVE',
      observed_at:now(),
      latency_ms:Date.now()-started,
      index:latest,
      change_1d:latest&&oneDay?latest.value-oneDay.value:null,
      change_7d:latest&&sevenDay?latest.value-sevenDay.value:null,
      history:rows,
      methodology:{
        cadence:'daily',
        role:'slow sentiment / crowding context; never a standalone trade trigger',
        anti_double_count:'low weight because the index itself includes volatility and momentum already represented elsewhere in the engine',
        attribution:'Alternative.me Crypto Fear & Greed Index'
      }
    };
  }catch(e){
    return{source:'alternative.me',status:'UNAVAILABLE',observed_at:now(),latency_ms:Date.now()-started,error:String(e)};
  }
}
