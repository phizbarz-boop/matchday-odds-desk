'use strict';

// Shape and field values observed on SportyBet's liveOrPrematchEvents feed
// on 2026-10-06. Teams/IDs are test fixtures; clocks, phases and status fields
// deliberately retain the live website's format.
const outcome=(id,desc,odds,isActive=1)=>({id,desc,odds:String(odds),isActive});
const market=(id,desc,outcomes,extra={})=>({id,desc,status:0,outcomes,...extra});
const result=()=>market('1','1X2',[outcome('1','Home',1.05),outcome('2','Draw',8.90),outcome('3','Away',26)]);
const event=(eventId,extra={})=>({eventId,homeTeamName:'Home '+eventId,awayTeamName:'Away '+eventId,
  estimateStartTime:Date.now()-3600000,status:1,matchStatus:'H2',period:'2',setScore:'2:0',
  gameScore:['2:0','0:0'],pointScore:'["2:0","0:0"]',playedSeconds:'63:57',remainingTimeInPeriod:'26:02',
  markets:[result()],...extra});
const envelope=data=>({bizCode:10000,message:'0#0',data});
function boards(){
  const football=envelope([
    {id:'sr:tournament:test1',name:'Live League A',categoryName:'Country A',events:[
      event('sr:match:live-format-1',{markets:[result(),
        market('18','Over/Under',[outcome('12','Over 1.5',1.41),outcome('13','Under 1.5',2.62)],{specifier:'total=1.5',status:3}),
        market('10','Double Chance',[outcome('10','Home or Draw',1.10)],{status:1})]}),
      event('sr:match:live-format-future',{status:0,matchStatus:'Not start',setScore:'0:0',playedSeconds:'02:00'}),
    ]},
    {id:'sr:tournament:test2',name:'Live League B',categoryName:'Country B',events:[
      event('sr:match:live-format-late',{playedSeconds:'82:30',markets:[result(),
        market('166','Total Corners Over/Under',[outcome('12','Over 8.5',1.2),outcome('13','Under 8.5',5)],{specifier:'total=8.5'}),
        market('601','1X2 - 1UP',[outcome('1','Home',1.04),outcome('2','Draw',9),outcome('3','Away',27)]),
        market('128','1X2 & Over/Under',[outcome('1','Home and Over 2.5',2.5)])]}),
      event('sr:match:live-format-half',{matchStatus:'HT',playedSeconds:'45:00',setScore:'0:0',markets:[
        market('1','1X2',[outcome('1','Home',2.4),outcome('2','Draw',2.7),outcome('3','Away',3.1)])]}),
      event('sr:match:live-format-finished',{live:true,matchStatus:'FT',playedSeconds:'90:00'}),
    ]},
  ]);
  const basketball=envelope([{id:'sr:tournament:bb',name:'Basketball League',events:[
    event('sr:match:live-format-q4',{matchStatus:'Q4',period:'4',playedSeconds:'30:29',remainingTimeInPeriod:'09:31',setScore:'75:66',markets:[
      market('219','Winner (incl. overtime)',[outcome('4','Home',1.12),outcome('5','Away',6)]),
      market('999','1st quarter - Winner',[outcome('4','Home',1.05),outcome('5','Away',9)])]}),
    event('sr:match:live-format-inactive',{matchStatus:'Q4',setScore:'59:59',markets:[
      market('219','Winner (incl. overtime)',[outcome('4','Home',1.8,0),outcome('5','Away',1.9)])]}),
  ]}]);
  const hockey=envelope([{id:'sr:tournament:hc',name:'Hockey League',events:[
    event('sr:match:live-format-hockey',{matchStatus:'period 3',playedSeconds:'55:07',setScore:'3:1',markets:[
      market('406','Winner (incl. overtime and penalties)',[outcome('4','Home',1.15),outcome('5','Away',5.5)]),
      market('999','1st period - Winner',[outcome('4','Home',1.01),outcome('5','Away',15)])]}),
  ]}]);
  const tennis=envelope([{id:'sr:tournament:tn',name:'Tennis Open',events:[
    event('sr:match:live-format-tennis',{matchStatus:'set 3',period:'3',playedSeconds:undefined,setScore:'1:1',gameScore:['6:7','6:4','0:0'],markets:[
      market('186','Winner',[outcome('4','Home',1.3),outcome('5','Away',3.4)])]}),
    event('sr:match:live-format-tennis-future',{status:0,matchStatus:'Not start',playedSeconds:undefined,setScore:'0:0'}),
  ]}]);
  return {football,basketball,hockey,tennis,handball:envelope([]),volleyball:envelope([])};
}
module.exports={boards,market,outcome,event};
