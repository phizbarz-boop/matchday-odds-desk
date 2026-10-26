'use strict';
const reasons={external_worker_required:'H2H collection runs only in the external worker.',host_memory_pressure:'The host has too little free memory for an H2H browser. This selection keeps its original estimate.',browser_missing:'H2H browser is not installed. Rebuild with H2H enabled.',browser_dependencies:'The host is missing Chromium system dependencies.',browser_launch_failed:'The H2H browser could not start on this host.',page_timeout:'The public match page did not finish loading in time.',page_http_error:'The public match page returned an HTTP error.',stats_tab_unavailable:'The public match page did not expose its Stats tab.',h2h_panels_unavailable:'Neither public H2H panel could be read.',team_identity_unverified:'The displayed team names could not be matched to this fixture.',collection_cancelled:'The request ended before H2H collection completed.',h2h_read_failed:'The public H2H reader failed; check the Render H2H log.'};
function failure(error,stage='read'){
 const text=String(error?.message||''),hint=error?.h2hReason;
 const reason=hint&&reasons[hint]?hint:/executable.*doesn.t exist|executable.*not found|playwright install/i.test(text)?'browser_missing':/missing dependencies|error while loading shared libraries|lib[a-z0-9_-]+\.so/i.test(text)?'browser_dependencies':stage==='browser_launch'?'browser_launch_failed':stage==='stats_tab'?'stats_tab_unavailable':/timeout|timed out/i.test(text)?'page_timeout':'h2h_read_failed';
 return {reason,message:reasons[reason],stage:error?.h2hStage||stage};
}
module.exports={failure,reasons};
