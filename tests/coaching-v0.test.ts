import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {analyzeReplay} from '../src/analysis/replay/analyzer.js';
import {aggregateReplayTrends} from '../src/analysis/replay/trends.js';
import {ingestReplay} from '../src/replay/index.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {parseShowdownTeam} from '../src/teams/parser.js';
import type {MetaTeam} from '../src/domain/contracts.js';
const profile = loadRegulationProfile();
const team = parseShowdownTeam(readFileSync('examples/sample-team.txt', 'utf8'), profile);
const meta: MetaTeam = {id: 'm', name: 'sample', regulationId: profile.id, roster: team.pokemon.map(p=>p.species), pokemon: team.pokemon, exactSets: true, source: {provider: 'test', retrievedAt: '2026-09-04T00:00:00Z'}};
const start = `|player|p1|Alice|\n|player|p2|Bob|\n|gametype|doubles\n|tier|[Gen 9 Champions] VGC 2026 Reg M-B\n|switch|p1a: Chomp|Garchomp|100/100\n|switch|p1b: Cotton|Whimsicott|100/100\n|switch|p2a: Gambit|Kingambit|100/100\n|switch|p2b: Sneasler|Sneasler|100/100\n`;
function report(log: string) {return analyzeReplay(ingestReplay({content: log}, profile), team, [meta], profile, 'Alice');}
describe('evidence-aware coaching', () => {
  it('does not praise failed Tailwind', () => {
    const result = report(start + '|turn|1\n|move|p1b: Cotton|Tailwind|p1b: Cotton\n|-fail|p1b: Cotton\n|win|Bob');
    expect(result.findings.filter(f=>f.kind==='strength')).toHaveLength(0);
    expect(result.findings.some(f=>f.category==='failed-action')).toBe(true);
  });
  it('rejects an explicitly wrong player name', () => {
    expect(()=>analyzeReplay(ingestReplay({content:start+'|turn|1'},profile),team,[meta],profile,'Wrong')).toThrow(/player/i);
  });
  it('uses only pre-turn information and field state in alternatives', () => {
    const log = start + '|-weather|RainDance\n|-unboost|p1a: Chomp|atk|1\n|turn|1\n|move|p2b: Sneasler|Close Combat|p1a: Chomp\n|-damage|p1a: Chomp|0 fnt\n|faint|p1a: Chomp\n|turn|2\n';
    const first = report(log);
    const later = report(log + '|-item|p2a: Gambit|Air Balloon\n|win|Bob');
    const finding = first.findings.find(f=>f.turn===1 && f.kind==='improvement')!;
    expect(finding.decisionAssessment).toBe('review');
    expect(finding.knownBefore?.join(' ')).not.toContain('Air Balloon');
    const alternatives = finding.alternatives.filter(a=>a.damage);
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives[0]?.damage?.inputs?.field?.weather).toBe('Rain');
    expect(alternatives[0]?.damage?.inputs?.attackerPosition?.boosts?.atk).toBe(-1);
    expect(later.findings.find(f=>f.turn===1 && f.kind==='improvement')?.alternatives).toEqual(finding.alternatives);
    expect(first.teamVersion).toBeTruthy();
  });
  it('counts a replay once and separates team versions in trends', () => {
    const result = report(start+'|turn|1\n|win|Alice');
    const trends = aggregateReplayTrends([result, {...result,id:'rerun'}, {...result,id:'other',replayId:'other-game',teamVersion:'other-team'}]);
    expect(trends.analysisCount).toBe(2);
    expect(trends.teamGroups).toHaveLength(2);
  });
});
