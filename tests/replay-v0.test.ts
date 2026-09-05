import {describe, expect, it} from 'vitest';
import {ingestReplay, loadReplay, parseReplay} from '../src/replay/index.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';

const profile = loadRegulationProfile();
const prefix = `|player|p1|Alice|\n|player|p2|Bob|\n|gametype|doubles\n|tier|[Gen 9 Champions] VGC 2026 Reg M-B\n`;
const active = `|poke|p1|Charizard, L50|\n|switch|p1a: Zard|Charizard, L50|100/100\n|switch|p2a: Chomp|Garchomp, L50|100/100\n`;

describe('V0 replay fidelity', () => {
  it('accepts explicit M-B formats and rejects ambiguous legacy and M-A formats', () => {
    expect(() => ingestReplay({content: prefix + active + '|turn|1'}, profile)).not.toThrow();
    for (const format of ['[Gen 9] Champions VGC 2026', '[Gen 9 Champions] VGC 2026 Reg M-A']) {
      expect(() => ingestReplay({content: prefix.replace('[Gen 9 Champions] VGC 2026 Reg M-B', format) + active}, profile)).toThrow(/format/i);
    }
  });
  it('extracts downloaded HTML regardless of script attribute order', () => {
    expect(loadReplay({content: `<script class="battle-log-data" type="text/plain">${prefix + active}</script>`}).log).toBe((prefix + active).trim());
  });
  it('keeps Mega forme when the following mega notification names its base species', () => {
    const replay = parseReplay(loadReplay({content: prefix + active + `|turn|1\n|detailschange|p1a: Zard|Charizard-Mega-Y, L50\n|-mega|p1a: Zard|Charizard|Charizardite Y\n|turn|2`}));
    expect(replay.turns[1]?.beforeEvents.sides.p1.pokemon['p1:zard']?.species).toBe('Charizard-Mega-Y');
    expect(replay.initialState.sides.p1.activeSlots).toEqual(['p1a']);
  });
  it('attributes Rough Skin to its source rather than to the damaged attacker', () => {
    const replay = parseReplay(loadReplay({content: prefix + active + `|turn|1\n|-damage|p1a: Zard|88/100|[from] ability: Rough Skin|[of] p2a: Chomp`}));
    expect(replay.finalState.sides.p1.pokemon['p1:zard']?.ability).toBeUndefined();
    expect(replay.finalState.sides.p2.pokemon['p2:chomp']?.ability).toBe('Rough Skin');
  });
  it('retains rounded HP uncertainty and persistent screens until an explicit end event', () => {
    const replay = parseReplay(loadReplay({content: prefix + active + `|turn|1\n|-sidestart|p1: Alice|Reflect\n|-damage|p1a: Zard|60/100\n|turn|7`}));
    const state = replay.turns[1]!.beforeEvents;
    expect(state.sides.p1.pokemon['p1:zard']).toMatchObject({hp: {current: 60, maximum: 100, exact: false, percentRange: [59, 60]}});
    expect(state.sides.p1.conditions).toContain('Reflect');
  });
  it('rejects malformed turn counters instead of producing NaN states', () => {
    expect(() => parseReplay(loadReplay({content: prefix + active + '|turn|NaN'}))).toThrow(/turn/i);
  });
  it('reads packed open sheets while leaving skill points unknown', () => {
    const replay = parseReplay(loadReplay({content: prefix + '|showteam|p2|Garchomp||lifeorb|roughskin|earthquake,dragonclaw,protect,rockslide|Jolly|||||50|\n' + active + '|turn|1'}));
    expect(replay.turns[0]?.beforeEvents.sides.p2.teamSheet?.[0]).toMatchObject({species: 'Garchomp', item: 'Life Orb', nature: 'Jolly', moves: ['Earthquake', 'Dragon Claw', 'Protect', 'Rock Slide'], skillPoints: {}, provenance: {skillPoints: {knowledge: 'unknown'}}});
  });
  it('updates passive abilities on Mega evolution even without an ability activation message', () => {
    const replay = parseReplay(loadReplay({content:prefix+'|showteam|p1|Kangaskhan||kangaskhanite|scrappy|doubleedge,protect,fakeout,crunch|Adamant|||||50|\n|switch|p1a: Kang|Kangaskhan|100/100\n|turn|1\n|detailschange|p1a: Kang|Kangaskhan-Mega, L50\n|-mega|p1a: Kang|Kangaskhan|Kangaskhanite\n|turn|2'}));
    expect(replay.turns[1]?.beforeEvents.sides.p1.pokemon['p1:kang']?.ability).toBe('Parental Bond');
  });
});
