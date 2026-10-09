const test=require('node:test'),assert=require('node:assert/strict');
const {fakeRedis}=require('./fixtures/fake-redis');
const bot=require('../lib/telegramAiBot');
test('activation survives fresh module load and stale builder saves',async()=>{
 const redis=fakeRedis(),stale=await bot.getUser(redis,'123');
 await bot.activatePlan(redis,'123','elite',30);
 stale.preferences.builder.targetOdds=20;await bot.saveUser(redis,stale);
 delete require.cache[require.resolve('../lib/telegramAiBot')];
 const restarted=require('../lib/telegramAiBot');
 assert.equal((await restarted.getUser(redis,'123')).plan,'elite');
});
test('activation refuses temporary memory storage',async()=>{
 await assert.rejects(bot.activatePlan(null,'123','pro',30),/persistent Redis/);
});
test('storage read failures do not replace paid membership with free',async()=>{
 const redis=fakeRedis();await bot.activatePlan(redis,'123','pro',30);
 const raw=await redis.get('telegram:ai:user:123');redis.get=async()=>{throw Error('offline')};
 await assert.rejects(bot.getUser(redis,'123'),/offline/);
 assert.equal(JSON.parse(raw).plan,'pro');
});
