export class OrderBookState {
  constructor({depth=50}={}){this.depth=depth;this.reset()}
  reset(){this.bids=new Map();this.asks=new Map();this.initialized=false;this.sequence=null;this.updatedAt=null}
  _set(map,priceRaw,sizeRaw){const p=Number(priceRaw),q=Number(sizeRaw);if(!Number.isFinite(p)||!Number.isFinite(q))return;if(q<=0)map.delete(p);else map.set(p,q)}
  snapshot({bids=[],asks=[],sequence=null,time=Date.now()}={}){this.bids.clear();this.asks.clear();for(const x of bids)this._set(this.bids,x[0]??x.price,x[1]??x.qty??x.size);for(const x of asks)this._set(this.asks,x[0]??x.price,x[1]??x.qty??x.size);this.initialized=true;this.sequence=sequence;this.updatedAt=time;return this.view()}
  update({bids=[],asks=[],sequence=null,prevSequence=null,time=Date.now()}={}){
    if(!this.initialized)return null;
    if(prevSequence!==null&&this.sequence!==null&&String(prevSequence)!==String(this.sequence))return {gap:true,expected:this.sequence,got_prev:prevSequence};
    for(const x of bids)this._set(this.bids,x[0]??x.price,x[1]??x.qty??x.size);for(const x of asks)this._set(this.asks,x[0]??x.price,x[1]??x.qty??x.size);this.sequence=sequence??this.sequence;this.updatedAt=time;return this.view()
  }
  deribit(message){const data=message?.data;if(!data)return null;const cv=rows=>(rows||[]).map(([action,p,q])=>[p,action==='delete'?0:q]);if(data.type==='snapshot')return this.snapshot({bids:cv(data.bids),asks:cv(data.asks),sequence:data.change_id,time:data.timestamp});return this.update({bids:cv(data.bids),asks:cv(data.asks),sequence:data.change_id,prevSequence:data.prev_change_id,time:data.timestamp})}
  view(){const bids=[...this.bids.entries()].sort((a,b)=>b[0]-a[0]).slice(0,this.depth),asks=[...this.asks.entries()].sort((a,b)=>a[0]-b[0]).slice(0,this.depth);return{bids,asks,sequence:this.sequence,time:this.updatedAt}}
}
