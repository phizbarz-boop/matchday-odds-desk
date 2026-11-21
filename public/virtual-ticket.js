'use strict';
const markets=[['o05','Over 0.5'],['u45','Under 4.5'],['u55','Under 5.5'],['h35','1st half Under 3.5']];
const box=document.getElementById('virtual-ticket-markets');
box.innerHTML=markets.map(([id,label])=>`<label class="bet-toggle"><input type="checkbox" value="${id}" checked><span>${label}</span></label>`).join('');
const buttons=[document.getElementById('virtual-ticket-build'),document.getElementById('virtual-ticket-code')];
async function buildVirtualTicket(createCode){
 const status=document.getElementById('virtual-ticket-status');
 const out=document.getElementById('virtual-ticket-results');
 const chosen=[...box.querySelectorAll('input:checked')].map(input=>input.value);
 if(!chosen.length){status.className='auto-status err';status.textContent='Choose at least one bet type.';return;}
 buttons.forEach(button=>button.disabled=true);
 status.className='auto-status loading';
 status.textContent=createCode?'Building the virtual code…':'Checking the virtual board…';
 out.replaceChildren();
 try{
  const res=await fetch('/api/sportybet/virtual-ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:document.getElementById('virtual-session').value,markets:chosen,minProbability:Number(document.getElementById('virtual-min-prob').value),minOdds:Number(document.getElementById('virtual-min-odds').value),maxOdds:Number(document.getElementById('virtual-max-odds').value),maxLegs:Number(document.getElementById('virtual-max-legs').value),createCode})});
  const data=await res.json();
  if(!res.ok)throw Error(data.error||'Virtual ticket is unavailable.');
  if(data.status!=='preview'&&data.status!=='booked'){status.className='auto-status err';status.textContent=data.reason||'No virtual ticket matched those filters.';return;}
  status.className='auto-status ok';
  status.textContent=`${data.status==='booked'?'Code '+data.code:'Preview'} · ${Number(data.odds).toFixed(3)} combined · model ${(Number(data.modelProbability)*100).toFixed(1)}%`;
  if(data.link){
   const code=document.createElement('div');code.className='codebox';code.innerHTML=`<strong></strong><div class="code-actions"><a class="secondary" target="_blank" rel="noopener">Open SportyBet</a></div>`;
   code.querySelector('strong').textContent=data.code;code.querySelector('a').href=data.link;out.append(code);
  }
  for(const leg of data.selections||[]){
   const card=document.createElement('article');card.className='analysis-leg good';
   card.innerHTML='<div><div class="analysis-match"></div><div class="analysis-pick"></div></div><div class="analysis-metrics"><strong></strong><span></span></div>';
   card.querySelector('.analysis-match').textContent=`${leg.home} vs ${leg.away}`;
   card.querySelector('.analysis-pick').textContent=`${leg.pick} @ ${Number(leg.odds).toFixed(2)} · ${leg.qualified||'model'}`;
   card.querySelector('strong').textContent=`${Number(leg.probability).toFixed(1)}%`;
   card.querySelector('span').textContent=leg.yearRate==null?'Year n/a':`Year ${Number(leg.yearRate).toFixed(1)}%`;
   out.append(card);
  }
 }catch(err){status.className='auto-status err';status.textContent=err.message;}
 finally{buttons.forEach(button=>button.disabled=false);}
}
buttons[0].addEventListener('click',()=>buildVirtualTicket(false));
buttons[1].addEventListener('click',()=>buildVirtualTicket(true));

document.getElementById('virtual-session').addEventListener('change',()=>{
 const higher=document.getElementById('virtual-session').value==='higher';
 document.getElementById('virtual-min-odds').value=higher?'5.00':'1.20';
 document.getElementById('virtual-max-odds').value=higher?'20.00':'2.00';
 document.getElementById('virtual-max-legs').value=higher?'15':'3';
});
