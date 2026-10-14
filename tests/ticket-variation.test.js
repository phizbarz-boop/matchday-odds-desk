const test=require('node:test'),assert=require('node:assert/strict');
const {ticketSignature}=require('../lib/ticketVariation');const {selectAutoBet}=require('../lib/autoPicker');const bot=require('../lib/telegramAiBot');
const c=id=>({eventId:id,marketId:'1',outcomeId:'1',odds:2,probability:80,qualityScore:80,edge:0,fullWinProbability:80});
test('ticket identity ignores order and odds changes but distinguishes outcomes and specifiers',()=>{
 assert.equal(ticketSignature([c('1'),c('2')]),ticketSignature([{...c('2'),odds:3},c('1')]));assert.notEqual(ticketSignature([c('1')]),ticketSignature([{...c('1'),outcomeId:'2'}]));assert.notEqual(ticketSignature([c('1')]),ticketSignature([{...c('1'),specifier:'total=2.5'}]));
});
test('regeneration never returns an excluded combination and preserves candidate filters',()=>{
 const rows=[c('1'),c('2'),c('3')],first=selectAutoBet(rows,{targetOdds:4,maxSelections:2});
 const second=selectAutoBet(rows,{targetOdds:4,maxSelections:2,excludedTickets:new Set([ticketSignature(first.selections)]),requireTarget:true});assert.equal(second.reachedTarget,true);assert.notEqual(ticketSignature(first.selections),ticketSignature(second.selections));assert.ok(second.selections.every(c=>c.probability===80));
});
test('no alternative returns no ticket instead of repeating or dropping the target',()=>{
 const rows=[c('1'),c('2')];const result=selectAutoBet(rows,{targetOdds:4,maxSelections:2,excludedTickets:new Set([ticketSignature(rows)]),requireTarget:true});assert.equal(result.selections.length,0);
});
test('analyzer results expose an explicit generation action and Elite markets expose extra models',async()=>{
 assert.ok(bot.analyzerAnalysisKeyboard().inline_keyboard.flat().some(b=>b.callback_data==='analyzer:generate:last'));
 const user=await bot.getUser(null,'keyboard');user.plan='elite';assert.ok(bot.marketsKeyboard(user).inline_keyboard.flat().some(b=>b.callback_data==='builder:extra'));
});
test('exact market identity prevents the analyzer scoring a different bet on the same fixture',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../server'),'utf8'),start=source.indexOf('function analyzerSpecifier('),end=source.indexOf('function isGenericAnalyzerSelection',start);
 const ctx=vm.createContext({analyzerNormText:x=>String(x||'').toLowerCase(),analyzerTeamMatch:(a,b)=>a===b});vm.runInContext(source.slice(start,end)+';this.score=analyzerCandidateScore;',ctx);
 assert.equal(ctx.score({eventId:'1',marketId:'900',outcomeId:'yes'},{eventId:'1',marketId:'1',outcomeId:'home'}),-1);
 assert.ok(ctx.score({eventId:'1',marketId:'900',outcomeId:'yes'},{eventId:'1',marketId:'900',outcomeId:'yes'})>=60);
});
