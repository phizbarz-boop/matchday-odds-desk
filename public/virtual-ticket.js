'use strict';
const markets=[['o05','Over 0.5'],['u45','Under 4.5'],['u55','Under 5.5'],['h35','1st half Under 3.5'],['h25','1st half Under 2.5'],['h15','1st half Under 1.5']];
const box=document.getElementById('virtual-ticket-markets');
box.innerHTML=markets.map(([id,label])=>`<label class="bet-toggle"><input type="checkbox" value="${id}" checked><span>${label}</span></label>`).join('');
const buttons=[document.getElementById('virtual-ticket-build'),document.getElementById('virtual-ticket-code')];
let ticket=null;
function ticketRequest(){
 const chosen=[...box.querySelectorAll('input:checked')].map(input=>input.value);
 return {session:document.getElementById('virtual-session').value,markets:chosen,minProbability:document.getElementById('virtual-min-prob').value===''?75:Number(document.getElementById('virtual-min-prob').value),minOdds:Number(document.getElementById('virtual-min-odds').value),maxOdds:Number(document.getElementById('virtual-max-odds').value),maxLegs:Number(document.getElementById('virtual-max-legs').value),trustedOnly:document.getElementById('virtual-trusted').checked};
}
function renderTicket(data){
 ticket=data;
 const status=document.getElementById('virtual-ticket-status');
 const out=document.getElementById('virtual-ticket-results');
 const selections=data.selections||[];
 const odds=selections.reduce((total,leg)=>total*Number(leg.odds||1), selections.length?1:0);
 const probability=selections.reduce((total,leg)=>total*(Number(leg.probability)||0)/100, selections.length?1:0);
 out.replaceChildren();
 if(!selections.length){status.className='auto-status err';status.textContent='All games were removed.';return;}
 status.className='auto-status ok';
 status.textContent=`${data.status==='booked'&&data.code?'Code '+data.code:'Preview'} · ${odds.toFixed(3)} combined · model ${(probability*100).toFixed(1)}%`;
 if(data.link&&data.code){
  const code=document.createElement('div');code.className='codebox';code.innerHTML='<strong></strong><div class="code-actions"><a class="secondary" target="_blank" rel="noopener">Open SportyBet</a></div>';
  code.querySelector('strong').textContent=data.code;code.querySelector('a').href=data.link;out.append(code);
 }
 const again=document.createElement('button');
 again.type='button';again.className='primary';again.textContent='Regenerate code';
 again.addEventListener('click',regenerateCode);
 out.append(again);
 for(const [index,leg] of selections.entries()){
  const card=document.createElement('article');card.className='analysis-leg good';
  card.innerHTML='<div><div class="analysis-match"></div><div class="analysis-pick"></div><button type="button" class="secondary">Remove</button></div><div class="analysis-metrics"><strong></strong><span></span></div>';
  card.querySelector('.analysis-match').textContent=`${leg.home} vs ${leg.away}`;
  card.querySelector('.analysis-pick').textContent=`${leg.pick} @ ${Number(leg.odds).toFixed(2)} · ${leg.qualified||'model'}`;
  card.querySelector('strong').textContent=`${Number(leg.probability).toFixed(1)}%`;
  card.querySelector('span').textContent=leg.yearRate==null?'Year n/a':`Year ${Number(leg.yearRate).toFixed(1)}%`;
  card.querySelector('button').addEventListener('click',()=>renderTicket({status:'preview',selections:selections.filter((_,item)=>item!==index)}));
  out.append(card);
 }
}
async function buildVirtualTicket(createCode){
 const status=document.getElementById('virtual-ticket-status');
 const out=document.getElementById('virtual-ticket-results');
 const request=ticketRequest();
 if(!request.markets.length){status.className='auto-status err';status.textContent='Choose at least one bet type.';return;}
 buttons.forEach(button=>button.disabled=true);
 status.className='auto-status loading';
 status.textContent=createCode?'Building the virtual code…':'Checking the virtual board…';
 out.replaceChildren();
 try{
  const res=await fetch('/api/sportybet/virtual-ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...request,createCode})});
  const data=await res.json();
  if(!res.ok)throw Error(data.error||'Virtual ticket is unavailable.');
  if(data.status!=='preview'&&data.status!=='booked'){status.className='auto-status err';status.textContent=data.reason||'No virtual ticket matched those filters.';return;}
  renderTicket(data);
 }catch(err){status.className='auto-status err';status.textContent=err.message;}
 finally{buttons.forEach(button=>button.disabled=false);}
}
async function regenerateCode(){
 const status=document.getElementById('virtual-ticket-status');
 const kept=ticket?.selections||[];
 if(!kept.length){status.className='auto-status err';status.textContent='Keep at least one game.';return;}
 const control=document.querySelector('#virtual-ticket-results .primary');
 if(control)control.disabled=true;
 status.className='auto-status loading';
 status.textContent='Generating a new code for the remaining games…';
 try{
  const res=await fetch('/api/sportybet/virtual-ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...ticketRequest(),rebook:true,selections:kept})});
  const data=await res.json();
  if(!res.ok)throw Error(data.error||'The new code was not created.');
  if(data.status!=='booked'){status.className='auto-status err';status.textContent=data.reason||'The remaining games could not be booked.';return;}
  renderTicket(data);
 }catch(err){status.className='auto-status err';status.textContent=err.message;if(control)control.disabled=false;}
}
buttons[0].addEventListener('click',()=>buildVirtualTicket(false));
buttons[1].addEventListener('click',()=>buildVirtualTicket(true));

document.getElementById('virtual-session').addEventListener('change',()=>{
 const session=document.getElementById('virtual-session').value;
 const maxUnder=session==='max-under', higher=session==='higher';
 document.getElementById('virtual-min-odds').value=maxUnder?'1.05':higher?'5.00':'1.20';
 document.getElementById('virtual-max-odds').value=maxUnder?'2000':higher?'20.00':'2.00';
 document.getElementById('virtual-max-legs').value=maxUnder?'20':higher?'15':'3';
 if(document.getElementById('virtual-min-prob').value==='')document.getElementById('virtual-min-prob').value='75';
 box.querySelectorAll('input').forEach(input=>{input.checked=maxUnder?input.value!=='o05':true;});
});
