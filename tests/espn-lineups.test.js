'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../lib/espnLineups'),S=require('../lib/sportyLineups');
const c={eventId:'sr:match:22',home:'Manchester City',away:'Arsenal',kickoffUtc:'2026-04-19T15:30Z'};
const now=()=>Date.parse('2026-04-19T15:10Z');
const game=(id,date,h,a,completed=false)=>({id,date,competitors:[{homeAway:'home',team:{id:h,displayName:h==='382'?'Manchester City':'Another FC'}},{homeAway:'away',team:{id:a,displayName:a==='359'?'Arsenal':'Other United'}}],status:{type:{completed}}});
const current=game('740916',c.kickoffUtc,'382','359');
const roster=id=>({team:{id},roster:Array.from({length:12},(_,i)=>({starter:i<11,athlete:{id:String(i+1),fullName:'Player '+i},position:{displayName:'Defender'}}))});
const summary=(g,rosters)=>({header:{competitions:[g]},rosters});
test('matches both teams in home/away order and rejects ambiguous events',()=>{
 const board={events:[{competitions:[current]}]};
 assert.equal(E.matchFixture(board,c),current);
 assert.equal(E.matchFixture(board,{...c,away:'Arsenal Women'}),null);
 assert.equal(E.matchFixture(board,{...c,kickoffUtc:'2026-04-19T19:30Z'}),null);
 assert.equal(E.matchFixture({events:[{competitions:[current,{...current,id:'999'}]}]},c),null);
});
test('current ESPN XI excludes substitutes and can be read through the shared evidence cache',async()=>{
 const collect=E.createCollector({now,request:async url=>url.includes('/scoreboard?')?{events:[{competitions:[current]}]}:summary(current,['382','359'].map(roster))});
 const e=await collect(c);
 assert.equal(e.players.length,22);assert.equal(e.basis,'confirmed');
 assert.ok(S.usable(e,c,now()));assert.ok(e.players.every(p=>p.startingLineupConfirmed&&p.name!=='Player 11'));
 const refreshed={...e,capturedAt:new Date().toISOString()};
 const read=await S.readOrQueue({get:async()=>JSON.stringify(refreshed)},c);
 assert.ok(read.every(p=>p.provider==='espn'&&p.basis==='confirmed'));
});
test('a recent completed XI stays historical and a mismatched prior match is rejected',async()=>{
 const date='2026-04-12T15:30Z',previous=game('333',date,'382','359',true);
 const upcoming={...summary(current,[]),lastFiveGames:['382','359'].map(id=>({team:{id},events:[{id:'333',gameDate:date,homeTeamId:'382',awayTeamId:'359'}]}))};
 const request=async url=>url.includes('/scoreboard?')?{events:[{competitions:[current]}]}:url.endsWith('740916')?upcoming:summary(previous,['382','359'].map(roster));
 const e=await E.createCollector({now,request})(c);
 assert.equal(e.basis,'usual');assert.ok(e.players.every(p=>!p.startingLineupConfirmed&&p.historyEventId==='333'));
 previous.competitors[1].team.id='999';
 assert.equal(await E.createCollector({now,request})(c),null);
});
