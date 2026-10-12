const crypto=require('node:crypto');
function ticketSignature(rows){return crypto.createHash('sha256').update(JSON.stringify((rows||[]).map(c=>JSON.stringify([String(c.eventId||''),String(c.marketId||''),String(c.outcomeId||''),String(c.specifier||'')])).sort())).digest('hex');}
function exclusions(value){if(value==null)return new Set();if(!Array.isArray(value)||value.length>2000||value.some(x=>typeof x!=='string'||!/^([a-f0-9]{64})$/.test(x)))throw Error('Invalid previous-ticket history');return new Set(value);}
module.exports={ticketSignature,exclusions};
