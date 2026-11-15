'use strict';
const rolloverPanel=document.getElementById('virtual-rollover');
const rolloverStatus=document.getElementById('rollover-status');
async function refreshRollOver(){
 rolloverStatus.textContent='Loading Roll Over…';
 try{
  const res=await fetch('/api/sportybet/virtual-rollover',{cache:'no-store'});
  const data=await res.json();
  rolloverStatus.textContent=res.ok&&typeof data.summary==='string'?data.summary:'Roll Over status is temporarily unavailable.';
 }catch{rolloverStatus.textContent='Roll Over status is temporarily unavailable.';}
}
rolloverPanel.addEventListener('toggle',()=>{if(rolloverPanel.open)void refreshRollOver();});
document.getElementById('rollover-refresh').addEventListener('click',refreshRollOver);
const rolloverPreviewButton=document.getElementById('rollover-preview');
rolloverPreviewButton.addEventListener('click',async()=>{
 const out=document.getElementById('rollover-test-result');
 rolloverPreviewButton.disabled=true;
 out.textContent='Checking virtual fixtures and saved results…';
 try{
  const res=await fetch('/api/sportybet/virtual-rollover/preview',{cache:'no-store'});
  const data=await res.json();
  if(!res.ok)throw Error(data.error||'Roll Over preview is temporarily unavailable.');
  const stats=`Fixtures: ${data.fixtures} · Open selections: ${data.offeredSelections} · Verified results: ${data.verifiedResults} · Match Stats panels used: ${data.statsFixtures??0}`;
  out.textContent=data.status==='preview'?
   [`Test preview · ${data.odds.toFixed(3)}x · Model estimate ${(data.modelProbability*100).toFixed(1)}% (assuming independent legs)`,
    ...data.selections.map(x=>`${x.home} vs ${x.away} — ${x.pick} @ ${x.odds}`),stats].join('\n'):
   [data.reason,stats].join('\n');
 }catch(err){out.textContent=err.message;}
 finally{rolloverPreviewButton.disabled=false;}
});
