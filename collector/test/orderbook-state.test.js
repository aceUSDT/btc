import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookState } from '../src/orderbook-state.js';

test('reconstructs snapshot and absolute quantity updates',()=>{
  const b=new OrderBookState({depth:5});
  let v=b.snapshot({bids:[[100,2],[99,1]],asks:[[101,3],[102,1]],sequence:10,time:1});
  assert.equal(v.bids[0][0],100);assert.equal(v.asks[0][0],101);
  v=b.update({bids:[[100,0],[98,4]],asks:[[101,2]],sequence:11,time:2});
  assert.equal(v.bids[0][0],99);assert.equal(v.asks[0][1],2);
});

test('detects sequence gaps when previous id is supplied',()=>{
  const b=new OrderBookState();b.snapshot({bids:[[100,1]],asks:[[101,1]],sequence:5});
  const v=b.update({bids:[[99,1]],prevSequence:4,sequence:6});
  assert.equal(v.gap,true);
});

test('applies Deribit [action, price, amount] updates',()=>{
  const b=new OrderBookState();
  let v=b.deribit({data:{type:'snapshot',change_id:10,timestamp:1,bids:[['new',100,10]],asks:[['new',101,20]]}});
  assert.equal(v.bids[0][1],10);
  v=b.deribit({data:{type:'change',prev_change_id:10,change_id:11,timestamp:2,bids:[['change',100,15]],asks:[['delete',101,0],['new',102,5]]}});
  assert.equal(v.bids[0][1],15);assert.equal(v.asks[0][0],102);
});
