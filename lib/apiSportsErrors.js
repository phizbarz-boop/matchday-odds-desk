'use strict';
function providerError(status,errors,{sport,path}={}){
 const text=JSON.stringify(errors||{}).slice(0,8000).toLowerCase(),fields=Object.keys(errors||{}).filter(k=>/^(?:requests|rateLimit|plan|season|parameters|search|country|team|h2h|date|timezone|token)$/i.test(k));
 let code='API_REQUEST_REJECTED',reason='The provider rejected the request; inspect the endpoint and error fields.';
 if(status===401||status===403){code='API_AUTH_FAILED';reason='The API did not authorize this request.';}
 else if(/(?:daily|per day|for the day|day.*limit|limit.*day)/.test(text)&&/limit|quota|request/.test(text)){code='API_DAILY_QUOTA';reason='The provider daily quota is exhausted.';}
 else if(status===429||/too many|rate.?limit|per minute|minute.*limit|limit.*minute/.test(text)){code='API_RATE_LIMIT';reason='The provider rejected the request because of its rate limit.';}
 else if(/free plan|subscription|subscribed|plan|access.*season|season.*access/.test(text)){code='API_PLAN_RESTRICTED';reason='The API plan does not permit the requested data or season.';}
 else if(fields.some(k=>/^(?:parameters|search|country|team|h2h|date|timezone)$/i.test(k))){code='API_PARAMETERS_REJECTED';reason='The provider rejected one or more request parameters.';}
 return Object.assign(Error(code),{code,apiDiagnostics:{sport,path,httpStatus:status,reason,errorFields:fields}});
}
function safeDiagnostics(error){return error?.apiDiagnostics||undefined;}
module.exports={providerError,safeDiagnostics};
