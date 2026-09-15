import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {ingestReplay} from '../src/replay/index.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
const replay = () => ingestReplay({content:readFileSync('examples/public-replays/gen9championsvgc2026regmb-2675724766.json','utf8')},loadRegulationProfile('champions-vgc-2026-m-b'));
it('reconstructs a manually inspected six-turn public M-B battle',()=>{
  const parsed=replay();
  expect(parsed.turns).toHaveLength(6);
  expect(parsed.document.metadata.winner).toBe('jpduarte18');
  expect(parsed.initialState.sides.p1.preview).toHaveLength(6);
  expect(parsed.turns[1]?.beforeEvents.sides.p1.pokemon['p1:charizard']).toMatchObject({species:'Charizard-Mega-Y',ability:'Drought',hpPercent:2});
  expect(parsed.finalState.sides.p2.activeSlots).toEqual([]);
});
it('does not restore a consumed Sitrus Berry from its subsequent heal message',()=>{
  expect(replay().turns[2]?.beforeEvents.sides.p2.pokemon['p2:basculegion']).toMatchObject({itemConsumed:true,revealedItem:'Sitrus Berry'});
  expect(replay().turns[2]?.beforeEvents.sides.p2.pokemon['p2:basculegion']?.item).toBeUndefined();
});
it('expires a successful Protect at the next decision',()=>{
  expect(replay().turns[1]?.beforeEvents.sides.p1.pokemon['p1:whimsicott']?.volatileConditions).not.toContain('Protect');
});
