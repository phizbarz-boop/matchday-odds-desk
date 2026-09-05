// One-time / on-demand completed-season corner history builder.
// Fetches every completed fixture in configured API-Football leagues and stores
// full-time + actual 1H/2H corner splits in Redis (or data/*.json without Redis).

const { buildLeagueHistory } = require('../lib/cornerHistory');

function activeSeasonStartYear(now=new Date()){
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear()-1;
}

function csvNumbers(v){
  return String(v||'').split(',').map(x=>Number(x.trim())).filter(Number.isFinite);
}

async function main(){
  if(!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY)){
    throw new Error('API_FOOTBALL_KEY is required');
  }
  const season=Number(process.env.API_FOOTBALL_CORNER_HISTORY_SEASON)||activeSeasonStartYear()-1;
  // API-Football IDs: EPL, La Liga, Serie A, Bundesliga, Ligue 1.
  const leagueIds=csvNumbers(process.env.API_FOOTBALL_CORNER_HISTORY_LEAGUES||'39,140,135,78,61,2,40,88,94');
  if(!leagueIds.length) throw new Error('API_FOOTBALL_CORNER_HISTORY_LEAGUES is empty');
  const force=/^(1|true|yes)$/i.test(String(process.env.API_FOOTBALL_CORNER_HISTORY_FORCE||''));
  const maxFixtures=Number(process.env.API_FOOTBALL_CORNER_HISTORY_MAX_FIXTURES)||null;

  console.log(`[CornerHistory] season=${season} leagues=${leagueIds.join(',')} force=${force}`);
  let ok=0, failed=0;
  for(const leagueId of leagueIds){
    try{
      const h=await buildLeagueHistory(leagueId,season,{
        force,maxFixtures,
        onProgress:p=>console.log(`[CornerHistory] league ${leagueId}: ${p.done}/${p.total}, usable=${p.usable}, failed=${p.failed}`),
      });
      console.log(`[CornerHistory] DONE ${h.leagueName||leagueId}: ${h.usableMatches}/${h.fixtureCount} FT, ${h.firstHalfUsableMatches} with actual 1H corners`);
      ok++;
    }catch(err){
      failed++;
      console.error(`[CornerHistory] FAILED league ${leagueId}: ${err.message}`);
    }
  }
  console.log(`[CornerHistory] complete: ${ok} league(s) built, ${failed} failed`);
  if(!ok) process.exitCode=1;
}

main().catch(err=>{ console.error(err.stack||err.message||err); process.exit(1); });
