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
  _recordLiquidation(event){
    const t=epochMs(event?.time)||Date.now(),price=Number(event?.price),notional=Number(event?.volume_usd);
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(notional)||notional<=0||!['long','short'].includes(event?.side))return;
    this.liquidations.push({...event,time:t,price,volume_usd:notional});
    const cut=Date.now()-10*60e3;while(this.liquidations.length&&this.liquidations[0].time<cut)this.liquidations.shift();
  }
  _directLiquidations(){
    // Binance USD-M: force-order side SELL closes a liquidated long; BUY closes a short.
    this.socket('binance_liquidations','wss://fstream.binance.com/ws/btcusdt@forceOrder',{onMessage:m=>{
      const o=m?.o;if(!o||String(o.s).toUpperCase()!=='BTCUSDT')return;
      const price=Number(o.ap)>0?Number(o.ap):Number(o.p),filled=Number(o.z)>0?Number(o.z):Number(o.q);
      this._recordLiquidation({exchange:'Binance',symbol:'BTCUSDT',side:String(o.S).toUpperCase()==='SELL'?'long':'short',price,volume_usd:price*filled,time:o.T||m.E||Date.now(),source:'direct_ws',notional_basis:'average_or_order_price_x_filled_or_original_qty'});
    }});
    // Bybit V5 all-liquidation stream. Bybit documents S=Buy as a liquidated long position.
    this.socket('bybit_liquidations','wss://stream.bybit.com/v5/public/linear',{appPing:{op:'ping'},onOpen:ws=>ws.send(JSON.stringify({op:'subscribe',args:['allLiquidation.BTCUSDT']})),onMessage:m=>{
      if(m.topic!=='allLiquidation.BTCUSDT')return;
      for(const x of m.data||[]){const price=Number(x.p),qty=Number(x.v);this._recordLiquidation({exchange:'Bybit',symbol:'BTCUSDT',side:String(x.S)==='Buy'?'long':'short',price,volume_usd:price*qty,time:x.T||m.ts||Date.now(),source:'direct_ws',notional_basis:'bankruptcy_price_x_executed_size'})}
    }});
  }
  _coinglassLiquidations(){
    // CoinGlass REST aggregation remains enabled independently. The WebSocket
    // liquidation stream is entitlement-gated and must never be labelled LIVE
    // when the current plan/key does not support it.
    if(String(process.env.COINGLASS_WS_ENABLED||'false').toLowerCase()!=='true'){
      this.health('coinglass_liquidations',{status:'UNAVAILABLE',reason:'CoinGlass liquidation WebSocket disabled or not entitled; direct Binance/Bybit liquidation feeds remain active.'});
      return;
    }
    return super._coinglassLiquidations();
  }
  _reportHealth(){
    const sockets=Object.fromEntries(Object.entries(this.sockets).map(([k,v])=>[k,{status:v?.status||'UNKNOWN',last_message_at:v?.last_message_at||null,normalization:v?.normalization||null}]));
    const ch=this.clickhouseWriter?.health?.()||{};
    this.log?.info?.({type:'market_health',at:now(),sockets,actual_liquidations_5m:this.liquidationState?.().actual_orders_5m||null,clickhouse:{trade_buffer:ch.trade_buffer,book_buffer:ch.book_buffer,quarantined_batches:ch.quarantined_batches,last_trade_flush_at:ch.last_trade_flush_at,last_book_flush_at:ch.last_book_flush_at,last_error:ch.last_error},redis:this.redisPublisher?.health?.()||null},'BTC direct-market health');
  }
  async start(){
    await this._loadGateContract();
    const out=await super.start();
    this._directLiquidations();
    this.gateTimer=setInterval(()=>void this._loadGateContract(),60*60e3);this.gateTimer.unref?.();
    this.healthTimer=setInterval(()=>this._reportHealth(),30000);this.healthTimer.unref?.();
    setTimeout(()=>this._reportHealth(),8000).unref?.();
    return out;
  }
  stop(){clearInterval(this.gateTimer);clearInterval(this.healthTimer);super.stop()}
}
