import { COINGLASS_FUTURES_UNIVERSE, freshnessStatus, FRESHNESS_THRESHOLDS_MS } from './coverage.js';
import { collectDeribitOptions, collectPredictionMarkets, collectMacro, collectCrossAssets, collectNews, collectOnchain } from './external-intelligence.js';

const CG='https://open-api-v4.coinglass.com';
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const now=()=>new Date().toISOString();
const ms=v=>{const n=Number(v);return Number.isFinite(n)?n<1e12?n*1000:n:null};
const sum=a=>a.map(num).filter(v=>v!==null).reduce((x,y)=>x+y,0);
function qs(p={}){const q=new URLSearchParams();for(const[k,v]of Object.entries(p))if(v!==null&&v!==undefined&&v!=='')q.set(k,String(v));return q.toString()}
async function json(url,{headers={},method='GET',body=null,timeout=9000}={}){const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout),start=Date.now();try{const r=await fetch(url,{method,headers:{accept:'application/json',...headers},body:body?JSON.stringify(body):undefined,signal:c.signal});const t=await r.text();let d;try{d=JSON.parse(t)}catch{d={raw:t}}if(!r.ok)throw new Error(`${r.status} ${url}: ${t.slice(0,160)}`);return{data:d,latency_ms:Date.now()-start}}finally{clearTimeout(tm)}}
async function cg(path,p={}){const key=process.env.COINGLASS_API_KEY;if(!key)throw new Error('COINGLASS_API_KEY not configured');const r=await json(`${CG}${path}?${qs(p)}`,{headers:{'CG-API-KEY':key}});if(String(r.data?.code??'0')!=='0')throw new Error(`${path}: ${r.data?.msg||r.data?.code}`);return{data:r.data?.data,latency_ms:r.latency_ms}}
async function optional(name,fn){try{return[name,{ok:true,...await fn()}]}catch(e){return[name,{ok:false,error:String(e)}]}}
function cvdRows(rows=[]){return rows.map(x=>({t:ms(x.time??x.timestamp),delta:(num(x.agg_taker_buy_vol??x.taker_buy_vol)??0)-(num(x.agg_taker_sell_vol??x.taker_sell_vol)??0)})).filter(x=>x.t).sort((a,b)=>a.t-b.t)}
function rolling(rows,m){const c=Date.now()-m*60000-10000,a=rows.filter(x=>x.t>=c);return a.length?sum(a.map(x=>x.delta)):null}
function liq(rows=[],m){const c=Date.now()-m*60000-10000,a=rows.filter(x=>(ms(x.time??x.timestamp)||0)>=c);return{long_usd:sum(a.map(x=>x.aggregated_long_liquidation_usd??x.long_liquidation_usd)),short_usd:sum(a.map(x=>x.aggregated_short_liquidation_usd??x.short_liquidation_usd)),bars:a.length}}
function liquidationMap(data,price){const out=[];const root=data?.data?.data??data?.data??data??{};if(root&&typeof root==='object'&&!Array.isArray(root))for(const[k,v]of Object.entries(root)){const p=Number(k);if(!Number.isFinite(p)||!Array.isArray(v))continue;let n=0;const walk=z=>{if(Array.isArray(z)){if(z.length>=2&&Number.isFinite(Number(z[1])))n+=Math.abs(Number(z[1]));else z.forEach(walk)}};walk(v);if(n>0)out.push({price:p,notional_usd:n,distance_pct:price?(p-price)/price*100:null})}const a=out.filter(x=>!price||Math.abs(x.distance_pct)<15).sort((x,y)=>y.notional_usd-x.notional_usd);return{above:a.filter(x=>x.price>price)[0]||null,below:a.filter(x=>x.price<price)[0]||null,clusters:a.slice(0,50)}}
function heatmap(data){if(!data?.y_axis||!Array.isArray(data.liquidation_leverage_data))return null;const y=data.y_axis,rows=data.liquidation_leverage_data,by=new Map();for(const r of rows){const yi=Number(r[1]),n=Math.abs(Number(r[2]));const p=num(y[yi]);if(p&&Number.isFinite(n))by.set(p,(by.get(p)||0)+n)}return[...by].map(([price,estimated_notional_usd])=>({price,estimated_notional_usd})).sort((a,b)=>b.estimated_notional_usd-a.estimated_notional_usd).slice(0,100)}

export async function collectCoinGlassV4(price){
  const started=Date.now(),universe=COINGLASS_FUTURES_UNIVERSE.join(',');if(!process.env.COINGLASS_API_KEY)return{source:'coinglass_all_exchange',status:'UNAVAILABLE',observed_at:now(),error:'COINGLASS_API_KEY not configured'};
  const jobs={
    supported_futures:()=>cg('/api/futures/supported-exchanges'),
    supported_spot:()=>cg('/api/spot/supported-exchange-pairs'),
    market:()=>cg('/api/futures/coins-markets'),
    oi_exchange:()=>cg('/api/futures/open-interest/exchange-list',{symbol:'BTC'}),
    oi_history:()=>cg('/api/futures/open-interest/exchange-history-chart',{symbol:'BTC',range:'12h',unit:'usd'}),
    spot_cvd:()=>cg('/api/spot/aggregated-cvd/history',{exchange_list:universe,symbol:'BTC',interval:'1m',limit:70,unit:'usd'}),
    perp_cvd:()=>cg('/api/futures/aggregated-cvd/history',{exchange_list:universe,symbol:'BTC',interval:'1m',limit:70,unit:'usd'}),
    liquidation_history:()=>cg('/api/futures/liquidation/aggregated-history',{exchange_list:universe,symbol:'BTC',interval:'1m',limit:70}),
    liquidation_map:()=>cg('/api/futures/liquidation/aggregated-map',{symbol:'BTC',range:'1d'}),
    funding_oi:()=>cg('/api/futures/funding-rate/oi-weight-history',{symbol:'BTC',interval:'1h',limit:200}),
    funding_vol:()=>cg('/api/futures/funding-rate/vol-weight-history',{symbol:'BTC',interval:'1h',limit:200}),
    futures_orderbook:()=>cg('/api/futures/orderbook/aggregated-ask-bids-history',{exchange_list:'ALL',symbol:'BTC',interval:'1m',limit:10,range:'1'}),
    spot_orderbook:()=>cg('/api/spot/orderbook/aggregated-ask-bids-history',{exchange_list:'ALL',symbol:'BTC',interval:'1m',limit:10,range:'1'}),
    futures_large_orders:()=>cg('/api/futures/orderbook/large-limit-order',{symbol:'BTC'}),
    spot_large_orders:()=>cg('/api/spot/orderbook/large-limit-order',{symbol:'BTC'}),
    liquidation_heatmap:()=>cg('/api/futures/liquidation/aggregated-heatmap/model2',{symbol:'BTC',range:'24h'}),
    etf_us:()=>cg('/api/etf/bitcoin/flow-history'),
    etf_hk:()=>cg('/api/hk-etf/bitcoin/flow-history'),
    etf_assets:()=>cg('/api/etf/bitcoin/net-assets/history')
  };
  const entries=await Promise.all(Object.entries(jobs).map(([k,fn])=>optional(k,fn))),r=Object.fromEntries(entries),required=['market','spot_cvd','perp_cvd','oi_exchange','liquidation_history'],requiredOk=required.filter(k=>r[k]?.ok).length;
  const s=cvdRows(r.spot_cvd?.data||[]),p=cvdRows(r.perp_cvd?.data||[]),l=r.liquidation_history?.data||[],l1=liq(l,1),l5=liq(l,5),map=r.liquidation_map?.ok?liquidationMap(r.liquidation_map.data,price):{above:null,below:null,clusters:[]},mk=(r.market?.data||[]).find(x=>String(x.symbol).toUpperCase()==='BTC')||null;
  const fOi=(r.funding_oi?.data||[]).map(x=>num(x.close)).filter(x=>x!==null),sorted=[...fOi].sort((a,b)=>a-b),cur=fOi.at(-1)??null,percentile=cur===null||!sorted.length?null:sorted.filter(x=>x<=cur).length/sorted.length*100;
  const latest=a=>(a||[]).slice().sort((x,y)=>(ms(y.time??y.timestamp)||0)-(ms(x.time??x.timestamp)||0))[0]||null;
  const futuresSupported=Array.isArray(r.supported_futures?.data)?r.supported_futures.data:[];let spotSupported=[];if(r.supported_spot?.data&&typeof r.supported_spot.data==='object')spotSupported=Object.entries(r.supported_spot.data).filter(([,pairs])=>Array.isArray(pairs)&&pairs.some(x=>String(x.base_asset||'').toUpperCase()==='BTC')).map(([x])=>x);
  const failures=Object.fromEntries(Object.entries(r).filter(([,v])=>!v.ok).map(([k,v])=>[k,v.error]));
  return{source:'coinglass_all_exchange',status:requiredOk===required.length?'LIVE':requiredOk>=3?'PARTIAL':'UNAVAILABLE',observed_at:now(),latency_ms:Date.now()-started,coverage:{requested_futures:COINGLASS_FUTURES_UNIVERSE,supported_futures:futuresSupported,spot_btc_supported:spotSupported,required_ok:requiredOk,required_total:required.length,optional_failures:failures},market:mk,open_interest:{total_usd:num(mk?.open_interest_usd),exchange_rows:r.oi_exchange?.data||[],history:r.oi_history?.data||null},funding:{oi_weighted:num(mk?.avg_funding_rate_by_oi)??cur,volume_weighted:num(mk?.avg_funding_rate_by_vol),percentile_30d_proxy:percentile,oi_history:fOi,vol_history:(r.funding_vol?.data||[]).map(x=>num(x.close)).filter(x=>x!==null)},flow:{spot_cvd_1m:rolling(s,1),spot_cvd_5m:rolling(s,5),spot_cvd_15m:rolling(s,15),spot_cvd_1h:rolling(s,60),perp_cvd_1m:rolling(p,1),perp_cvd_5m:rolling(p,5),perp_cvd_15m:rolling(p,15),perp_cvd_1h:rolling(p,60)},liquidations:{long_1m_usd:l1.long_usd,short_1m_usd:l1.short_usd,long_5m_usd:l5.long_usd,short_5m_usd:l5.short_usd,velocity_usd_per_min:(l5.long_usd+l5.short_usd)/5,map,heatmap:r.liquidation_heatmap?.ok?heatmap(r.liquidation_heatmap.data):null},orderbook:{futures_1pct:latest(r.futures_orderbook?.data),spot_1pct:latest(r.spot_orderbook?.data),futures_large_orders:r.futures_large_orders?.data||[],spot_large_orders:r.spot_large_orders?.data||[]},etf:{us_latest:latest(r.etf_us?.data),hk_latest:latest(r.etf_hk?.data),net_assets_latest:latest(r.etf_assets?.data)}};
}

export async function collectStablecoins(){const started=Date.now();try{const [usdt,usdc,llama,chart]=await Promise.allSettled([json('https://api.exchange.coinbase.com/products/USDT-USD/ticker'),json('https://api.exchange.coinbase.com/products/USDC-USD/ticker'),json('https://stablecoins.llama.fi/stablecoins?includePrices=true'),json('https://stablecoins.llama.fi/stablecoincharts/all')]);const get=r=>r.status==='fulfilled'?r.value.data:null,coins=get(llama)?.peggedAssets||[],by=symbol=>coins.find(x=>String(x.symbol).toUpperCase()===symbol);return{source:'stablecoins',status:(get(usdt)||get(usdc)||coins.length)?'LIVE':'PARTIAL',observed_at:now(),latency_ms:Date.now()-started,pegs:{USDT:num(get(usdt)?.price),USDC:num(get(usdc)?.price)},supply:{USDT:by('USDT')||null,USDC:by('USDC')||null,total_history:(get(chart)||[]).slice(-90)}}}catch(e){return{source:'stablecoins',status:'UNAVAILABLE',observed_at:now(),error:String(e)}}}

export async function collectBlsActuals(){const started=Date.now();try{const y=new Date().getUTCFullYear(),series=['CUUR0000SA0','CUUR0000SA0L1E','CES0000000001','LNS14000000','WPUFD4'];const r=await json('https://api.bls.gov/publicAPI/v2/timeseries/data/',{method:'POST',headers:{'content-type':'application/json'},body:{seriesid:series,startyear:String(y-1),endyear:String(y),calculations:true,annualaverage:true}});const names={CUUR0000SA0:'cpi',CUUR0000SA0L1E:'core_cpi',CES0000000001:'payrolls',LNS14000000:'unemployment',WPUFD4:'ppi_final_demand'},out={};for(const s of r.data?.Results?.series||[]){const rows=(s.data||[]).filter(x=>x.period!=='M13');out[names[s.seriesID]||s.seriesID]={series_id:s.seriesID,latest:rows[0]||null,previous:rows[1]||null,rows:rows.slice(0,18)}}return{source:'bls_primary',status:Object.keys(out).length?'LIVE':'PARTIAL',observed_at:now(),latency_ms:Date.now()-started,actuals:out,consensus:{status:process.env.MACRO_CONSENSUS_API_KEY?'CONFIGURED_NOT_IMPLEMENTED':'UNAVAILABLE',reason:process.env.MACRO_CONSENSUS_API_KEY?'Provider adapter required':'Primary agencies do not publish market consensus; configure a licensed consensus provider.'}}}catch(e){return{source:'bls_primary',status:'UNAVAILABLE',observed_at:now(),error:String(e)}}}

export class ExternalV4Hub{
  constructor({getPrice}){this.getPrice=getPrice;this.state={};this.timers=[];this.running=false}
  async fast(){const price=Number(this.getPrice?.())||0;const[cg,opt,cross,stable]=await Promise.all([collectCoinGlassV4(price),collectDeribitOptions(),collectCrossAssets(),collectStablecoins()]);this.state.coinglass=cg;this.state.options=opt;this.state.cross_asset=cross;this.state.stablecoins=stable}
  async medium(){const[pred,news,onchain,bls]=await Promise.all([collectPredictionMarkets(),collectNews(),collectOnchain(),collectBlsActuals()]);this.state.prediction_markets=pred;this.state.news=news;this.state.onchain=onchain;this.state.bls=bls}
  async slow(){this.state.macro=await collectMacro()}
  start(){if(this.running)return;this.running=true;void this.fast();void this.medium();void this.slow();this.timers.push(setInterval(()=>void this.fast(),Number(process.env.EXTERNAL_FAST_MS||30000)),setInterval(()=>void this.medium(),Number(process.env.EXTERNAL_MEDIUM_MS||120000)),setInterval(()=>void this.slow(),Number(process.env.EXTERNAL_SLOW_MS||300000)));for(const t of this.timers)t.unref?.()}
  stop(){for(const t of this.timers)clearInterval(t);this.timers=[];this.running=false}
  snapshot(){const out=structuredClone(this.state);for(const[k,v]of Object.entries(out)){if(!v?.observed_at)continue;const age=Date.now()-Date.parse(v.observed_at),th=k==='onchain'?FRESHNESS_THRESHOLDS_MS.onchain:k==='prediction_markets'?FRESHNESS_THRESHOLDS_MS.prediction_market:k==='news'?FRESHNESS_THRESHOLDS_MS.news:k==='macro'||k==='bls'?FRESHNESS_THRESHOLDS_MS.macro_release:60000;v.age_ms=age;if(v.status==='LIVE')v.status=freshnessStatus(age,th)}return out}
}
