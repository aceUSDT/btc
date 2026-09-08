import test from 'node:test';
import assert from 'node:assert/strict';
import { StructureEngine } from '../src/structure-engine.js';

test('builds live VWAP and volume profile from normalized spot trades',()=>{
  const s=new StructureEngine({retentionMs:86400000,maxTrades:1000});
  const t=Date.now();
  for(let i=0;i<100;i++)s.recordTrade({event_time_ms:t-100000+i*1000,price:80000+i,notional_usd:10000+(i%5)*1000,qty:.1,side:i%2?'buy':'sell',venue:'Test',market_type:'spot'});
  const x=s.snapshot(80100);
  assert.equal(x.status,'LIVE');
  assert.ok(x.ohlc.h1.high>=x.ohlc.h1.low);
  assert.ok(x.vwap.day.vwap>0);
  assert.equal(x.volume_profile.h4.status,'LIVE');
  assert.ok(x.volume_profile.h4.poc>0);
});

test('exposes previous day/week/month reference levels when bootstrapped references exist',()=>{
  const s=new StructureEngine();
  s.reference.daily=[{time:1,open:1,high:2,low:.5,close:1.5,source:'x',status:'REFERENCE'},{time:2,open:2,high:3,low:1,close:2.5,source:'x',status:'REFERENCE'}];
  s.reference.weekly=[{time:1,open:10,high:20,low:5,close:15,source:'x',status:'REFERENCE'},{time:2,open:20,high:30,low:10,close:25,source:'x',status:'REFERENCE'}];
  s.reference.monthly=[{time:1,open:100,high:200,low:50,close:150,source:'x',status:'REFERENCE'},{time:2,open:200,high:300,low:100,close:250,source:'x',status:'REFERENCE'}];
  const x=s.snapshot(1000);
  assert.equal(x.levels.previous_day.high,2);
  assert.equal(x.levels.previous_week.high,20);
  assert.equal(x.levels.previous_month.high,200);
});
