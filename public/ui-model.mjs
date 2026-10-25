// 表示順だけを整える。監視条件・判定結果・配列の順番そのものは変更しない。
export function groupAvailability(conditions,today) {
  const entries=conditions.flatMap(condition=>condition.windows.filter(window=>window.date>today).map(window=>({condition,window})));
  entries.sort((a,b)=>a.window.date.localeCompare(b.window.date)||a.window.start-b.window.start||a.window.end-b.window.end||a.condition.facility.localeCompare(b.condition.facility,'ja')||a.condition.room.localeCompare(b.condition.room,'ja')||a.window.area_key.localeCompare(b.window.area_key,'ja'));
  const groups=[];
  for(const entry of entries){let group=groups.at(-1);if(!group||group.date!==entry.window.date){group={date:entry.window.date,entries:[]};groups.push(group);}group.entries.push(entry);}
  return groups;
}
export function durationLabel(minutes){const hours=Math.floor(minutes/60),rest=minutes%60;return `${hours?hours+'時間':''}${rest?rest+'分':''}`;}
