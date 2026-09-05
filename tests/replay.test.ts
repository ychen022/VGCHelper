import {describe, expect, it} from 'vitest';

import {ingestReplay, loadReplay, parseReplay} from '../src/replay/index.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';

const LOG = `|player|p1|Alice|
|player|p2|Bob|
|teamsize|p1|6
|teamsize|p2|6
|gametype|doubles
|gen|9
|tier|[Gen 9 Champions] VGC 2026 Reg M-B
|poke|p1|Garchomp|
|poke|p2|Kingambit|
|start
|switch|p1a: Chomp|Garchomp|100/100
|switch|p1b: Cotton|Whimsicott|100/100
|switch|p2a: Gambit|Kingambit|100/100
|switch|p2b: Sneasler|Sneasler|100/100
|turn|1
|move|p1b: Cotton|Tailwind|p1b: Cotton
|-sidestart|p1: Alice|move: Tailwind
|move|p2b: Sneasler|Dire Claw|p1a: Chomp
|-damage|p1a: Chomp|60/100
|-status|p1a: Chomp|par
|move|p1a: Chomp|Earthquake|p2a: Gambit|[spread] p2a,p2b
|-damage|p2a: Gambit|10/100
|-damage|p2b: Sneasler|0 fnt
|faint|p2b: Sneasler
|upkeep
|turn|2
|move|p2a: Gambit|Sucker Punch|p1a: Chomp
|-enditem|p1a: Chomp|Focus Sash
|-damage|p1a: Chomp|1/100 par
|win|Alice`;

describe('replay ingestion and reduction', () => {
  const profile = loadRegulationProfile();

  it('extracts the same log from JSON and downloaded HTML', () => {
    const json = loadReplay({
      content: JSON.stringify({
        id: 'gen9championsvgc2026regmb-1',
        format: '[Gen 9 Champions] VGC 2026 Reg M-B',
        formatid: 'gen9championsvgc2026regmb',
        players: ['Alice', 'Bob'],
        log: LOG,
      }),
    });
    const html = loadReplay({
      content: `<script type="text/plain" class="battle-log-data">${LOG.replaceAll('/', '\\/')}</script>
<script type="application/json" class="data">{"id":"gen9championsvgc2026regmb-1","formatid":"gen9championsvgc2026regmb","players":["Alice","Bob"]}</script>`,
    });
    expect(html.log).toBe(json.log);
    expect(html.metadata.players).toEqual(['Alice', 'Bob']);
    expect(html.contentHash).toBe(json.contentHash);
  });

  it('reduces doubles events into turn snapshots', () => {
    const parsed = ingestReplay({content: LOG}, profile);
    expect(parsed.turns).toHaveLength(2);
    const turnOne = parsed.turns[0];
    expect(turnOne?.beforeEvents.sides.p1.activeSlots).toEqual(['p1a', 'p1b']);
    expect(turnOne?.afterEvents.sides.p1.tailwindTurns).toBe(4);

    const chomp = turnOne?.afterEvents.sides.p1.pokemon['p1:chomp'];
    const sneasler = turnOne?.afterEvents.sides.p2.pokemon['p2:sneasler'];
    expect(chomp).toMatchObject({hpPercent: 60, status: 'par'});
    expect(sneasler).toMatchObject({hpPercent: 0, fainted: true, active: false});
    expect(parsed.document.metadata.winner).toBe('Alice');
  });

  it('retains revealed item and move information', () => {
    const document = loadReplay({content: LOG});
    const parsed = parseReplay(document);
    const chomp = parsed.finalState.sides.p1.pokemon['p1:chomp'];
    expect(chomp?.item).toBeUndefined();
    expect(chomp?.revealedItem).toBe('Focus Sash');
    expect(chomp?.itemConsumed).toBe(true);
    expect(chomp?.moves).toContain('Earthquake');
  });

  it('rejects JSON metadata that conflicts with the protocol tier', () => {
    expect(() =>
      loadReplay({
        content: JSON.stringify({
          formatid: 'gen9championsvgc2026regmb',
          log: LOG.replace(
            '[Gen 9 Champions] VGC 2026 Reg M-B',
            '[Gen 9] Doubles OU',
          ),
        }),
      }),
    ).toThrow(/metadata conflicts/);
  });

  it('ticks field counters and clears volatile switch state', () => {
    const parsed = parseReplay(
      loadReplay({
        content: `${LOG.replace('|turn|2', '|switch|p1a: Chomp|Garchomp|60/100 par\n|turn|2')}
|switch|p1a: Chomp|Garchomp|60/100 par
|turn|3`,
      }),
    );
    expect(parsed.turns[1]?.beforeEvents.sides.p1.tailwindTurns).toBe(3);
    expect(parsed.turns[2]?.beforeEvents.sides.p1.tailwindTurns).toBe(2);
    expect(
      parsed.turns[2]?.beforeEvents.sides.p1.pokemon['p1:chomp']?.boosts,
    ).toEqual({});
  });

  it('tracks Ally Switch slots and distinguishes removed items', () => {
    const parsed = parseReplay(
      loadReplay({
        content: `|player|p1|Alice|
|player|p2|Bob|
|gametype|doubles
|tier|[Gen 9 Champions] VGC 2026 Reg M-B
|switch|p1a: Chomp|Garchomp|100/100
|switch|p1b: Cotton|Whimsicott|100/100
|turn|1
|swap|p1a: Chomp|p1b: Cotton
|-enditem|p1a: Chomp|Life Orb|[from] move: Knock Off
|turn|2`,
      }),
    );
    const state = parsed.turns[1]?.beforeEvents.sides.p1;
    expect(state?.pokemon['p1:chomp']?.slot).toBe('p1b');
    expect(state?.pokemon['p1:cotton']?.slot).toBe('p1a');
    expect(state?.pokemon['p1:chomp']).toMatchObject({
      revealedItem: 'Life Orb',
      itemRemoved: true,
    });
    expect(state?.pokemon['p1:chomp']?.itemConsumed).toBeUndefined();
  });
});
