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
