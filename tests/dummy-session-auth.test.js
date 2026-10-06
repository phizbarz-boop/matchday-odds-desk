'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const direct=require('../lib/sportybetDirect');
test('a visitor device cookie cannot satisfy the dummy account login requirement',async()=>{
  const s=direct._session,original={...s,cookies:new Map(s.cookies)};
  const saved={phone:process.env.SPORTYBET_PHONE,password:process.env.SPORTYBET_PASSWORD};
  try {
    process.env.SPORTYBET_PHONE='';process.env.SPORTYBET_PASSWORD='';
    s.loaded=true;s.token=null;s.cookies=new Map([['deviceId',{value:'visitor',expiresAt:Date.now()+60000}]]);
    assert.equal(direct.hasAuthenticatedSession(),false);assert.equal(direct.sessionStatus().loggedIn,false);
    await assert.rejects(direct.ensureSession(),err=>err.code==='SPORTYBET_NOT_CONFIGURED');
    s.cookies.set('accessToken',{value:'test-token',expiresAt:Date.now()+60000});
    assert.equal(direct.hasAuthenticatedSession(),true);await direct.ensureSession();
    s.cookies.set('accessToken',{value:'expired',expiresAt:Date.now()-1});assert.equal(direct.hasAuthenticatedSession(),false);
  } finally {Object.assign(s,original);if(saved.phone==null)delete process.env.SPORTYBET_PHONE;else process.env.SPORTYBET_PHONE=saved.phone;
    if(saved.password==null)delete process.env.SPORTYBET_PASSWORD;else process.env.SPORTYBET_PASSWORD=saved.password;}
});
