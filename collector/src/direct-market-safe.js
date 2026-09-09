import WebSocket from 'ws';
import { DirectMarketHub } from './direct-market.js';

function epochMs(value){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)return null;
  // Some venue payloads (notably Gate) expose fractional Unix seconds in a
  // field named create_time_ms. Normalize every direct-market timestamp here
  // before it reaches Date() or the ClickHouse UInt64 event_time_ms column.
  return Math.round(n<1e11?n*1000:n);
}
const now=()=>new Date().toISOString();

export class SafeDirectMarketHub extends DirectMarketHub {
  constructor(opts={}){super(opts);this.gateQuantoMultiplier=null}
  async _loadGateContract(){
    try{
      const j=await this._json('https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT');
      const q=Number(j?.quanto_multiplier);
      if(Number.isFinite(q)&&q>0){this.gateQuantoMultiplier=q;this.health('gate_perp',{contract_multiplier_btc:q,normalization:'LIVE'})}
      else throw new Error('Gate quanto_multiplier missing');
    }catch(e){this.gateQuantoMultiplier=null;this.health('gate_perp',{normalization:'UNAVAILABLE'});this.error(e,'gate:contract-normalization')}
  }
  trade(row){
    const t=epochMs(row?.event_time_ms);
    if(!t)return;
    row={...row,event_time_ms:t};
    if(row?.venue==='Gate'&&row?.market_type==='perp'){
      if(!this.gateQuantoMultiplier){this.health('gate_perp',{status:'PARTIAL',normalization:'UNAVAILABLE'});return}
      row={...row,qty:Number(row.qty)*this.gateQuantoMultiplier,normalization:'quanto_multiplier'};
    }
    return super.trade(row);
  }
  book(row){
    const t=epochMs(row?.event_time_ms)||Date.now();
    return super.book({...row,event_time_ms:t});
  }
  socket(name,url,{onOpen,onMessage,onReset,appPing=null,headers={}}={}){
    let ws,closed=false,attempt=0,pingTimer,watchdog;
    const start=()=>{
      if(closed)return;
      attempt++;this.health(name,{status:'CONNECTING',attempt,url});onReset?.();ws=new WebSocket(url,{headers});
      ws.on('open',()=>{
        attempt=0;this.health(name,{status:'LIVE',connected_at:now(),last_message_at:null});
        try{onOpen?.(ws)}catch(e){this.error(e,`${name}:open`)}
        pingTimer=setInterval(()=>{try{if(ws.readyState!==WebSocket.OPEN)return;if(appPing!==null)ws.send(typeof appPing==='string'?appPing:JSON.stringify(appPing));else ws.ping()}catch(e){this.error(e,`${name}:ping`)}},20000);
        watchdog=setInterval(()=>{const h=this.sockets[name],last=h?.last_message_at?Date.parse(h.last_message_at):0;if(last&&Date.now()-last>45000){this.health(name,{status:'STALE'});try{ws.terminate()}catch{}}},10000);
      });
      ws.on('message',buf=>{
        this.health(name,{status:'LIVE',last_message_at:now()});
        const text=buf.toString();
        // OKX and some other venues send raw text heartbeat replies.
        if(text==='pong'||text==='ping')return;
        try{onMessage?.(JSON.parse(text),ws)}catch(e){this.error(e,`${name}:message`)}
      });
      ws.on('error',e=>this.error(e,`${name}:socket`));
      ws.on('close',()=>{clearInterval(pingTimer);clearInterval(watchdog);onReset?.();this.health(name,{status:'DISCONNECTED',disconnected_at:now()});if(!closed)setTimeout(start,Math.min(30000,1000*2**Math.min(attempt,5)))});
    };
    start();
    const stop=()=>{closed=true;clearInterval(pingTimer);clearInterval(watchdog);onReset?.();try{ws?.close()}catch{}};
    this.stoppers.push(stop);return stop;
  }
  _coinglassLiquidations(){
    // CoinGlass REST aggregation remains enabled independently. The WebSocket
    // liquidation stream is entitlement-gated and must never be labelled LIVE
    // when the current plan/key does not support it.
    if(String(process.env.COINGLASS_WS_ENABLED||'false').toLowerCase()!=='true'){
      this.health('coinglass_liquidations',{status:'UNAVAILABLE',reason:'CoinGlass liquidation WebSocket disabled or not entitled; REST liquidation aggregation remains available.'});
      return;
    }
    return super._coinglassLiquidations();
  }
  async start(){await this._loadGateContract();const out=await super.start();this.gateTimer=setInterval(()=>void this._loadGateContract(),60*60e3);this.gateTimer.unref?.();return out}
  stop(){clearInterval(this.gateTimer);super.stop()}
}
