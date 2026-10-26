'use strict';
const cancelled=()=>Object.assign(Error('H2H collection cancelled'),{h2hReason:'collection_cancelled'});
async function visibleFrame(page,frame){return frame===page.mainFrame()||await(await frame.frameElement()).isVisible();}
async function clickTab(page,name,{timeoutMs=8000,signal}={}){
 const pattern=name==='new'?/^H2H\s*\(\s*New\s*\)$/i:name==='old'?/^H2H$/i:/^Stats$/i,deadline=Date.now()+timeoutMs;
 do{if(signal?.aborted)throw cancelled();for(const frame of page.frames())try{if(!await visibleFrame(page,frame))continue;const locators=await frame.getByText(pattern).all();for(const locator of locators)if(await locator.isVisible()){await locator.click({timeout:Math.max(1,Math.min(1500,deadline-Date.now()))});return true;}}catch{}
 if(Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,150));}while(Date.now()<deadline);
 return false;
}
async function panelText(page,pattern,{timeoutMs=12000,signal,rejectPattern=null}={}){
 const deadline=Date.now()+timeoutMs;let lastText='';
 do{if(signal?.aborted)throw cancelled();for(const frame of page.frames())try{if(!await visibleFrame(page,frame))continue;const text=await frame.locator('body').innerText({timeout:500});if(text.length>lastText.length)lastText=text;if(pattern.test(text)&&(!rejectPattern||!rejectPattern.test(text)))return text;}catch{}
 if(Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,150));}while(Date.now()<deadline);
 throw Object.assign(Error('H2H panel content unavailable'),{h2hReason:'h2h_panels_unavailable',h2hPanelDebug:{text:lastText.slice(0,6000),textLength:lastText.length,frames:page.frames().length}});
}
async function readPanels(page,{signal,timeoutMs=25000}={}){
 const deadline=Date.now()+timeoutMs,remaining=max=>Math.max(0,Math.min(max,deadline-Date.now())),diagnostics={frames:page.frames().length,newTab:false,oldTab:false,newPanel:false,oldPanel:false},panelDebug={};let oldText='',newText='';
 // Read the new summary first; keep it even when the old view has no usable content.
 for(const name of ['new','old']){
  if(signal?.aborted)throw cancelled();if(Date.now()>=deadline)break;
  const clicked=await clickTab(page,name,{signal,timeoutMs:remaining(5000)});diagnostics[name+'Tab']=clicked;if(!clicked)continue;
  try{const pattern=name==='new'?/head\s+to\s+head\s+team\s+averages|season\s+statistics|surface\s+win\s+rate/i:/previous\s+meetings|last\s+5\s+matches/i;const text=await panelText(page,pattern,{signal,timeoutMs:remaining(name==='new'?10000:5000),rejectPattern:name==='old'?/head\s+to\s+head\s+team\s+averages|season\s+statistics|surface\s+win\s+rate/i:null});if(name==='new')newText=text;else oldText=text;diagnostics[name+'Panel']=true;}catch(error){panelDebug[name]=error.h2hPanelDebug||{reason:error.h2hReason||'panel_read_failed'};if(signal?.aborted)throw cancelled();}
 }
 if(!newText&&!oldText)throw Object.assign(Error('H2H views could not be read'),{h2hReason:!diagnostics.newTab&&!diagnostics.oldTab?'h2h_tabs_unavailable':'h2h_panels_unavailable',h2hDiagnostics:diagnostics,h2hPanelDebug:panelDebug});
 return {oldText,newText,diagnostics};
}
module.exports={clickTab,panelText,readPanels};
