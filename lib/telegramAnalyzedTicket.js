const {ticketSignature}=require('./ticketVariation');
const {normalizedSport}=require('./telegramMixedSelector');
async function generateAnalyzedTicket(user,redis,deps){
 const last=user.lastAnalyzerRequest,plan=deps.getPlan(user);
 if(!last?.bookingCode)throw Error('Analyze a code first.');
 if(plan.dailyAnalyzes<=0)throw Error('Code analysis requires a paid plan.');
 if(!deps.hasCredit(user))throw Error('No ticket credits remain today.');
 const analysis=await deps.analyze(last.bookingCode,last.minProbability,last.horizonDays,!!last.replaceUnsupported,!!last.includeLive);
 const selections=analysis.analyzed.filter(c=>c.supported&&c.qualified&&Number(c.probability)>=Number(last.minProbability));
 if(!selections.length)throw Error('No selections meet your analysis probability setting. No ticket generated.');
 if(selections.length>Math.min(50,plan.maxSelections))throw Error(`Too many selections qualify. Your ticket limit is ${Math.min(50,plan.maxSelections)} games.`);
 if(new Set(selections.map(c=>String(c.eventId))).size!==selections.length)throw Error('The analysis contains multiple selections for the same match. Choose one before generating.');
 const allowed=new Set(plan.sports);if(!allowed.has('all')&&selections.some(c=>!allowed.has(normalizedSport(c))))throw Error('This ticket includes sports outside your plan.');
 const signature=ticketSignature(selections);if((user.ticketVariationHistory||[]).includes(signature))throw Error('This selection set already has a generated ticket. Use Rebuild for a different variation.');
 const booking=await deps.book(selections.map(c=>({eventId:c.eventId,marketId:c.marketId,outcomeId:c.outcomeId,...(c.specifier?{specifier:c.specifier}:{})})));
 if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('SportyBet did not confirm all qualified selections');
 const use=await deps.consume(redis,user,'ticket');if(!use.ok)throw Error('No ticket credits remain.');
 user=use.user;user.ticketVariationHistory=[...new Set([...(user.ticketVariationHistory||[]),signature])];await deps.save(redis,user);
 return {user,booking,analysis,selections,combinedOdds:selections.reduce((n,c)=>n*c.odds,1)};
}
module.exports={generateAnalyzedTicket};
