const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const sign=v=>!Number(v)?0:Number(v)>0?1:-1;
const pct=(a,b)=>a&&b?((a-b)/b)*100:null;

function quantile(values,q){const a=values.map(num).filter(x=>x!==null).sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*q,l=Math.floor(i),h=Math.ceil(i);return l===h?a[l]:a[l]+(a[h]-a[l])*(i-l)}
function sourceWeight(source,base=1){if(!source)return base*.35;if(source.status==='LIVE')return base;if(source.status==='DELAYED')return base*.75;if(source.status==='PARTIAL')return base*.55;if(source.status==='STALE')return base*.35;return base*.2}

export class SignalEngine {
  constructor({maxHistory=172800}={}){this.history=[];this.maxHistory=maxHistory;this.lastAlertKey=null;this.lastSetupKey=null}
  ingest(core){if(!core?.price)return;const item={t:Date.now(),p:Number(core.price),oi:num(core.open_interest_usd),spot:num(core.spot?.m5?.delta_usd),perp:num(core.perp?.m5?.delta_usd),funding:num(core.funding_oi_weighted)};const prev=this.history.at(-1);if(prev&&item.t-prev.t<800)return;this.history.push(item);if(this.history.length>this.maxHistory)this.history.splice(0,this.history.length-this.maxHistory)}
  _since(ms){const c=Date.now()-ms;return this.history.filter(x=>x.t>=c)}
  _structure(price){const windows={m5:5*60e3,m15:15*60e3,h1:60*60e3,h4:4*60*60e3,d1:24*60*60e3};const out={};for(const[k,ms]of Object.entries(windows)){const rows=this._since(ms),ps=rows.map(x=>x.p);out[k]={open:rows[0]?.p??price,high:ps.length?Math.max(...ps):price,low:ps.length?Math.min(...ps):price,close:price,change_pct:rows.length?pct(price,rows[0].p):null}}const h1=this._since(60*60e3),rets=[];for(let i=1;i<h1.length;i++)rets.push(Math.abs(pct(h1[i].p,h1[i-1].p)||0));const noise=quantile(rets,.75)||.01,h4=out.h4,pos=h4.high>h4.low?(price-h4.low)/(h4.high-h4.low):.5;let trend='RANGE';if((out.h1.change_pct||0)>Math.max(.25,noise*8)&&pos>.68)trend='TREND_UP';else if((out.h1.change_pct||0)<-Math.max(.25,noise*8)&&pos<.32)trend='TREND_DOWN';const prior4=this._since(4*60*60e3).filter(x=>x.t<Date.now()-60e3).map(x=>x.p),priorHigh=prior4.length?Math.max(...prior4):null,priorLow=prior4.length?Math.min(...prior4):null,breakout=priorHigh&&price>priorHigh?'BREAKOUT_UP':priorLow&&price<priorLow?'BREAKOUT_DOWN':null;return{...out,position_4h:pos,trend,breakout,noise_1s_pct_q75:noise,psych_levels:{below:Math.floor(price/1000)*1000,above:Math.ceil(price/1000)*1000}}}
  evaluate(core,external={}){
    this.ingest(core);const price=num(core?.price);if(!price)return{preferred_action:'NO_TRADE',reason:'NO_PRICE'};
    const structure=this._structure(price),cg=external?.coinglass||{},options=external?.options||{},macro=external?.macro||{},cross=external?.cross_asset||{},pred=external?.prediction_markets||{},news=external?.news||{},onchain=external?.onchain||{};
    const cgFlow=cg?.flow||{},liq=cg?.liquidations||{},funding=cg?.funding||{},spot5=num(cgFlow.spot_cvd_5m)??num(core?.spot?.m5?.delta_usd)??0,perp5=num(cgFlow.perp_cvd_5m)??num(core?.perp?.m5?.delta_usd)??0,oi=num(cg?.open_interest?.total_usd)??num(core?.open_interest_usd),hist5=this._since(5*60e3),oiOld=hist5[0]?.oi,oiDelta=oi&&oiOld?pct(oi,oiOld):null,fundPct=num(funding.percentile),longLiq=num(liq.long_5m_usd),shortLiq=num(liq.short_5m_usd),above=num(liq?.map?.above?.price),below=num(liq?.map?.below?.price);

    const now=new Date(),utcHour=now.getUTCHours()+now.getUTCMinutes()/60,usCash=utcHour>=13.5&&utcHour<=21;
    const dynamicWeights={
      structure:structure.trend==='RANGE'?.85:1.15,
      spot_flow:sourceWeight(cg,1.25),
      perp_flow:sourceWeight(cg,1.0),
      open_interest:sourceWeight(cg,1.0),
      funding:sourceWeight(cg,.8),
      liquidations:sourceWeight(cg,1.15),
      etf:sourceWeight(cg,usCash?1.25:.9),
      options:sourceWeight(options,num(options?.dvol)>70?1.15:.9),
      macro:sourceWeight(macro,1.0),
      cross_asset:sourceWeight(cross,1.0),
      onchain:sourceWeight(onchain,.6),
      prediction_markets:sourceWeight(pred,.45),
      news:sourceWeight(news,.8)
    };

    const families={};let bull=0,bear=0,totalCapacity=0;
    const add=(name,b,br,why)=>{const w=dynamicWeights[name]??1,bb=b*w,rr=br*w;families[name]={bull:bb,bear:rr,raw_bull:b,raw_bear:br,weight:w,why};bull+=bb;bear+=rr;totalCapacity+=20*w};
    if(structure.trend==='TREND_UP')add('structure',18,2,'1h/4h price structure trends higher');else if(structure.trend==='TREND_DOWN')add('structure',2,18,'1h/4h price structure trends lower');else add('structure',7,7,'price remains range-like');if(structure.breakout==='BREAKOUT_UP'){families.structure.bull+=7*dynamicWeights.structure;bull+=7*dynamicWeights.structure;families.structure.why+='; 4h breakout up'}if(structure.breakout==='BREAKOUT_DOWN'){families.structure.bear+=7*dynamicWeights.structure;bear+=7*dynamicWeights.structure;families.structure.why+='; 4h breakout down'}
    if(spot5>0)add('spot_flow',16,2,'aggregated spot CVD positive');else if(spot5<0)add('spot_flow',2,16,'aggregated spot CVD negative');else add('spot_flow',4,4,'spot CVD neutral/unavailable');if(perp5>0)add('perp_flow',10,2,'perp CVD positive');else if(perp5<0)add('perp_flow',2,10,'perp CVD negative');else add('perp_flow',3,3,'perp CVD neutral/unavailable');
    if(oiDelta!==null&&Math.abs(oiDelta)>.08){if(sign(oiDelta)>0&&sign(structure.h1.change_pct)>0)add('open_interest',8,1,'OI expanding with price');else if(sign(oiDelta)>0&&sign(structure.h1.change_pct)<0)add('open_interest',1,8,'OI expanding into falling price');else add('open_interest',4,4,'OI contraction / deleveraging')}else add('open_interest',3,3,'OI change modest');
    if(fundPct!==null&&fundPct>90)add('funding',1,7,'funding crowded high');else if(fundPct!==null&&fundPct<10)add('funding',7,1,'funding crowded low');else add('funding',3,3,'funding not extreme');
    if(longLiq!==null||shortLiq!==null){if((shortLiq||0)>(longLiq||0)*1.5)add('liquidations',6,1,'short liquidations dominate');else if((longLiq||0)>(shortLiq||0)*1.5)add('liquidations',1,6,'long liquidations dominate');else add('liquidations',3,3,'balanced liquidations')}else add('liquidations',0,0,'liquidations unavailable');

    const etfFlow=num(cg?.etf?.us_latest?.flow_usd);if(etfFlow!==null&&Math.abs(etfFlow)>5e7)add('etf',etfFlow>0?8:1,etfFlow<0?8:1,`US spot ETF flow ${etfFlow>0?'positive':'negative'}`);else add('etf',3,3,'ETF flow neutral, stale or unavailable');
    const nq=num(cross?.nasdaq?.price),nqPrev=num(cross?.nasdaq?.prev_close),dxy=num(cross?.dxy?.price),dxyPrev=num(cross?.dxy?.prev_close),risk=(nq&&nqPrev?pct(nq,nqPrev):0)-(dxy&&dxyPrev?pct(dxy,dxyPrev):0);if(risk>.3)add('cross_asset',7,1,'risk assets / dollar mix supportive');else if(risk<-.3)add('cross_asset',1,7,'risk assets / dollar mix restrictive');else add('cross_asset',3,3,'cross-assets mixed');
    const latestMacro=macro?.latest||{},y2=num(latestMacro.us2y?.value),y10=num(latestMacro.us10y?.value),macroRisk=(y2!==null&&y10!==null&&y2>y10)?1:0;add('macro',macroRisk?2:4,macroRisk?5:3,macroRisk?'curve/macro backdrop restrictive':'macro backdrop not strongly restrictive from available primary data');
    const pcOi=num(options?.put_call_oi_ratio);if(pcOi!==null&&pcOi>1.1)add('options',2,5,'put/call OI elevated');else if(pcOi!==null&&pcOi<.7)add('options',5,2,'put/call OI call-heavy');else add('options',3,3,'options positioning balanced/unavailable');
    const onchainAvailable=onchain?.status==='LIVE'||onchain?.status==='DELAYED';add('onchain',onchainAvailable?3:0,onchainAvailable?3:0,onchainAvailable?'on-chain context available; used as slower regime context':'on-chain premium metrics unavailable');
    const polyCount=pred?.polymarket?.length||0,kalshiCount=pred?.kalshi?.length||0;add('prediction_markets',2,2,`${polyCount+kalshiCount} relevant prediction-market contracts tracked`);const newsCount=news?.items?.length||0;add('news',2,2,`${newsCount} relevant primary-source news items in current cache`);

    const bullScore=clamp(totalCapacity?bull/totalCapacity*100:0),bearScore=clamp(totalCapacity?bear/totalCapacity*100:0),coreQuality=num(core?.data_quality)??50,sourceStates=[cg,options,macro,cross,pred,news,onchain].map(x=>x?.status),available=sourceStates.filter(x=>x==='LIVE'||x==='DELAYED').length,unavailable=sourceStates.filter(x=>x==='UNAVAILABLE').length,dataQuality=clamp(coreQuality+available*3-unavailable*7-(cg?.status==='PARTIAL'?8:0));
    let eventRisk='MEDIUM';if(newsCount>10||num(options?.dvol)>80)eventRisk='HIGH';if(num(options?.dvol)>110)eventRisk='EXTREME';
    const driver=Math.abs(spot5)>Math.abs(perp5)*1.35?'SPOT_LED':Math.abs(perp5)>Math.abs(spot5)*1.35?'LEVERAGE_LED':'MIXED',direction=bullScore>bearScore+15?'LONG':bearScore>bullScore+15?'SHORT':'NEUTRAL',independentConfirmations=Object.entries(families).filter(([,v])=>direction==='LONG'?v.bull>=5:direction==='SHORT'?v.bear>=5:false).map(([k])=>k),contradiction=Object.entries(families).filter(([,v])=>direction==='LONG'?v.bear>=5:direction==='SHORT'?v.bull>=5:false).map(([k])=>k);
    let tradeConfidence=clamp(Math.max(bullScore,bearScore)*.55+dataQuality*.35+Math.min(independentConfirmations.length,5)*3-contradiction.length*4);if(eventRisk==='EXTREME')tradeConfidence=Math.min(tradeConfidence,45);if(dataQuality<65)tradeConfidence=Math.min(tradeConfidence,55);
    const range=Math.max(structure.h1.high-structure.h1.low,price*.003),stopDistance=Math.max(range*.32,price*.0015);let activeSetup=null,preferred='NO_TRADE',priority='INFO';if(direction!=='NEUTRAL'&&independentConfirmations.length>=3&&tradeConfidence>=68&&eventRisk!=='EXTREME'){preferred='WATCH';priority=tradeConfidence>=82?'HIGH':'WATCH';const trigger=direction==='LONG'?Math.max(price,structure.m15.high):Math.min(price,structure.m15.low),stop=direction==='LONG'?trigger-stopDistance:trigger+stopDistance,r=direction==='LONG'?1:-1;activeSetup={status:'WATCH',setup_type:structure.breakout?'BREAKOUT_CONTINUATION':'MULTI_FACTOR_CONTINUATION',direction,entry_zone:{from:trigger-stopDistance*.15,to:trigger+stopDistance*.15},trigger_required:`${direction} confirmation through ${trigger.toFixed(0)} with spot flow not contradicting`,invalidation:`sustained acceptance beyond ${stop.toFixed(0)} against the thesis`,stop_risk_level:stop,targets:[trigger+r*stopDistance*1.5,trigger+r*stopDistance*2.5,trigger+r*stopDistance*4].map(x=>Math.round(x)),expected_rr:2.5,liquidity_context:{above,below},driver,confirmations:independentConfirmations,contradictions:contradiction,expires_at:new Date(Date.now()+90*60e3).toISOString()}}
    const primaryRegime=structure.trend,secondaryRegime=driver,explainability={increased_confidence:independentConfirmations,reduced_confidence:contradiction,unavailable_sources:sourceStates.map((s,i)=>[i,s]).filter(([,s])=>s==='UNAVAILABLE').map(([i])=>['coinglass','options','macro','cross_asset','prediction_markets','news','onchain'][i]),dynamic_weights:dynamicWeights,families};
    return{updated_at:new Date().toISOString(),price,primary_regime:primaryRegime,secondary_regime:secondaryRegime,regime_confidence:clamp(Math.max(bullScore,bearScore)),bull_score:bullScore,bear_score:bearScore,trade_confidence:tradeConfidence,event_risk:eventRisk,preferred_action:preferred,priority,data_quality:dataQuality,driver_classification:driver,active_setup:activeSetup,watchlist:activeSetup?[activeSetup]:[],structure,explainability}
  }
}
