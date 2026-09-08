import { DirectMarketHub } from './direct-market.js';

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
    if(row?.venue==='Gate'&&row?.market_type==='perp'){
      if(!this.gateQuantoMultiplier){this.health('gate_perp',{status:'PARTIAL',normalization:'UNAVAILABLE'});return}
      row={...row,qty:Number(row.qty)*this.gateQuantoMultiplier,normalization:'quanto_multiplier'};
    }
    return super.trade(row);
  }
  async start(){await this._loadGateContract();const out=await super.start();this.gateTimer=setInterval(()=>void this._loadGateContract(),60*60e3);this.gateTimer.unref?.();return out}
  stop(){clearInterval(this.gateTimer);super.stop()}
}
