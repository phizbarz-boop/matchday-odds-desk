const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {fakeRedis}=require('./fixtures/fake-redis');
const source=fs.readFileSync(require.resolve('../server'),'utf8');
function load(){const c=vm.createContext({console,telegramDailyCodesMemory:new Map(),telegramQuickCashCodesMemory:new Map(),telegramNext12hCodesMemory:new Map()});vm.runInContext(source.slice(source.indexOf('function telegramDailyCodesKey('),source.indexOf('async function saveTelegramNext12hCode('))+'\nthis.save=saveTelegramDailyCodes;this.read=loadTelegramDailyCodes;',c);return c;}
test('concurrent daily writes retain all SAFE, manual and hourly codes after restart',async()=>{
 const redis=fakeRedis(),app=load(),day='2026-10-09';
 await Promise.all(['SAFE','MANUAL','LIVE'].map(shareCode=>app.save(redis,day,{codes:[{shareCode,targetOdds:shareCode,combinedOdds:3}]})));
 await app.save(redis,day,{codes:[{shareCode:'SAFE2',targetOdds:'SAFE',combinedOdds:4}]});
 const cold=load(),saved=await cold.read(redis,day);
 assert.deepEqual([...saved.codes.map(c=>c.shareCode)].sort(),['LIVE','MANUAL','SAFE','SAFE2']);
 await cold.save(redis,day,{codes:[{shareCode:'SAFE2',targetOdds:'SAFE',combinedOdds:4}]});
 assert.equal((await load().read(redis,day)).codes.length,4);
});
