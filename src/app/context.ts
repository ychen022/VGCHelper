import type {MetaUsageRow} from '../domain/contracts.js';
import {
  ChampionsBattleDataProvider,
  MetaRefreshService,
  VgcPastesProvider,
} from '../meta/providers/index.js';
import {SqliteRepository} from '../storage/index.js';
import type {SourceSnapshot} from '../storage/index.js';
import {SimulationJobs} from '../simulation/jobs.js';
import {ReasoningMatches} from '../simulation/reasoning/matches.js';
import {HumanBattles} from '../battle/matches.js';
import {BattleHttpServer} from '../battle/http.js';

export interface AppContextOptions {
  databasePath?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class AppContext {
  readonly repository: SqliteRepository;
  readonly champions: ChampionsBattleDataProvider;
  readonly pastes: VgcPastesProvider;
  readonly refresh: MetaRefreshService;
  readonly simulations: SimulationJobs;
  readonly reasoning: ReasoningMatches;
  readonly humanBattles: HumanBattles;
  readonly battleHttp: BattleHttpServer;

  constructor(options: AppContextOptions = {}) {
    this.repository = new SqliteRepository(options.databasePath);
    this.repository.initialize();
    this.simulations = new SimulationJobs(this.repository.database);
    this.reasoning = new ReasoningMatches(this.repository.database);
    this.humanBattles = new HumanBattles(this.repository.database,options.now ? () => options.now!().getTime() : Date.now);
    this.battleHttp = new BattleHttpServer(this.humanBattles);
    this.champions = new ChampionsBattleDataProvider({
      ...(options.fetch ? {fetch: options.fetch} : {}),
      ...(options.now ? {now: options.now} : {}),
    });
    this.pastes = new VgcPastesProvider({
      ...(options.fetch ? {fetch: options.fetch} : {}),
      ...(options.now ? {now: options.now} : {}),
    });
    this.refresh = new MetaRefreshService(
      this.repository,
      this.champions,
      this.pastes,
      options.now ? {now: options.now} : {},
    );
  }

  activeUsage(regulationId: string): MetaUsageRow[] {
    return (
      this.repository.getLatestSourceSnapshot<MetaUsageRow[]>(
        'champions-battle-data',
        regulationId,
      )?.data ?? []
    );
  }

  activeSnapshots(regulationId: string): SourceSnapshot[] {
    return this.repository.listLatestSourceSnapshots(regulationId, true);
  }

  close(): void {
    this.battleHttp.close();
    this.reasoning.close();
    this.simulations.close();
    this.repository.close();
  }
}
