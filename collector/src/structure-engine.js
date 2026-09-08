const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pct=(a,b)=>a&&b?((a-b)/b)*100:null;
const isoDay=t=>new Date(t).toISOString().slice(0,10);
const utcMonth=t=>new Date(t).toISOString().slice(0,7);
const weekKey=t=>{const d=new Date(t);d.setUTCHours(0,0,0,0);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return d.toISOString().slice(0,10)};

function bucketSize(price){if(price>=100000)return 100;if(price>=50000)return 50;if(price>=10000)return 25;return 10}
function weightedMean(rows,priceKey='price',weightKey='notional_usd'){let n=0,d=0;for(const r of rows){const p=num(r[priceKey]),w=num(r[weightKey]);if(p&&w>0){n+=p*w;d+=w}}return d?n/d:null}
function ohlc(rows){if(!rows.length)return null;const ps=rows.map(x=>num(x.price)).filter(Boolean);if(!ps.length)return null;return{open:num(rows[0].price),high:Math.max(...ps),low:Math.min(...ps),close:num(rows.at(-1).price),volume_usd:rows.reduce((a,x)=>a+(num(x.notional_usd)||0),0)}}

export class StructureEngine{
  constructor({retentionMs=35*24*60*60*1000,maxTrades=900000}={}){
    this.retentionMs=retentionMs;this.maxTrades=maxTrades;this.trades=[];this.reference={daily:[],weekly:[],monthly:[],cme:[]};this.lastPrune=0;
  }
  async bootstrap(){
    const get=async(url)=>{const c=new AbortController(),tm=setTimeout(()=>c.abort(),5000);try{const r=await fetch(url,{signal:c.signal,headers:{accept:'application/json'}});if(!r.ok)throw new Error(`${r.status} ${url}`);return await r.json()}finally{clearTimeout(tm)}};
    try{
      const [d,w,m]=await Promise.all([
        get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=40'),
        get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=12'),
        get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1M&limit=6')
      ]);
      const map=k=>k.map(x=>({time:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume_base:Number(x[5]),quote_volume:Number(x[7]),source:'Binance spot',status:'REFERENCE'}));
      this.reference.daily=map(d);this.reference.weekly=map(w);this.reference.monthly=map(m);
    }catch(e){this.reference.error=String(e)}
    const key=process.env.COINGLASS_API_KEY;
    if(key){
      try{
        const u='https://open-api-v4.coinglass.com/api/futures/price/history?exchange=CME&symbol=BTC&interval=1d&limit=20';
        const r=await fetch(u,{headers:{'CG-API-KEY':key,accept:'application/json'}});const j=await r.json();if(r.ok&&String(j.code)==='0')this.reference.cme=(j.data||[]).map(x=>({time:Number(x.time),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume_usd:num(x.volume_usd),source:'CoinGlass CME',status:'REFERENCE'}));
      }catch(e){this.reference.cme_error=String(e)}
    }
  }
  recordTrade(row){
    const t=num(row?.event_time_ms),p=num(row?.price),notional=num(row?.notional_usd);if(!t||!p||!notional)return;
    this.trades.push({t,price:p,notional_usd:notional,qty:num(row.qty)||notional/p,side:row.side,venue:row.venue,market_type:row.market_type});
    if(this.trades.length>this.maxTrades)this.trades.splice(0,this.trades.length-this.maxTrades);
    if(Date.now()-this.lastPrune>30000){this.lastPrune=Date.now();const cut=Date.now()-this.retentionMs;let i=0;while(i<this.trades.length&&this.trades[i].t<cut)i++;if(i)this.trades.splice(0,i)}
  }
  _window(ms,market='spot'){const cut=Date.now()-ms;return this.trades.filter(x=>x.t>=cut&&(!market||x.market_type===market))}
  _sessionBounds(name,now=Date.now()){
    const d=new Date(now),y=d.getUTCFullYear(),m=d.getUTCMonth(),day=d.getUTCDate();const mk=(h,min=0)=>Date.UTC(y,m,day,h,min);
    const map={ASIA:[mk(0),mk(8)],LONDON:[mk(7),mk(16)],NEW_YORK:[mk(13,30),mk(21)],CME:[mk(13,30),mk(20)]};let [s,e]=map[name];if(now<s){s-=86400000;e-=86400000}return[s,e]
  }
  _session(name){const[s,e]=this._sessionBounds(name),rows=this.trades.filter(x=>x.market_type==='spot'&&x.t>=s&&x.t<=Math.min(Date.now(),e));return{name,start:new Date(s).toISOString(),end:new Date(e).toISOString(),active:Date.now()>=s&&Date.now()<=e,...(ohlc(rows)||{}),vwap:weightedMean(rows)}}
  _periodVwap(kind){const now=new Date(),t=Date.now();let start;if(kind==='day')start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());else if(kind==='week'){const day=(now.getUTCDay()+6)%7;start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-day)}else start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1);const rows=this.trades.filter(x=>x.market_type==='spot'&&x.t>=start&&x.t<=t);return{anchor:new Date(start).toISOString(),vwap:weightedMean(rows),coverage_ms:rows.length?t-rows[0].t:0,status:rows.length?'LIVE_PARTIAL_FROM_PROCESS_START':'UNAVAILABLE'}}
  _volumeProfile(ms=24*60*60e3){const rows=this._window(ms,'spot');if(!rows.length)return{status:'UNAVAILABLE'};const last=rows.at(-1).price,step=bucketSize(last),bins=new Map();let total=0;for(const r of rows){const k=Math.round(r.price/step)*step,v=r.notional_usd;bins.set(k,(bins.get(k)||0)+v);total+=v}const sorted=[...bins.entries()].map(([price,volume_usd])=>({price,volume_usd})).sort((a,b)=>b.volume_usd-a.volume_usd),poc=sorted[0]?.price??null;let acc=0;const value=[];for(const x of sorted){if(acc/total>=.70)break;value.push(x.price);acc+=x.volume_usd}return{status:'LIVE',window_ms:ms,bucket_usd:step,poc,value_area_high:value.length?Math.max(...value):null,value_area_low:value.length?Math.min(...value):null,total_volume_usd:total,top_nodes:sorted.slice(0,12)}}
  _cmeGaps(price){const bars=this.reference.cme||[],gaps=[];for(let i=1;i<bars.length;i++){const prev=bars[i-1],cur=bars[i];if(cur.low>prev.high)gaps.push({type:'GAP_UP',from:prev.high,to:cur.low,created_at:new Date(cur.time).toISOString()});else if(cur.high<prev.low)gaps.push({type:'GAP_DOWN',from:cur.high,to:prev.low,created_at:new Date(cur.time).toISOString()})}return gaps.map(g=>({...g,distance_pct:price?((g.from+g.to)/2-price)/price*100:null,filled:price>=g.from&&price<=g.to})).filter(g=>!g.filled).slice(-10)}
  _referenceLevels(price){
    const prior=(arr)=>arr.length>=2?arr[arr.length-2]:null;const pd=prior(this.reference.daily||[]),pw=prior(this.reference.weekly||[]),pm=prior(this.reference.monthly||[]);
    const level=(name,b)=>b?{name,open:b.open,high:b.high,low:b.low,close:b.close,source:b.source,status:b.status}:null;
    return{previous_day:level('previous_day',pd),previous_week:level('previous_week',pw),previous_month:level('previous_month',pm),psychological:{below_1000:Math.floor(price/1000)*1000,above_1000:Math.ceil(price/1000)*1000,below_500:Math.floor(price/500)*500,above_500:Math.ceil(price/500)*500}}
  }
  _breakoutState(price,levels){const refs=[];for(const x of [levels.previous_day,levels.previous_week,levels.previous_month])if(x){refs.push([`${x.name}_high`,x.high],[`${x.name}_low`,x.low])}const near=refs.map(([name,p])=>({name,price:p,distance_pct:(price-p)/p*100})).sort((a,b)=>Math.abs(a.distance_pct)-Math.abs(b.distance_pct)).slice(0,6);let state='INSIDE_REFERENCE';for(const r of refs){if(r[0].endsWith('_high')&&price>r[1]){state='ABOVE_REFERENCE_HIGH';break}if(r[0].endsWith('_low')&&price<r[1]){state='BELOW_REFERENCE_LOW';break}}return{state,nearest:near}}
  snapshot(price){
    const spot1h=this._window(60*60e3,'spot'),spot4h=this._window(4*60*60e3,'spot'),spot1d=this._window(24*60*60e3,'spot');
    const levels=this._referenceLevels(price);const day=this._periodVwap('day'),week=this._periodVwap('week'),month=this._periodVwap('month');
    return{status:'LIVE',observed_at:new Date().toISOString(),ohlc:{h1:ohlc(spot1h),h4:ohlc(spot4h),d1:ohlc(spot1d)},levels,sessions:{asia:this._session('ASIA'),london:this._session('LONDON'),new_york:this._session('NEW_YORK'),cme:this._session('CME')},vwap:{day,week,month,session_london:this._session('LONDON').vwap,session_new_york:this._session('NEW_YORK').vwap},volume_profile:{h4:this._volumeProfile(4*60*60e3),d1:this._volumeProfile(24*60*60e3)},cme_gaps:this._cmeGaps(price),breakout_retest:this._breakoutState(price,levels),reference_health:{daily_bars:this.reference.daily?.length||0,weekly_bars:this.reference.weekly?.length||0,monthly_bars:this.reference.monthly?.length||0,cme_bars:this.reference.cme?.length||0,error:this.reference.error||null,cme_error:this.reference.cme_error||null}};
  }
}
