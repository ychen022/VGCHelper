export const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export type StatId = (typeof STAT_IDS)[number];
export type Stats = Partial<Record<StatId, number>>;

export type Knowledge = 'known' | 'inferred' | 'unknown';

export interface FieldProvenance {
  knowledge: Knowledge;
  confidence: number;
  source: string;
  observedAtTurn?: number;
}

export interface SourceReference {
  provider: string;
  retrievedAt: string;
  sourceVersion?: string;
  url?: string;
  contentHash?: string;
  sourceDate?: string;
  season?: string;
  format?: string;
  regulationId?: string;
  regulationVerified?: boolean;
}

export interface PokemonSet {
  species: string;
  nickname?: string;
  item?: string;
  ability?: string;
  nature?: string;
  moves: string[];
  skillPoints: Stats;
  ivs: Stats;
  level: number;
  gender?: string;
  shiny?: boolean;
  provenance?: Partial<
    Record<
      'species' | 'item' | 'ability' | 'nature' | 'moves' | 'skillPoints',
      FieldProvenance
    >
  >;
}

export interface PokemonTeam {
  format?: string;
  name?: string;
  pokemon: PokemonSet[];
  sourceText?: string;
}

export interface ReplayMetadata {
  id?: string;
  format?: string;
  formatId?: string;
  players: string[];
  uploadedAt?: string;
  winner?: string;
  gameType?: string;
}

export interface ReplayDocument {
  sourceType: 'json' | 'log' | 'html' | 'raw';
  raw: string;
  log: string;
  metadata: ReplayMetadata;
  contentHash: string;
}

export interface PokemonIdentity {
  slot: string;
  side: 'p1' | 'p2';
  nickname: string;
  species?: string;
}

export interface PokemonBattleState extends PokemonIdentity {
  active: boolean;
  hpPercent?: number;
  hp?: {current: number; maximum: number; exact: boolean; percentRange: [number, number]};
  megaEvolved?: boolean;
  volatileConditions?: string[];
  singleTurnConditions?: string[];
  fainted: boolean;
  status?: string;
  boosts: Partial<Record<Exclude<StatId, 'hp'> | 'accuracy' | 'evasion', number>>;
  item?: string;
  revealedItem?: string;
  itemConsumed?: boolean;
  itemRemoved?: boolean;
  ability?: string;
  moves: string[];
}

export interface SideBattleState {
  player?: string;
  pokemon: Record<string, PokemonBattleState>;
  activeSlots: string[];
  preview?: string[];
  conditions?: string[];
  teamSheet?: PokemonSet[];
  tailwindTurns?: number;
  reflectTurns?: number;
  lightScreenTurns?: number;
  auroraVeilTurns?: number;
}

export interface FieldState {
  weather?: string;
  terrain?: string;
  trickRoomTurns?: number;
  gravityTurns?: number;
}

export interface NormalizedEvent {
  index: number;
  turn: number;
  type: string;
  args: string[];
  tags: Record<string, string | true>;
  raw: string;
}

export interface TurnState {
  turn: number;
  beforeEvents: BattleState;
  events: NormalizedEvent[];
  afterEvents: BattleState;
}

export interface BattleState {
  turn: number;
  sides: {
    p1: SideBattleState;
    p2: SideBattleState;
  };
  field: FieldState;
  warnings?: string[];
}

export interface PokemonPosition {
  species?: string;
  hpPercent?: number;
  boosts?: Stats;
  status?: string;
  item?: string;
  ability?: string;
  alliesFainted?: number;
}

export interface ParsedReplay {
  document: ReplayDocument;
  events: NormalizedEvent[];
  turns: TurnState[];
  initialState: BattleState;
  finalState: BattleState;
}

export interface DamageRequest {
  attacker: PokemonSet;
  defender: PokemonSet;
  move: string;
  attackerPosition?: PokemonPosition;
  defenderPosition?: PokemonPosition;
  field?: {
    weather?: string;
    terrain?: string;
    isHelpingHand?: boolean;
    isReflect?: boolean;
    isLightScreen?: boolean;
    isFriendGuard?: boolean;
    isCritical?: boolean;
    isProtected?: boolean;
    isAuroraVeil?: boolean;
    isGravity?: boolean;
    attackerTailwind?: boolean;
    defenderTailwind?: boolean;
    singleTarget?: boolean;
  };
}

export interface DamageResult {
  move: string;
  damage: number[];
  damageDistribution?: Array<{damage: number; probability: number}>;
  range: [number, number];
  percentRange: [number, number];
  description: string;
  assumptions: string[];
  calculatorVersion: string;
  inputs?: DamageRequest;
}

export interface MetaTeam {
  id: string;
  regulationId: string;
  name: string;
  pokemon: PokemonSet[];
  roster: string[];
  event?: string;
  placement?: string;
  date?: string;
  category?: string;
  sourceUrl?: string;
  exactSets: boolean;
  source: SourceReference;
}

export interface MetaUsageRow {
  pokemon: string;
  category:
    | 'move'
    | 'item'
    | 'teammate'
    | 'nature'
    | 'spread'
    | 'ability'
    | string;
  name: string;
  rank: number;
  percentage: number;
  source: SourceReference;
}

export interface OpponentSetHypothesis {
  id: string;
  set: PokemonSet;
  confidence: number;
  compatible: boolean;
  reasons: string[];
  source: SourceReference;
}

export interface ReplayFinding {
  id: string;
  turn: number;
  kind: 'strength' | 'improvement' | 'uncertainty';
  title: string;
  evidence: string[];
  alternatives: Array<{
    action: string;
    rationale: string;
    damage?: DamageResult;
  }>;
  confidence: number;
  priority?: number;
  category?: string;
  decisionAssessment?: 'review' | 'observed-success' | 'uncertain';
  knownBefore?: string[];
  eventIndices?: number[];
}

export interface ReplayAnalysis {
  id: string;
  replayId: string;
  regulationId: string;
  createdAt: string;
  teamVersion?: string;
  userTeam?: PokemonTeam;
  regulationVersion?: string;
  calculatorVersion?: string;
  playerSide: 'p1' | 'p2';
  result?: 'win' | 'loss' | 'tie' | 'unknown';
  findings: ReplayFinding[];
  summary: {
    strengths: string[];
    improvements: string[];
    practiceFocus: string[];
  };
  assumptions: string[];
  sources: SourceReference[];
}

export interface LeadPair {
  first: string;
  second: string;
}

export interface LeadMatchup {
  userLead: LeadPair;
  opponentLead: LeadPair;
  opponentTeamId: string;
  score: number;
  features: Record<string, number>;
  notes: string[];
  damage: DamageResult[];
  userMega?: string | null;
  opponentMega?: string | null;
}

export interface EvaluationContext {
  priorityThreats?: string[] | undefined;
  roles?: Array<{pokemon: string; move?: string | undefined; purpose: string; target?: string | undefined}> | undefined;
  modes?: Array<{id: string; bringFour: string[]; lead?: [string,string] | undefined; mega: string|null; targets?: string[] | undefined}> | undefined;
}

export interface TeamEvaluation {
  id: string;
  regulationId: string;
  createdAt: string;
  metaTeamCount: number;
  matchupCount: number;
  bestLeads: Array<{lead: LeadPair; score: number; notes: string[]}>;
  worstLeads: Array<{lead: LeadPair; score: number; notes: string[]}>;
  threats: string[];
  strengths: string[];
  recommendations: string[];
  sources: SourceReference[];
}
