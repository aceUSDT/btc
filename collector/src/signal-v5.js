import { SignalEngine } from './signal-engine.js';
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,x));
const rank=x=>({LOW:0,MEDIUM:1,HIGH:2,EXTREME:3})[x]??0;
const risk=(a,b)=>rank(a)>=rank(b)?a:b;

export class SignalEngineV5 extends SignalEngine{
  evaluateV5(core,external={},structure={},micro={}){
    const base=super.evaluate(core,external),price=num(core?.price);if(!price)return base;
    let bullAdj=0,bearAdj=0;const plus=[],minus=[];
    const levels=structure?.levels||{},vp=structure?.volume_profile?.d1||{},vwap=structure?.vwap||{},m=micro?.aggregate||{};
    const dVwap=num(vwap?.day?.vwap),poc=num(vp?.poc),vah=num(vp?.value_area_high),val=num(vp?.value_area_low);
    if(dVwap){if(price>dVwap){bullAdj+=3;plus.push('price_above_daily_vwap')}else{bearAdj+=3;minus.push('price_below_daily_vwap')}}
    if(poc){if(price>poc){bullAdj+=2;plus.push('price_above_volume_poc')}else{bearAdj+=2;minus.push('price_below_volume_poc')}}
    if(vah&&price>vah){bullAdj+=2;plus.push('accepted_above_value_area')}if(val&&price<val){bearAdj+=2;minus.push('accepted_below_value_area')}
    if(structure?.breakout_retest?.state==='ABOVE_REFERENCE_HIGH'){bullAdj+=4;plus.push('above_prior_reference_high')}if(structure?.breakout_retest?.state==='BELOW_REFERENCE_LOW'){bearAdj+=4;minus.push('below_prior_reference_low')}
    const bookImb=num(m.spot_book_imbalance);if(bookImb!==null&&Math.abs(bookImb)>.08){if(bookImb>0){bullAdj+=4;plus.push('direct_spot_book_bid_imbalance')}else{bearAdj+=4;minus.push('direct_spot_book_ask_imbalance')}}
    const largeNet=num(m?.large_trades_5m?.net_usd);if(largeNet!==null&&Math.abs(largeNet)>1e6){if(largeNet>0){bullAdj+=4;plus.push('large_spot_trades_net_buy')}else{bearAdj+=4;minus.push('large_spot_trades_net_sell')}}
    if(m.absorption==='SELL_SIDE_ABSORPTION_OF_BUYERS'){bearAdj+=5;minus.push('buy_aggression_absorbed_by_sellers')}if(m.absorption==='BUY_SIDE_ABSORPTION_OF_SELLERS'){bullAdj+=5;plus.push('sell_aggression_absorbed_by_buyers')}
    if(m.exhaustion==='POSSIBLE_FLOW_EXHAUSTION'){bullAdj-=1;bearAdj-=1}
    const usdt=num(external?.stablecoins?.pegs?.USDT),usdc=num(external?.stablecoins?.pegs?.USDC);let stableRisk='LOW';if((usdt&&usdt<.995)||(usdc&&usdc<.995))stableRisk='HIGH';if((usdt&&usdt<.98)||(usdc&&usdc<.98))stableRisk='EXTREME';
    const calendarRisk=external?.event_calendar?.event_risk||'LOW';base.event_risk=risk(risk(base.event_risk||'LOW',calendarRisk),stableRisk);
    base.bull_score=clamp((base.bull_score||0)+bullAdj);base.bear_score=clamp((base.bear_score||0)+bearAdj);
    const missingCritical=[];const cg=external?.coinglass;if(!cg||!['LIVE','DELAYED','PARTIAL'].includes(cg.status))missingCritical.push('all_exchange_aggregation');if(!num(core?.spot?.reconciled?.m5)&&!num(core?.spot?.m5?.delta_usd))missingCritical.push('spot_cvd');if(!num(core?.perp?.reconciled?.m5)&&!num(core?.perp?.m5?.delta_usd))missingCritical.push('perp_cvd');if(!core?.liquidation_state?.actual_orders&&!cg?.liquidations)missingCritical.push('liquidations');
    base.data_quality=clamp((base.data_quality||50)-missingCritical.length*9+(micro?.venue_pressure?.length>=5?3:0));
    const directional=Math.abs(base.bull_score-base.bear_score);base.trade_confidence=clamp((base.trade_confidence||0)+Math.min(directional/10,5)-missingCritical.length*6);
    if(base.event_risk==='EXTREME'||base.data_quality<60||missingCritical.length>=2){base.active_setup=null;base.watchlist=[];base.preferred_action='NO_TRADE';base.priority=base.event_risk==='EXTREME'?'HIGH':'INFO';base.trade_confidence=Math.min(base.trade_confidence,55)}
    if(base.active_setup){const setup=base.active_setup;setup.key_levels={previous_day:levels.previous_day,previous_week:levels.previous_week,previous_month:levels.previous_month,vwap:{day:dVwap,week:num(vwap?.week?.vwap),month:num(vwap?.month?.vwap)},volume_profile:{poc,vah,val},sessions:structure?.sessions,liquidation:setup.liquidity_context};setup.confirmations=[...(setup.confirmations||[]),...plus];setup.contradictions=[...(setup.contradictions||[]),...minus];setup.trigger_required+=`; require microstructure confirmation and no EXTREME event-risk gate`}
    base.explainability={...(base.explainability||{}),full_structure_adjustments:{bull:bullAdj,bear:bearAdj,positive:plus,negative:minus},microstructure:micro?.aggregate||null,stablecoin_risk:stableRisk,event_calendar_risk:calendarRisk,missing_critical_sources:missingCritical};base.structure_full=structure;base.microstructure=micro;
    return base;
  }
}
