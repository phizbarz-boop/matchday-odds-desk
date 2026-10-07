(function(root,factory){
  const createBookingClient=factory();
  if(typeof module==='object'&&module.exports)module.exports={createBookingClient};
  else {
    let storage;try{storage=root.sessionStorage;}catch{}
    root.SportyBooking=createBookingClient({fetch:(...args)=>root.fetch(...args),storage,crypto:root.crypto});
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function createBookingClient({fetch,storage,crypto,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    requestTimeoutMs=15000,maxWaitMs=300000}={}) {
    const storageKey='plot207.booking.pending';let memory=null,active=null;
    const read=()=>{try{return JSON.parse(storage?.getItem(storageKey)||'null')||memory;}catch{return memory;}};
    const save=value=>{memory=value;try{if(value)storage?.setItem(storageKey,JSON.stringify(value));else storage?.removeItem(storageKey);}catch{}};
    function requestId() {
      if(crypto?.randomUUID)return crypto.randomUUID();
      if(!crypto?.getRandomValues)throw Error('This browser cannot create a booking request. Update your browser and try again.');
      const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const text=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      return text.slice(0,8)+'-'+text.slice(8,12)+'-'+text.slice(12,16)+'-'+text.slice(16,20)+'-'+text.slice(20);
    }
    async function request(url,options) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),requestTimeoutMs);
      try{
        const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});
        const body=await response.json();return {response,body};
      }finally{clearTimeout(timer);}
    }
    async function run(payload,onProgress) {
      const fingerprint=JSON.stringify(payload),old=read();
      const saved=old?.fingerprint===fingerprint?old:{requestId:requestId(),fingerprint};
      const resume=old?.fingerprint===fingerprint;save(saved);
      const start=now();let submitted=false,lastError=null,missing=0;
      while(now()-start<maxWaitMs) {
        onProgress({stage:'creating_code',resuming:resume||submitted});
        let result;
        try{
          if(!resume&&!submitted) {
            submitted=true;
            result=await request('/api/sportybet/book',{method:'POST',headers:{'Content-Type':'application/json','Prefer':'respond-async'},
              body:JSON.stringify({...payload,requestId:saved.requestId})});
          }else result=await request('/api/sportybet/book/status/'+saved.requestId);
        }catch(error){lastError=error;await wait(1500);continue;}
        const {response,body}=result;
        if(response.status===202){missing=0;onProgress(body);await wait(1500);continue;}
        if(response.status===404&&body.bookingRequestStatus==='missing'&&++missing<3){await wait(1500);continue;}
        if(!response.ok) {
          if(!body.bookingOutcomeUnknown)save(null);
          const message=body.authFailure?'SportyBet booking sign-in could not complete. '+(body.authFailure.reason||'Check the account session.')
            :[body.error,body.detail].filter(Boolean).join(' — ')||'Booking failed';
          throw Object.assign(Error(message),{bookingOutcomeUnknown:Boolean(body.bookingOutcomeUnknown)});
        }
        if(!(body.shareCode||body.bookingCode||body.booking_code||body.code))
          throw Object.assign(Error('SportyBet has not returned a booking code. Check this request again before creating another.'),{bookingOutcomeUnknown:true});
        save(null);return body;
      }
      throw Object.assign(Error(lastError?'The connection was interrupted. Click Generate again to check the same booking request.'
        :'Your booking is still processing. Click Generate again to check the same request.'),{bookingOutcomeUnknown:true});
    }
    function book(payload,{onProgress=()=>{}}={}) {
      const fingerprint=JSON.stringify(payload);
      if(active&&active.fingerprint===fingerprint)return active.promise;
      if(active)return Promise.reject(Error('Wait for the current booking to finish before generating another slip.'));
      const promise=run(payload,onProgress);active={fingerprint,promise};
      promise.finally(()=>{active=null;}).catch(()=>{});return promise;
    }
    return {book};
  }
  return createBookingClient;
});
