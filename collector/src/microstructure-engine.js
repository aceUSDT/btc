const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const minute=t=>Math.floor(t/60000)*60000;
const pct=(a,b)=>a&&b?((a-b)/b)*100:null;
function flowWindow(flow,venue,market,mins,now=Date.now()){
  const end=minute(now),out={buy_usd:0,sell_usd:0,delta_usd:0,trades:0};
  for(let i=0;i<mins;i++){const r=flow.buckets?.get?.(`venue:${venue}:${market}:${end-i*60000}`);if(!r)continue;out.buy_usd+=r.buy_usd||0;out.sell_usd+=r.sell_usd||0;out.delta_usd+=r.delta_usd||0;out.trades+=r.trades||0}return out
}
function bookPressure(book){if(!book?.bid_prices?.length||!book?.ask_prices?.length)return null;let bid=0,ask=0;for(let i=0;i<Math.min(20,book.bid_prices.length);i++)bid+=Number(book.bid_prices[i])*Number(book.bid_sizes[i]||0);for(let i=0;i<Math.min(20,book.ask_prices.length);i++)ask+=Number(book.ask_prices[i])*Number(book.ask_sizes[i]||0);const total=bid+ask;return{bid_usd:bid,ask_usd:ask,imbalance:total?(bid-ask)/total:null,bid_ask_ratio:ask?bid/ask:null}}

export class MicrostructureEngine{
  constructor({market,flow,structure}){this.market=market;this.flow=flow;this.structure=structure}
  snapshot(price){
    const venues=new Set();for(const k of this.flow.buckets?.keys?.()||[]){const p=String(k).split(':');if(p[0]==='venue')venues.add(p[1])}
    const venue_pressure=[];for(const venue of venues){for(const marketType of ['spot','perp']){const f1=flowWindow(this.flow,venue,marketType,1),f5=flowWindow(this.flow,venue,marketType,5);if(!f1.trades&&!f5.trades)continue;const book=this.market.books?.get?.(`${venue}:${marketType}`),bp=marketType==='spot'?bookPressure(book):null;venue_pressure.push({venue,market_type:marketType,flow_1m:f1,flow_5m:f5,book_pressure:bp,status:Date.now()-(book?.event_time_ms||0)<5000||f1.trades?'LIVE':'DELAYED'})}}
    const spot=venue_pressure.filter(x=>x.market_type==='spot'),perp=venue_pressure.filter(x=>x.market_type==='perp');
    const aggregate=(rows,key)=>rows.reduce((a,x)=>a+(x[key]?.delta_usd||0),0);const spot1=aggregate(spot,'flow_1m'),spot5=aggregate(spot,'flow_5m'),perp1=aggregate(perp,'flow_1m'),perp5=aggregate(perp,'flow_5m');
    const bookRows=spot.map(x=>x.book_pressure).filter(Boolean),bid=bookRows.reduce((a,x)=>a+x.bid_usd,0),ask=bookRows.reduce((a,x)=>a+x.ask_usd,0),bookTotal=bid+ask;
    const trades=this.structure?.trades||[],cut5=Date.now()-5*60000,recent=trades.filter(x=>x.t>=cut5),large=recent.filter(x=>x.notional_usd>=250000).sort((a,b)=>b.notional_usd-a.notional_usd).slice(0,50),largeBuy=large.filter(x=>x.side==='buy').reduce((a,x)=>a+x.notional_usd,0),largeSell=large.filter(x=>x.side==='sell').reduce((a,x)=>a+x.notional_usd,0);
    const p5=recent.length?pct(price,recent[0].price):null,total5=recent.reduce((a,x)=>a+x.notional_usd,0),delta5=recent.reduce((a,x)=>a+(x.side==='buy'?x.notional_usd:-x.notional_usd),0),deltaRatio=total5?delta5/total5:0;
    let absorption='NONE';if(Math.abs(deltaRatio)>.18&&Math.abs(p5||0)<.10)absorption=deltaRatio>0?'SELL_SIDE_ABSORPTION_OF_BUYERS':'BUY_SIDE_ABSORPTION_OF_SELLERS';
    const currentMinute=minute(Date.now()),prevMinute=currentMinute-60000;let curVol=0,prevVol=0;for(const [k,r]of this.flow.buckets||[]){if(!String(k).startsWith('agg:spot:'))continue;const t=Number(String(k).split(':').at(-1));if(t===currentMinute)curVol=(r.buy_usd||0)+(r.sell_usd||0);if(t===prevMinute)prevVol=(r.buy_usd||0)+(r.sell_usd||0)}const volumeAcceleration=prevVol?curVol/prevVol:null;
    const exhaustion=volumeAcceleration!==null&&volumeAcceleration<.55&&Math.abs(spot1)<Math.abs(spot5)/8?'POSSIBLE_FLOW_EXHAUSTION':'NONE';
    return{observed_at:new Date().toISOString(),venue_pressure,aggregate:{spot_delta_1m:spot1,spot_delta_5m:spot5,perp_delta_1m:perp1,perp_delta_5m:perp5,spot_book_bid_usd:bid,spot_book_ask_usd:ask,spot_book_imbalance:bookTotal?(bid-ask)/bookTotal:null,large_trades_5m:{count:large.length,buy_usd:largeBuy,sell_usd:largeSell,net_usd:largeBuy-largeSell,top:large},volume_acceleration_1m:volumeAcceleration,absorption,exhaustion},integrity:{book_pressure:'Direct spot order books only; derivatives order-book pressure uses normalized CoinGlass aggregate in the external layer.',large_trade_threshold_usd:250000}}
  }
}
