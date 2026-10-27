'use strict';
const lines=t=>String(t||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
function parsePanel(text){
 const a=lines(text),start=a.findIndex(x=>/^head to head team averages$/i.test(x)),end=a.findIndex((x,i)=>i>start&&/^win probability$/i.test(x)),metrics={};
 const known={'corners':'corners','goals scored':'goals','total goals':'goals','total points':'points','total cards':'cards','ht total':'half_goals','1ht total pts':'half_points','1q pts':'quarter_points','p1 total':'period_goals'};
 if(start>=0&&end>start)for(let i=start+1;i<end;i++){const name=known[a[i].toLowerCase()];if(name&&/^\d+(\.\d+)?$/.test(a[i+1]||''))metrics[name]=Number(a[i+1]);}
 const counts=[];for(let i=0;i<a.length;i++)if(/^matches played$/i.test(a[i])){const v=[a[i-2],a[i-1],a[i+1],a[i+2]].map(Number);if(v.every(n=>Number.isInteger(n)&&n>=0&&n<=200))counts.push(Math.min(v[1],v[3]));}
 const games=[];for(let i=0;i<a.length;i++){if(!/^\d{1,2} [A-Z]{3}, \d{4}(?:\||$)/i.test(a[i]))continue;const date=Date.parse(a[i].split('|')[0].trim()+' 00:00:00 GMT');if(!Number.isFinite(date))continue;const window=a.slice(i+1,i+13);for(let j=1;j<window.length-2;j++)if(window[j+1]===':'&&/^\d+$/.test(window[j])&&/^\d+$/.test(window[j+2])){games.push({date:new Date(date).toISOString(),home:window[j-1],away:window[j+3],homeScore:Number(window[j]),awayScore:Number(window[j+2])});break;}}
 return {metrics,sampleCount:counts[0]??null,games};
}
function combine(oldText,newText,fixture,now=new Date()){
 const old=parsePanel(oldText),current=parsePanel(newText),limit=Math.min(+now,Date.parse(fixture.kickoffUtc)||+now),seen=new Set();
 const games=[...current.games,...old.games].filter(g=>{const k=[g.date,...[g.home,g.away].sort()].join('|');if(Date.parse(g.date)>=limit||seen.has(k))return false;seen.add(k);return true;});
 return {eventId:String(fixture.eventId),home:fixture.home,away:fixture.away,sport:fixture.sport,capturedAt:now.toISOString(),oldAvailable:oldText.length>100,newAvailable:newText.length>100,metrics:current.metrics,sampleCount:current.sampleCount,games};
}
function poissonUnder(mean,line){if(!(mean>=0)||mean>150)return null;let p=Math.exp(-mean),sum=p;for(let i=1;i<=Math.floor(line);i++){p*=mean/i;sum+=p;}return Math.max(0,Math.min(100,sum*100));}
function assess(c,evidence,now=new Date()){
 if(!require('./h2hScope').enabled(c))return require('./h2hScope').skipped(c);
 let verified=false;const result={...c};const games=evidence?.games||[];const dates=games.map(g=>g.date).sort();const tag=(status,allowed=true,extra={})=>({...result,h2hCheck:{status,allowed,verified,provider:evidence?.provider||'sportybet',historyBasis:evidence?.historyBasis||'sportybet_page_summary',historyRecords:games.length,historyFrom:dates[0]||null,historyTo:dates.at(-1)||null,...extra}});
 if(!evidence||!Number.isFinite(Date.parse(evidence.capturedAt))||String(evidence.eventId)!==String(c.eventId)||evidence.home!==c.home||evidence.away!==c.away||+now-Date.parse(evidence.capturedAt)>require('./h2hCache').maxAgeMs()||Date.parse(evidence.capturedAt)>+now+60000)return tag('unavailable_or_stale',true,{verified:false});
 if(!evidence.oldAvailable&&!evidence.newAvailable)return tag('unavailable_h2h_views',true,{verified:false});
 verified=true;
 const label=String(c.marketDesc||'').toLowerCase(),side=String(c.outcomeDesc||'').toLowerCase();
 const namedTeamTotal=[c.home,c.away].some(team=>{const name=String(team||'').trim().toLowerCase();return name&&label.startsWith(name+' ')&&/total|over\s*\/\s*under/.test(label);});
 let scope=Boolean(require('./doubleChanceUnderMarkets').describe(c))||namedTeamTotal||/half|period|quarter|minute|player|\bhome\b|\baway\b|sets?\b|handicap|spread|row|goal kick|throw|rebounds|shots/.test(label);
 // History of goals cannot supply corners, shots, player stats or scoring order.
 let metric=/corner/.test(label)?'corners':/card/.test(label)?'cards':/basket/i.test(c.sport||'')?'points':/football|soccer|handball|hockey/i.test(c.sport||'')?'goals':null;
 const periodType=require('./basketballPeriodMarkets').betTypeFor(c);
 if(evidence.provider==='api_sports'&&/football|soccer/i.test(c.sport||'')&&/^shots on target over\s*\/\s*under$/.test(label)){scope=false;metric='shots_target';}
 if(/volley/i.test(c.sport||'')&&/^(?:total )?sets? (?:over\s*\/\s*under)$/.test(label)){scope=false;metric='sets';}
 else if(/volley/i.test(c.sport||'')&&!scope)metric='points';
 if(evidence.provider==='api_sports'&&/basket/i.test(c.sport||'')&&!scope&&/incl.*(?:overtime|\bot\b)/.test(label))metric='points_including_overtime';
 if(periodType){scope=false;metric=periodType.includes('first_half')?'half_points':'quarter_points';}
 const m=String(c.specifier||'').match(/(?:^|[|;])total=(\d+(?:\.\d+)?)(?:$|[|;])/),l=m?Number(m[1]):Number(side.match(/(?:under|over)\s+(\d+(?:\.\d+)?)/)?.[1]);
 if(scope||!metric||!Number.isFinite(l)||Math.abs(l%1-.5)>1e-9||!(/\bunder\b|\bover\b/.test(side)))return tag('checked_no_comparable_metric',true,{capturedAt:evidence.capturedAt});
 if(evidence.provider==='api_sports'&&!Number.isFinite(evidence.metrics?.[metric])&&evidence.sportySupplement&&evidence.sportySupplement.provider!=='api_sports')return assess(c,evidence.sportySupplement,now);
 const sampleCount=evidence.metricSamples?.[metric]??evidence.sampleCount;
 const observations=(evidence.samples?.[metric]||[]).filter(v=>typeof v==='number'&&Number.isFinite(v)),hits=observations.filter(v=>/\bunder\b/.test(side)?v<l:v>l).length;
 const mean=evidence.metrics?.[metric],hasMean=Number.isFinite(mean)&&mean>=0&&sampleCount!==0;
 const alignment=hasMean?((/\bunder\b/.test(side)?mean<l:mean>l)?'aligned':mean===l?'inconclusive':'conflict'):'inconclusive';
 const meanDetails={...(observations.length?{observedHits:hits,observedMatches:observations.length,observedHitRate:100*hits/observations.length}:{}),capturedAt:evidence.capturedAt,sampleCount:sampleCount,metric,mean,line:l,alignment,meanGap:hasMean?Math.abs(mean-l):null,modelBasis:'historical_mean_direction_filter',accuracyStatus:'not_empirically_calibrated',sampleQuality:sampleCount>=5?'at_least_five':sampleCount>0?'small_sample':'sample_size_unreported'};
 // First-half and first-quarter basketball totals have an exact period match;
 // regulation/full-time overtime uncertainty must not disable this comparison.
 // This is a descriptive direction filter, not a probability estimate. Small or
 // unreported samples are disclosed and never used to inflate probability.
 if(periodType&&hasMean)return tag(alignment==='conflict'?'historical_mean_conflict':alignment==='aligned'?'checked_mean_alignment':'checked_mean_neutral',alignment!=='conflict',meanDetails);
 // Full-game basketball/hockey distributions and overtime scope remain unknown,
 // but an opposing average still excludes the offered direction.
 if(/hockey|basket|volley/i.test(c.sport||''))return tag(alignment==='conflict'?'historical_mean_conflict':'checked_scope_or_distribution_unconfirmed',alignment!=='conflict',meanDetails);
 if(!hasMean||!(sampleCount>=5))return tag(alignment==='conflict'?'historical_mean_conflict':'checked_insufficient_metric_history',alignment!=='conflict',meanDetails);
 const under=poissonUnder(mean,l);if(under==null)return tag('checked_no_comparable_metric');const p=/\bunder\b/.test(side)?under:100-under;
 // Conservative cap: descriptive history can lower, but never inflate, the original estimate.
 result.probability=Math.min(Number(c.probability),Math.round(p*10)/10);result.fullWinProbability=result.probability;result.nonLossProbability=result.probability;result.lossProbability=100-result.probability;result.modelBasis=evidence.provider==='api_sports'?'h2h_recorded_average_poisson_cap':'h2h_season_average_poisson_cap';result.independentModel=false;result.expectedReturnMultiplier=result.probability/100*Number(c.odds);result.probabilitySource=(c.probabilitySource||'Model')+(evidence.provider==='api_sports'?' · API-Sports H2H recorded-average cap':' · H2H season-average Poisson cap');
 const odds=Number(c.odds);result.edge=result.probability-100/odds;result.fairOdds=100/result.probability;result.expectedValuePct=(result.probability/100*odds-1)*100;result.qualityScore=Math.min(Number(c.qualityScore)||result.probability,result.probability);
 return tag('history_cap_applied',alignment!=='conflict',{...meanDetails,historyEstimate:p,modelBasis:evidence.provider==='api_sports'?'recorded_h2h_poisson_assumption':'season_average_poisson_assumption'});
}
module.exports={parsePanel,combine,assess,poissonUnder};
