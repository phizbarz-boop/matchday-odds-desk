'use strict';
// Full Chromium supports the third-party statistics widget more faithfully than
// the separate headless shell. GitHub provides a virtual display for headed mode.
function launchOptions(env=process.env){return {channel:'chromium',headless:env.H2H_BROWSER_HEADED!=='true'};}
function widgetLoader(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='widgets.sir.sportradar.com'&&/\/widgetloader\/?$/.test(u.pathname);}catch{return false;}}
function sourceFailure(events){
 const last=[...events].reverse().find(e=>widgetLoader('https://'+e.endpoint));
 return last?.type==='request_failed'&&/ERR_BLOCKED_BY_ORB/.test(last.error||'')?
  {h2hReason:'h2h_widget_loader_blocked',h2hStage:'widget_loader'}:null;
}
module.exports={launchOptions,widgetLoader,sourceFailure};
