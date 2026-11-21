import { MODES, statistics } from './model.js';
import { winStatistics } from './battle.js';

export function sideOf(row, match) {
  if (row.mode === 35) {
    const figure=row.figure ?? match?.figure;
    return figure===1?'landlord':figure===3?'farmer':'unknown';
  }
  // FixedViewId is the game's one-based play order. Protocol SeatID and
  // screen-relative positions are not interchangeable with that order.
  const position=row.position ?? match?.position;
  if (row.mode===26) return [1,4].includes(position)?'first':[2,3].includes(position)?'second':'unknown';
  if (row.mode===44) return position===1?'first':position===2?'second':'unknown';
  return 'unknown';
}
export function sideName(mode, side) {
  return ({landlord:'地主',farmer:'农民',first:mode===26?'先手（1、4）':'先手',second:mode===26?'后手（2、3）':'后手'})[side]
    || (mode===35?'身份未知':'先后手未知');
}
// Backfill only from the same observed game, then reject unclassified rows.
// A legacy protocol SeatID is never evidence of play order.
export function knownSides(records, matches) {
  const framesById=new Map(records.map(r=>[r.id,r])),matchesById=new Map(matches.map(r=>[r.id,r]));
  const normalize=(row,peer)=>{
    if(peer?.mode!==row.mode)peer=null;
    if(sideOf(row)!=='unknown')return row;
    const filled={...row,figure:row.figure??peer?.figure,position:row.position??peer?.position};
    return sideOf(filled)==='unknown'?null:filled;
  };
  return {records:records.map(r=>normalize(r,matchesById.get(r.id))).filter(Boolean),
    matches:matches.map(r=>normalize(r,framesById.get(r.id))).filter(Boolean)};
}
export function groupedStatistics(frames, battles, names, { combineSides = false } = {}) {
  ({records:frames,matches:battles}=knownSides(frames,battles));
  const matches=new Map(battles.map(r=>[r.id,r])),groups=new Map();
  for(const [kind,rows] of [['frames',frames],['battles',battles]])for(const row of rows){
    const side=combineSides?'all':sideOf(row,matches.get(row.id)),key=`${row.mode}:${side}`;
    if(!groups.has(key))groups.set(key,{mode:row.mode,side,frames:[],battles:[]});
    groups.get(key)[kind].push(row);
  }
  return [...groups.values()].flatMap(group=>{
    const merged=new Map(statistics(group.frames,names).map(r=>[r.id,{...r,selectionRate:r.rate,rate:null,played:0,wins:0,losses:0,draws:0,unknown:0}]));
    for(const row of winStatistics(group.battles,names))merged.set(row.id,{appear:0,selected:0,known:0,selectionRate:null,...merged.get(row.id),...row});
    return [...merged.values()].map(row=>({...row,mode:group.mode,side:group.side,frameCount:group.frames.length,
      groupLabel:`${MODES[group.mode]} · ${group.side==='all'?'合计':sideName(group.mode,group.side)}`}));
  });
}
