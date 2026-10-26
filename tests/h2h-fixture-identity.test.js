'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {slug,containsTeam,verifyIdentity}=require('../lib/h2hFixtureIdentity');
const {urlFor}=require('../lib/sportyH2h');
test('team and tournament slugs never contain encoded path separators from the captured failing links',()=>{
 for(const team of ['Wilkes-Barre/Scranton Penguins','HK Zemgale/Llu','A\\B']){
  const url=urlFor({eventId:'sr:match:72732582',sport:'Ice Hockey',home:'Utica Comets',away:team,tournament:'AHL'});
  assert.doesNotMatch(url,/%2f|%5c/i);assert.equal(new URL(url).pathname.split('/').length,9);
 }
 assert.equal(slug('HK Zemgale/Llu'),'HK_Zemgale_Llu');
 assert.equal(slug(' A / B '),'A_B');
});
test('identity accepts presentation whitespace and underscores but retains youth and word boundaries',()=>{
 assert.ok(containsTeam('Vaasan Sport U20','Vaasan_Sport_U20'));
 assert.ok(containsTeam('Vaasan\nSport\u00a0U20','Vaasan Sport U20'));
 assert.ok(!containsTeam('Vaasan Sport U20','Vaasan Sport U21'));
 assert.ok(!containsTeam('NotJYP','JYP'));
});
test('verification reads current fixture header and never uses historical or future opponents as identity',async()=>{
 const fixture={home:'Vaasan Sport U20',away:'JYP'},page=text=>({locator:()=>({innerText:async()=>text})});
 assert.equal(await verifyIdentity(page('Details\nVaasan Sport U20\nJYP\nMarkets\nStats'),fixture,{timeoutMs:0}),true);
 await assert.rejects(verifyIdentity(page('Details\nOther Team\nOther Opponent\nMarkets\nStats\nVaasan Sport U20\nJYP'),fixture,{timeoutMs:0}),e=>e.h2hReason==='team_identity_unverified'&&e.h2hIdentityDebug.expectedAway==='JYP');
});
test('identity retries a briefly rerendering header and honors cancellation',async()=>{
 let calls=0;const fixture={home:'Vaasan Sport U20',away:'JYP'},page={locator:()=>({innerText:async()=>++calls===1?'Details\nMarkets':'Details\nVaasan Sport U20\nJYP\nMarkets'})};
 assert.equal(await verifyIdentity(page,fixture,{timeoutMs:500}),true);assert.equal(calls,2);
 const controller=new AbortController();controller.abort();
 await assert.rejects(verifyIdentity(page,fixture,{signal:controller.signal}),e=>e.h2hReason==='collection_cancelled');
});
