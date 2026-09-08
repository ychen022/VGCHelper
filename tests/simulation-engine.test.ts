import {describe, expect, it} from 'vitest';
import {EngineSession, ENGINE_PROFILE, completePreviewTeam, moveMetadata} from '../src/simulation/engine.js';
import {pokemonSpeed, pokemonMaxHp} from '../src/calc/champions.js';
import type {PokemonTeam} from '../src/domain/contracts.js';
const preview = ['Dragonite', 'Garchomp', 'Whimsicott', 'Kingambit', 'Sneasler', 'Basculegion'];
const seed: [number, number, number, number] = [1, 2, 3, 4];
function team(): PokemonTeam { return completePreviewTeam(preview); }
describe('Champions simulation engine', () => {
  it('validates six and enumerates ordered choose-four commands', () => {
    const battle = EngineSession.create({teams:{p1:team(),p2:team()},seed});
    expect(ENGINE_PROFILE.mod).toBe('champions');
    expect(battle.view('p1').legalCommands).toHaveLength(360);
    expect(battle.view('p1').legalCommands).toContain('team 1234');
    expect(() => EngineSession.create({teams:{p1:{pokemon:[]},p2:team()},seed})).toThrow();
  });
  it('conceals opposing moves, items, investment and preserves snapshots', () => {
    const a = team(); const b = team();
    b.pokemon[0]!.item='Life Orb'; b.pokemon[0]!.moves = ['Protect', 'Dragon Claw']; b.pokemon[0]!.skillPoints = {hp:32};
    const first = EngineSession.create({teams:{p1:a,p2:team()},seed});
    const second = EngineSession.create({teams:{p1:a,p2:b},seed});
    expect(first.view('p1')).toEqual(second.view('p1'));
    first.step({p1:'team 1234',p2:'team 1234'});
    second.step({p1:'team 1234',p2:'team 1234'});
    expect(first.view('p1')).toEqual(second.view('p1'));
    const clone = EngineSession.restore(first.snapshot());
    for (let i=0;i<8 && !first.view('p1').ended;i++) {
      const commands = {p1:first.view('p1').legalCommands[0],p2:first.view('p2').legalCommands[0]};
      first.step(commands); clone.step(commands);
      expect(first.view('p1')).toEqual(clone.view('p1'));
    }
  });
  it('every advertised initial joint choice is accepted by the pinned engine', () => {
    const a=team(); a.pokemon[0]!.item='Dragoninite';
    const battle=EngineSession.create({teams:{p1:a,p2:team()},seed});
    battle.step({p1:'team 1234',p2:'team 1234'});
    const checkpoint=battle.snapshot();
    for(const command of battle.view('p1').legalCommands) {
      const branch=EngineSession.restore(checkpoint);
      expect(()=>branch.step({p1:command,p2:branch.view('p2').legalCommands[0]}),command).not.toThrow();
    }
  });
  it('applies validator normalization before battle creation for supplied Mega formes', () => {
    const a=team(); a.pokemon[0]!.species='Dragonite-Mega'; a.pokemon[0]!.item='Dragoninite';
    const battle=EngineSession.create({teams:{p1:a,p2:team()},seed});
    expect(battle.view('p1').request.side.pokemon[0]!.details).not.toContain('Mega');
    battle.step({p1:'team 1234',p2:'team 1234'});
    expect(battle.view('p1').legalCommands.some(c=>c.includes('mega'))).toBe(true);
  });
  it('Champions SP directly match calculator Speed and HP for the six baseline species', () => {
    const a=team(); const battle=EngineSession.create({teams:{p1:a,p2:team()},seed});
    for(const [i,p] of battle.view('p1').request.side.pokemon.entries()) {
      expect(p.stats.spe).toBe(pokemonSpeed(a.pokemon[i]!));
      expect(Number(p.condition.split('/')[1])).toBe(pokemonMaxHp(a.pokemon[i]!));
    }
  });
  it('exposes only immutable public move mechanics to a policy', () => {
    const protect=moveMetadata('Protect');
    expect(protect.priority).toBe(4); expect(protect.target).toBe('self');
    expect(Object.isFrozen(protect)).toBe(true);
  });
  it('canonicalizes Aegislash Shield and Eternal Flower aliases without merging distinct Floette forms', () => {
    const a=completePreviewTeam(['Aegislash-Shield','Floette-Eternal-Flower',...preview.slice(2)]);
    const battle=EngineSession.create({teams:{p1:a,p2:team()},seed});
    expect(battle.view('p1').request.side.pokemon[0]!.details).toMatch(/^Aegislash,/);
    expect(battle.view('p1').request.side.pokemon[1]!.details).toMatch(/^Floette-Eternal,/);
    expect(()=>completePreviewTeam(['Floette',...preview.slice(1)])).toThrow();
  });
  it('reseed changes future randomness without changing either current player view', () => {
    const battle=EngineSession.create({teams:{p1:team(),p2:team()},seed});
    battle.step({p1:'team 1234',p2:'team 1234'});
    const before=battle.view('p1'); const original=battle.snapshot();
    battle.reseed([51,62,73,84]);
    expect(battle.view('p1')).toEqual(before);
    expect(battle.snapshot().state).not.toEqual(original.state);
    expect(EngineSession.restore(battle.snapshot()).view('p1')).toEqual(before);
  });
  it('uses pinned sheet fields and omits opposing investment', () => {
    const battle = EngineSession.create({teams:{p1:team(),p2:team()},seed,informationMode:'open_sheet'});
    expect(battle.view('p1').observations.some(line=>line.startsWith('|showteam|p2|'))).toBe(true);
    expect(JSON.stringify(battle.view('p1').request)).not.toContain('p2:');
  });
  it('Protect blocks damage and Mega is an optional legal decision', () => {
    const a = team(); a.pokemon[0]!.item='Dragoninite'; a.pokemon[0]!.moves=['Dragon Claw','Protect'];
    a.pokemon[1]!.moves=['Dragon Claw']; const b=team(); b.pokemon[0]!.moves=['Dragon Claw']; b.pokemon[1]!.moves=['Dragon Claw'];
    const battle = EngineSession.create({teams:{p1:a,p2:b},seed});
    battle.step({p1:'team 1234',p2:'team 1234'});
    expect(battle.view('p1').legalCommands.some(c=>c.includes('mega'))).toBe(true);
    const hpBefore=battle.view('p1').request.side.pokemon[0]!.condition;
    battle.step({p1:'move 2 mega, move 1 1',p2:'move 1 1, move 1 1'});
    const log = battle.view('p1').observations.join('\n');
    expect(battle.view('p1').request.side.pokemon[0]!.condition).toBe(hpBefore);
    expect(log).toContain('|-mega|p1a:');
    expect(log).toContain('|-activate|p1a: Dragonite|move: Protect');
  });
  it('completes a reproducible seeded game with legal attack and replacement decisions', () => {
    const run = () => {
      const battle=EngineSession.create({teams:{p1:team(),p2:team()},seed});
      for(let i=0;i<150 && !battle.view('p1').ended;i++) battle.step({p1:battle.view('p1').legalCommands[0],p2:battle.view('p2').legalCommands[0]});
      return battle.view('p1');
    };
    const result=run(); expect(result.ended).toBe(true); expect(result.request.wait).toBe(true); expect(run()).toEqual(result);
  });
});









