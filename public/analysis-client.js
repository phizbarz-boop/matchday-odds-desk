(function(root){
 async function readJson(response){
  const raw=await response.text();if(!raw.trim())throw Error(`The server returned an empty response (HTTP ${response.status}). The request did not return a confirmed result. Please retry.`);
  let value;try{value=JSON.parse(raw);}catch{throw Error(`The server returned an invalid response (HTTP ${response.status}). It may be restarting or the request timed out. Please retry.`);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`The server returned an invalid result (HTTP ${response.status}). Please retry.`);
  return value;
 }
 async function request(url,body,{fetchImpl=root.fetch.bind(root),wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,maxWaitMs=300000}={}){
  let response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','x-plot207-background':'1'},body:JSON.stringify(body)}),data=await readJson(response);
  if(response.status!==202)return {response,data};
  const path=String(data.statusUrl||'');if(!/^\/api\/sportybet\/analysis-jobs\/[a-f0-9-]{36}$/.test(path))throw Error('The analyser returned an invalid job reference. Please retry.');
  const started=now();let failures=0;
  while(now()-started<maxWaitMs){await wait(1000);try{response=await fetchImpl(path,{cache:'no-store'});data=await readJson(response);if(response.status===202){failures=0;continue;}if(response.status>=500&&data.code!=='ANALYSIS_TIMEOUT'&&data.code!=='ANALYSIS_FAILED'&&data.code!=='ANALYSIS_NO_RESULT'){if(++failures<8)continue;}return {response,data};}catch(e){if(++failures>=8)throw e;}}
  throw Error('The analyser is still taking too long. No booking was submitted. Please try again with fewer sports or markets.');
 }
 root.SportyAnalysis={readJson,request};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.SportyAnalysis;
})(typeof window!=='undefined'?window:globalThis);
