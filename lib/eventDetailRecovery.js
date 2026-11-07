'use strict';
// A 404 on the public detail route can be a request-method mismatch. Retry
// the other supported method only after route resolution fails, never for a
// rate limit, authentication response, challenge or timeout.
function createEventDetailReader({read,method='GET',paramName='eventId',stamp=()=>null}){
 let preferred=method==='POST'?'POST':'GET';
 return async eventId=>{
  const queryMethod=preferred,attempt=async m=>{
   const params=m==='GET'?{[paramName]:eventId}:{};const t=stamp();if(m==='GET'&&t!=null)params._t=t;
   const payload=await read({method:m,params,body:m==='POST'?{[paramName]:eventId}:undefined,publicRead:true});
   const root=payload?.data??payload,event=root?.event??root,id=event?.eventId??event?.event_id;
   if(id!=null&&String(id)!==String(eventId))throw Object.assign(Error('SportyBet returned details for another fixture.'),{code:'SPORTYBET_EVENT_MISMATCH'});
   return payload;
  };
  try{return await attempt(queryMethod);}catch(error){
   if(error.code!=='SPORTYBET_ENDPOINT_UNKNOWN')throw error;
   const alternative=queryMethod==='GET'?'POST':'GET';
   const payload=await attempt(alternative);preferred=alternative;return payload;
  }
 };
}
module.exports={createEventDetailReader};
