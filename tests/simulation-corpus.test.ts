import {describe,expect,it} from 'vitest';
import {prepareReplayCorpus,evaluateFrozenCorpus,normalizeCorpusRecord,behaviorSummary} from '../src/simulation/corpus.js';
const row=(id:string,time:number,extra='')=>({id,formatid:'gen9championsvgc2026regmb',format:'[Gen 9] CHAMPIONS VGC 2026',uploadtime:time,log:`|tier|[Gen 9 Champions] VGC 2026 Reg M-B\n|poke|p1|Incineroar, L50|\n|poke|p2|Dragonite, L50|\n|switch|p1a: Cat|Incineroar, L50|100/100\n|switch|p2a: Dragon|Dragonite, L50|100/100\n${extra}\n|turn|1\n|move|p1a: Cat|Fake Out|p2a: Dragon\n|move|p2a: Dragon|Protect|p2a: Dragon\n|win|${id}`,source:{provider:'test',revision:'pinned'}});
describe('strict frozen replay corpus',()=>{
  it('normalizes UNIX upload seconds and rejects mixed or missing tiers',()=>{
    expect(normalizeCorpusRecord(row('one',1782935051)).uploadTime).toBe('2026-07-01T19:44:11.000Z');
    expect(()=>normalizeCorpusRecord({...row('bad',1782935051),log:'|tier|[Gen 9 Champions] VGC 2026 Reg M-A'})).toThrow(/format|tier/);
    expect(()=>normalizeCorpusRecord({...row('missing',1782935051),log:'|turn|1'})).toThrow(/tier/);
  });
  it('deduplicates by both ID and log and purges a series that crosses a time boundary',()=>{
    const rows=Array.from({length:10},(_,i)=>row(`r${i}`,1782935051+i));
    rows[1]=row('r1',1782935052,'|uhtml|bestof|<a href="/game-bestof3-gen9championsvgc2026regmb-series">Game 1</a>');
    rows[8]=row('r8',1782935059,'|uhtml|bestof|<a href="/game-bestof3-gen9championsvgc2026regmb-series">Game 2</a>');
    const prepared=prepareReplayCorpus([...rows,{...rows[0]!,log:rows[0]!.log+'\n|message|same id different payload'},{...rows[2]!,id:'log-duplicate'}]);
    expect(prepared.audit.duplicates).toBe(2);
    expect(prepared.audit.boundaryPurged).toBe(2);
    expect(prepared.frozen.splits.train).not.toContain('r1');
    expect(prepared.frozen.splits.test).not.toContain('r8');
    expect(prepareReplayCorpus([...rows].reverse()).frozen.splitHash).toBe(prepareReplayCorpus(rows).frozen.splitHash);
    expect(prepared.frozen.smoothingGrid).toEqual([0.05,0.5,2]);
  });
  it('purges exact open-sheet teams shared across otherwise unrelated split groups',()=>{
    const sheet=['Incineroar','Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler'].map(species=>`${species}|||ability|protect|Hardy|||||50|`).join(']');
    const rows=Array.from({length:10},(_,i)=>row(`r${i}`,1782935051+i,(i===0||i===9)?`|showteam|p1|${sheet}`:''));
    const prepared=prepareReplayCorpus(rows);
    expect(prepared.audit.boundaryPurged).toBe(2);
    expect(prepared.audit.sharedSheetFingerprints).toBe(1);
  });
  it('reports real behavioral denominators and keeps heldout targets out of the vocabulary',()=>{
    const rows=Array.from({length:20},(_,i)=>row(`r${i}`,1782935051+i));
    const prepared=prepareReplayCorpus(rows);
    const result=evaluateFrozenCorpus(prepared);
    expect(result.distributions.games).toBe(20);
    expect(result.distributions.executedMoves).toBe(40);
    expect(result.distributions.protectMoves).toBe(20);
    expect(result.evaluation.test.empirical.vocabularySize).toBe(3);
    expect(result.tacticalBaseline.status).toBe('unavailable');
    expect(result.artifact.adopted).toBe(false);
    expect(result.frozen.splitHash).toBe(prepared.frozen.splitHash);
  });
});

it('separates opening and post-action replacement/pivot switches from voluntary-switch counts',()=>{
  const log=row('trace',1782935051).log.replace('|turn|1','|turn|1\n|switch|p1a: New|Garchomp, L50|100/100').replace('|win|trace','|switch|p2a: Bench|Kingambit, L50|100/100\n|win|trace');
  const d=behaviorSummary([log]);
  expect(d.voluntarySwitches).toBe(1);
  expect(d.otherPostOpeningSwitches).toBe(1);
});


it('counts a Showdown tie terminator without a trailing pipe as completed',()=>{
  expect(behaviorSummary(['|turn|2\n|tie']).completed).toBe(1);
});
it('counts both full sheets even when opponents disclose identical mirror teams',()=>{
  const sheet=['Incineroar','Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler'].map(species=>`${species}|||ability|protect|Hardy|||||50|`).join(']');
  expect(behaviorSummary([`|showteam|p1|${sheet}\n|showteam|p2|${sheet}`]).openTeamSheets.bothFullSheets).toBe(1);
});
