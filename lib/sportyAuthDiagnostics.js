'use strict';
const STAGES=new Set(['configuration','launch','context','cookies','navigation','page_check','account_check','form_ready','phone_entry','password_entry','remember_session','submit','verification']);
const REASONS=new Set(['credentials_required','invalid_login_origin','unexpected_login_origin','verification_required','browser_verification_required',
  'sign_in_rejected','login_form_changed','browser_not_installed','browser_unavailable','browser_login_timeout','browser_login_error',
  'browser_navigation_timeout','browser_network_error','browser_page_timeout','browser_form_timeout','browser_context_failed','browser_cookie_seed_failed',
  'browser_login_http_error','browser_account_http_error','browser_account_response_error','browser_proxy_invalid','browser_proxy_auth_unsupported','browser_closed']);
const NETWORK_CODES=new Set(['ERR_NAME_NOT_RESOLVED','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED','ERR_PROXY_CONNECTION_FAILED','ERR_TUNNEL_CONNECTION_FAILED','ERR_CERT_AUTHORITY_INVALID','ERR_CERT_DATE_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID','ERR_TOO_MANY_REDIRECTS','ERR_HTTP_RESPONSE_CODE_FAILURE','ERR_INTERNET_DISCONNECTED',
  'ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','EHOSTUNREACH']);

// Only fixed identifiers and bounded numeric status codes cross into logs,
// scheduler status or public responses. Never copy Playwright call logs.
function safeAuthDiagnostics(error) {
  if(error?.code!=='SPORTYBET_AUTH_FAILED')return null;
  const value=error.diagnostics||error;
  const result={code:'SPORTYBET_AUTH_FAILED',requiresUserAction:Boolean(error.requiresUserAction)};
  const reason=REASONS.has(value.reason)?value.reason:REASONS.has(error.reason)?error.reason:null;
  if(reason)result.reason=reason;
  if(STAGES.has(value.stage))result.stage=value.stage;
  if(NETWORK_CODES.has(value.networkCode))result.networkCode=value.networkCode;
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)result.httpStatus=value.httpStatus;
  if(Number.isInteger(value.bizCode)&&value.bizCode>=10000&&value.bizCode<=99999)result.bizCode=value.bizCode;
  if(typeof value.proxyConfigured==='boolean')result.proxyConfigured=value.proxyConfigured;
  return result;
}
function networkCode(error) {
  const text=String(error?.message||'');
  for(const code of NETWORK_CODES)if(text.includes(code)||error?.code===code)return code;
  return null;
}
module.exports={safeAuthDiagnostics,networkCode};
