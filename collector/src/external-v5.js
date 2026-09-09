import { FRESHNESS_THRESHOLDS_MS, freshnessStatus } from './coverage.js';
import { collectCoinGlassV4, collectStablecoins, collectBlsActuals } from './external-v4.js';
import { collectPredictionMarkets, collectMacro, collectCrossAssets, collectNews, collectOnchain } from './external-intelligence.js';
import { collectOptionsV4 } from './options-v4.js';
import { collectGlassnodeV1 } from './glassnode-v1.js';
import { collectFearGreed } from './sentiment-v5.js';
import { collectFreeOnchainV5 } from './free-onchain-v5.js';

function mergeOnchain(primary,free,premium){
  const states=[primary?.status,free?.status,premium?.status];
  const status=states.includes('LIVE')?'LIVE':states.includes('PARTIAL')?'PARTIAL':states.includes('DELAYED')?'DELAYED':'UNAVAILABLE';
  return{
    ...(primary||{}),
    source:'multi-source-onchain',
    status,
    observed_at:new Date().toISOString(),
    premium_glassnode:premium||null,
    free_fallback:free||null,
    integrity:{
      ...(primary?.integrity||{}),
      hierarchy:'Glassnode entity/cohort metrics when entitled; Coin Metrics Community + mempool.space as free fallback; CoinGlass/Blockchain.com for exchange/network context.',
      no_synthetic_entity_metrics:true
    }
  };
}
function sourceDiag(k,v){
  const d={status:v?.status||'UNKNOWN',error:v?.error?String(v.error).slice(0,180):null};
  if(k==='coinglass'){
    d.required_ok=v?.coverage?.required_ok??null;
    d.required_total=v?.coverage?.required_total??null;
    const failures=v?.coverage?.optional_failures||{};
    d.failures=Object.fromEntries(Object.entries(failures).slice(0,8).map(([name,msg])=>[name,String(msg).slice(0,160)]));
  }
  return d;
}
function report(group,values){
  // Production-safe diagnostics: source/status/endpoint errors only; never credentials or raw payloads.
  console.log(JSON.stringify({type:'external_health',group,at:new Date().toISOString(),sources:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,sourceDiag(k,v)]))}));
}

export class ExternalV5Hub{
  constructor({getPrice}){this.getPrice=getPrice;this.state={};this.timers=[];this.running=false}
  async fast(){
    const p=Number(this.getPrice?.())||0;
    const[cg,opt,cross,stable]=await Promise.all([collectCoinGlassV4(p),collectOptionsV4(),collectCrossAssets(),collectStablecoins()]);
    this.state.coinglass=cg;this.state.options=opt;this.state.cross_asset=cross;this.state.stablecoins=stable;
    report('fast',{coinglass:cg,options:opt,cross_asset:cross,stablecoins:stable});
  }
  async medium(){
    const[pred,news,onchain,freeOnchain,glassnode,bls,sentiment]=await Promise.all([collectPredictionMarkets(),collectNews(),collectOnchain(),collectFreeOnchainV5(),collectGlassnodeV1(),collectBlsActuals(),collectFearGreed()]);
    this.state.prediction_markets=pred;
    this.state.news=news;
    this.state.onchain=mergeOnchain(onchain,freeOnchain,glassnode);
    this.state.bls=bls;
    this.state.sentiment=sentiment;
    report('medium',{prediction_markets:pred,news,onchain:this.state.onchain,free_onchain:freeOnchain,glassnode,bls,sentiment});
  }
  async slow(){this.state.macro=await collectMacro();report('slow',{macro:this.state.macro})}
  start(){if(this.running)return;this.running=true;void this.fast();void this.medium();void this.slow();this.timers.push(setInterval(()=>void this.fast(),Number(process.env.EXTERNAL_FAST_MS||30000)),setInterval(()=>void this.medium(),Number(process.env.EXTERNAL_MEDIUM_MS||120000)),setInterval(()=>void this.slow(),Number(process.env.EXTERNAL_SLOW_MS||300000)));for(const t of this.timers)t.unref?.()}
  stop(){for(const t of this.timers)clearInterval(t);this.timers=[];this.running=false}
  snapshot(){
    const out=structuredClone(this.state);
    for(const[k,v]of Object.entries(out)){
      if(!v?.observed_at)continue;
      const age=Date.now()-Date.parse(v.observed_at);
      const th=k==='onchain'?FRESHNESS_THRESHOLDS_MS.onchain:k==='sentiment'?36*60*60*1000:k==='prediction_markets'?FRESHNESS_THRESHOLDS_MS.prediction_market:k==='news'?FRESHNESS_THRESHOLDS_MS.news:k==='macro'||k==='bls'?FRESHNESS_THRESHOLDS_MS.macro_release:k==='options'?FRESHNESS_THRESHOLDS_MS.options:60000;
      v.age_ms=age;
      if(v.status==='LIVE')v.status=freshnessStatus(age,th);
    }
    return out;
  }
}
