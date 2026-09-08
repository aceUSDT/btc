const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const sign=v=>!Number(v)?0:Number(v)>0?1:-1;
const pct=(a,b)=>a&&b?((a-b)/b)*100:null;
const mean=a=>{const b=a.map(num).filter(x=>x!==null);return b.length?b.reduce((x,y)=>x+y,0)/b.length:null};

function quantile(values,q){const a=values.map(num).filter(x=>x!==null).sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*q,l=Math.floor(i),h=Math.ceil(i);return l===h?a[l]:a[l]+(a[h]-a[l])*(i-l)}

export class SignalEngine {
  constructor({maxHistory=172800}={}){
    this.history=[];
    this.maxHistory=maxHistory;
    this.lastAlertKey=null;
    this.lastSetupKey=null;
  }
  ingest(core){
    if(!core?.price)return;
    const item={t:Date.now(),p:Number(core.price),oi:num(core.open_interest_usd),spot:num(core.spot?.m5?.delta_usd),perp:num(core.perp?.m5?.delta_usd),funding:num(core.funding_oi_weighted)};
    const prev=this.history.at(-1);
    if(prev&&item.t-prev.t<800)return;
    this.history.push(item);
    if(this.history.length>this.maxHistory)this.history.splice(0,this.history.length-this.maxHistory);
  }
  _since(ms){const c=Date.now()-ms;return this.history.filter(x=>x.t>=c)}
  _structure(price){
    const windows={m5:5*60e3,m15:15*60e3,h1:60*60e3,h4:4*60*60e3,d1:24*60*60e3};
    const out={};
    for(const[k,ms]of Object.entries(windows)){
      const rows=this._since(ms);const ps=rows.map(x=>x.p);
      out[k]={open:rows[0]?.p??price,high:ps.length?Math.max(...ps):price,low:ps.length?Math.min(...ps):price,close:price,change_pct:rows.length?pct(price,rows[0].p):null};
    }
    const h1=this._since(60*60e3);const rets=[];for(let i=1;i<h1.length;i++)rets.push(Math.abs(pct(h1[i].p,h1[i-1].p)||0));
    const noise=quantile(rets,.75)||0.01;
    const h4=out.h4;const pos=h4.high>h4.low?(price-h4.low)/(h4.high-h4.low):.5;
    let trend='RANGE';
    if((out.h1.change_pct||0)>Math.max(.25,noise*8)&&pos>.68)trend='TREND_UP';
    else if((out.h1.change_pct||0)<-Math.max(.25,noise*8)&&pos<.32)trend='TREND_DOWN';
    const prior4=this._since(4*60*60e3).filter(x=>x.t<Date.now()-60e3).map(x=>x.p);
    const priorHigh=prior4.length?Math.max(...prior4):null,priorLow=prior4.length?Math.min(...prior4):null;
    const breakout=priorHigh&&price>priorHigh?'BREAKOUT_UP':priorLow&&price<priorLow?'BREAKOUT_DOWN':null;
    return {...out,position_4h:pos,trend,breakout,noise_1s_pct_q75:noise,psych_levels:{below:Math.floor(price/1000)*1000,above:Math.ceil(price/1000)*1000}};
  }
  evaluate(core,external={}){
    this.ingest(core);
    const price=num(core?.price);if(!price)return {preferred_action:'NO_TRADE',reason:'NO_PRICE'};
    const structure=this._structure(price);
    const cg=external?.coinglass||{};const options=external?.options||{};const macro=external?.macro||{};const cross=external?.cross_asset||{};const pred=external?.prediction_markets||{};const news=external?.news||{};
    const cgFlow=cg?.flow||{};const liq=cg?.liquidations||{};const funding=cg?.funding||{};
    const spot5=num(cgFlow.spot_cvd_5m)??num(core?.spot?.m5?.delta_usd)??0;
    const perp5=num(cgFlow.perp_cvd_5m)??num(core?.perp?.m5?.delta_usd)??0;
    const oi=num(cg?.open_interest?.total_usd)??num(core?.open_interest_usd);
    const hist5=this._since(5*60e3);const oiOld=hist5[0]?.oi;const oiDelta=oi&&oiOld?pct(oi,oiOld):null;
    const fundingNow=num(funding.oi_weighted)??num(core?.funding_oi_weighted);
    const fundPct=num(funding.percentile);
    const longLiq=num(liq.long_5m_usd),shortLiq=num(liq.short_5m_usd);
    const above=num(liq?.map?.above?.price),below=num(liq?.map?.below?.price);

    const families={};
    let bull=0,bear=0;
    const add=(name,b,br,why)=>{families[name]={bull:b,bear:br,why};bull+=b;bear+=br};
    if(structure.trend==='TREND_UP')add('structure',18,2,'1h/4h price structure trends higher');
    else if(structure.trend==='TREND_DOWN')add('structure',2,18,'1h/4h price structure trends lower');
    else add('structure',7,7,'price remains range-like');
    if(structure.breakout==='BREAKOUT_UP') {families.structure.bull+=7;bull+=7;families.structure.why+='; 4h breakout up';}
    if(structure.breakout==='BREAKOUT_DOWN'){families.structure.bear+=7;bear+=7;families.structure.why+='; 4h breakout down';}

    if(spot5>0)add('spot_flow',16,2,'aggregated spot CVD positive');else if(spot5<0)add('spot_flow',2,16,'aggregated spot CVD negative');else add('spot_flow',4,4,'spot CVD neutral/unavailable');
    if(perp5>0)add('perp_flow',10,2,'perp CVD positive');else if(perp5<0)add('perp_flow',2,10,'perp CVD negative');else add('perp_flow',3,3,'perp CVD neutral/unavailable');
    if(oiDelta!==null&&Math.abs(oiDelta)>.08){if(sign(oiDelta)>0&&sign(structure.h1.change_pct)>0)add('open_interest',8,1,'OI expanding with price');else if(sign(oiDelta)>0&&sign(structure.h1.change_pct)<0)add('open_interest',1,8,'OI expanding into falling price');else add('open_interest',4,4,'OI contraction / deleveraging');}else add('open_interest',3,3,'OI change modest');
    if(fundPct!==null&&fundPct>90)add('funding',1,7,'funding crowded high');else if(fundPct!==null&&fundPct<10)add('funding',7,1,'funding crowded low');else add('funding',3,3,'funding not extreme');
    if(longLiq!==null||shortLiq!==null){if((shortLiq||0)>(longLiq||0)*1.5)add('liquidations',6,1,'short liquidations dominate');else if((longLiq||0)>(shortLiq||0)*1.5)add('liquidations',1,6,'long liquidations dominate');else add('liquidations',3,3,'balanced liquidations');}else add('liquidations',0,0,'liquidations unavailable');

    const nq=num(cross?.cross_asset?.nasdaq?.price),nqPrev=num(cross?.cross_asset?.nasdaq?.prev_close);const dxy=num(cross?.cross_asset?.dxy?.price),dxyPrev=num(cross?.cross_asset?.dxy?.prev_close);
    const risk=(nq&&nqPrev?pct(nq,nqPrev):0)-(dxy&&dxyPrev?pct(dxy,dxyPrev):0);
    if(risk>.3)add('cross_asset',7,1,'risk assets / dollar mix supportive');else if(risk<-.3)add('cross_asset',1,7,'risk assets / dollar mix restrictive');else add('cross_asset',3,3,'cross-assets mixed');

    const latestMacro=macro?.latest||{};const y2=num(latestMacro.us2y?.value),y10=num(latestMacro.us10y?.value);const macroRisk=(y2!==null&&y10!==null&&y2>y10)?1:0;
    add('macro',macroRisk?2:4,macroRisk?5:3,macroRisk?'curve/macro backdrop restrictive':'macro backdrop not strongly restrictive from available primary data');

    const pcOi=num(options?.put_call_oi_ratio);if(pcOi!==null&&pcOi>1.1)add('options',2,5,'put/call OI elevated');else if(pcOi!==null&&pcOi<.7)add('options',5,2,'put/call OI call-heavy');else add('options',3,3,'options positioning balanced/unavailable');

    const polyCount=pred?.polymarket?.length||0,kalshiCount=pred?.kalshi?.length||0;add('prediction_markets',2,2,`${polyCount+kalshiCount} relevant prediction-market contracts tracked`);
    const newsCount=news?.items?.length||0;add('news',2,2,`${newsCount} relevant primary-source news items in current cache`);

    const familyWeight=Object.keys(families).length*20;const bullScore=clamp(familyWeight?bull/familyWeight*100:0),bearScore=clamp(familyWeight?bear/familyWeight*100:0);
    const coreQuality=num(core?.data_quality)??50;const sourceStates=[cg,options,macro,cross,pred,news].map(x=>x?.status);const available=sourceStates.filter(x=>x==='LIVE'||x==='DELAYED').length;const unavailable=sourceStates.filter(x=>x==='UNAVAILABLE').length;
    const dataQuality=clamp(coreQuality+available*3-unavailable*7-(cg?.status==='PARTIAL'?8:0));
    let eventRisk='MEDIUM';if((newsCount>10)||num(options?.dvol)>80)eventRisk='HIGH';if(num(options?.dvol)>110)eventRisk='EXTREME';

    const driver=Math.abs(spot5)>Math.abs(perp5)*1.35?'SPOT_LED':Math.abs(perp5)>Math.abs(spot5)*1.35?'LEVERAGE_LED':'MIXED';
    const direction=bullScore>bearScore+15?'LONG':bearScore>bullScore+15?'SHORT':'NEUTRAL';
    const independentConfirmations=Object.entries(families).filter(([,v])=>direction==='LONG'?v.bull>=5:direction==='SHORT'?v.bear>=5:false).map(([k])=>k);
    const contradiction=Object.entries(families).filter(([,v])=>direction==='LONG'?v.bear>=5:direction==='SHORT'?v.bull>=5:false).map(([k])=>k);
    let tradeConfidence=clamp(Math.max(bullScore,bearScore)*.55+dataQuality*.35+Math.min(independentConfirmations.length,5)*3-contradiction.length*4);
    if(eventRisk==='EXTREME')tradeConfidence=Math.min(tradeConfidence,45);
    if(dataQuality<65)tradeConfidence=Math.min(tradeConfidence,55);

    const range=Math.max(structure.h1.high-structure.h1.low,price*.003);const stopDistance=Math.max(range*.32,price*.0015);
    let activeSetup=null,preferred='NO_TRADE',priority='INFO';
    if(direction!=='NEUTRAL'&&independentConfirmations.length>=3&&tradeConfidence>=68&&eventRisk!=='EXTREME'){
      preferred='WATCH';priority=tradeConfidence>=82?'HIGH':'WATCH';
      const trigger=direction==='LONG'?Math.max(price,structure.m15.high):Math.min(price,structure.m15.low);
      const stop=direction==='LONG'?trigger-stopDistance:trigger+stopDistance;
      const r=direction==='LONG'?1:-1;
      activeSetup={status:'WATCH',setup_type:structure.breakout? 'BREAKOUT_CONTINUATION':'MULTI_FACTOR_CONTINUATION',direction,entry_zone:{from:trigger-stopDistance*.15,to:trigger+stopDistance*.15},trigger_required:`${direction} confirmation through ${trigger.toFixed(0)} with spot flow not contradicting`,invalidation:`sustained acceptance beyond ${stop.toFixed(0)} against the thesis`,stop_risk_level:stop,targets:[trigger+r*stopDistance*1.5,trigger+r*stopDistance*2.5,trigger+r*stopDistance*4].map(x=>Math.round(x)),expected_rr:2.5,liquidity_context:{above,below},driver,confirmations:independentConfirmations,contradictions:contradiction,expires_at:new Date(Date.now()+90*60e3).toISOString()};
    }

    const primaryRegime=structure.trend;const secondaryRegime=driver;
    const explainability={increased_confidence:independentConfirmations,reduced_confidence:contradiction,unavailable_sources:sourceStates.map((s,i)=>[i,s]).filter(([,s])=>s==='UNAVAILABLE').map(([i])=>['coinglass','options','macro','cross_asset','prediction_markets','news'][i]),families};
    return {updated_at:new Date().toISOString(),price,primary_regime:primaryRegime,secondary_regime:secondaryRegime,regime_confidence:clamp(Math.max(bullScore,bearScore)),bull_score:bullScore,bear_score:bearScore,trade_confidence:tradeConfidence,event_risk:eventRisk,preferred_action:preferred,priority,data_quality:dataQuality,driver_classification:driver,active_setup:activeSetup,watchlist:activeSetup?[activeSetup]:[],structure,explainability};
  }
}
