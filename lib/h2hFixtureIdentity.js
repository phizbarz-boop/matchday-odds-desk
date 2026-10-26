'use strict';
function slug(value){return encodeURIComponent(String(value||'Match').trim().replace(/[\\/\s]+/g,'_'));}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[_\s\u200b\ufeff]+/g,' ').trim();}
function containsTeam(text,team){const hay=' '+normalize(text)+' ',needle=normalize(team);return needle.length>0&&hay.includes(' '+needle+' ');}
async function verifyIdentity(page,fixture,{signal,timeoutMs=2500}={}){
 const deadline=Date.now()+timeoutMs;let text='';
 do{
  if(signal?.aborted)throw Object.assign(Error('H2H cancelled'),{h2hReason:'collection_cancelled'});
  try{text=await page.locator('body').innerText({timeout:Math.max(1,Math.min(1000,deadline-Date.now()))});}catch{}
  // Restrict verification to the fixture header; historical opponents in the
  // panel or future fixture lists must not establish the current match identity.
  const header=text.split(/\n\s*Markets\s*\n/i)[0].slice(0,2000);
  if(containsTeam(header,fixture.home)&&containsTeam(header,fixture.away))return true;
  if(Date.now()>=deadline)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }while(Date.now()<deadline);
 throw Object.assign(Error('H2H team identity could not be verified'),{h2hReason:'team_identity_unverified',h2hIdentityDebug:{expectedHome:String(fixture.home||'').slice(0,240),expectedAway:String(fixture.away||'').slice(0,240),header:text.split(/\n\s*Markets\s*\n/i)[0].slice(0,2000)}});
}
module.exports={slug,normalize,containsTeam,verifyIdentity};
