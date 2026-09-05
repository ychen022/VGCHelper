import type {ReplayAnalysis} from '../../domain/contracts.js';

function ranked(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([title, count]) => ({title, count}))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
    .slice(0, limit);
}

export function aggregateReplayTrends(analyses: ReplayAnalysis[]) {
  analyses = [...new Map([...analyses].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(a=>[`${a.regulationId}|${a.teamVersion??'legacy'}|${a.playerSide}|${a.replayId}`,a])).values()];
  const groups = new Map<string, ReplayAnalysis[]>();
  for (const analysis of analyses) {
    const key = `${analysis.regulationId}|${analysis.teamVersion ?? 'legacy'}`;
    groups.set(key, [...(groups.get(key) ?? []), analysis]);
  }
  const strengths = analyses.flatMap((analysis) =>
    analysis.findings
      .filter((finding) => finding.kind === 'strength')
      .map((finding) => finding.category ?? finding.title),
  );
  const improvements = analyses.flatMap((analysis) =>
    analysis.findings
      .filter((finding) => finding.kind === 'improvement')
      .map((finding) => finding.category ?? finding.title),
  );
  const results = analyses.reduce(
    (counts, analysis) => {
      counts[analysis.result ?? 'unknown'] += 1;
      return counts;
    },
    {win: 0, loss: 0, tie: 0, unknown: 0},
  );

  return {
    analysisCount: analyses.length,
    teamGroups: [...groups.values()].map(group=>({regulationId:group[0]!.regulationId,teamVersion:group[0]!.teamVersion??'legacy',gameCount:group.length,
      recurringImprovements:ranked(group.flatMap(a=>a.findings.filter(f=>f.kind==='improvement').map(f=>f.category??f.title)),8)})),
    results,
    recurringStrengths: ranked(strengths, 8),
    recurringImprovements: ranked(improvements, 8),
    note:
      analyses.length < 5
        ? 'Fewer than five analyses are available; treat trends as preliminary.'
        : 'Counts describe recorded coaching findings, not calibrated causal effects.',
  };
}
