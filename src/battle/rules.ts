import {createRequire} from 'node:module';
import {BATTLE_PROFILE} from './engine.js';

const require=createRequire(import.meta.url);
const {Dex}=require('pokemon-showdown');

/** Local launch policy and mechanics from the same pinned engine used by the referee. */
export function humanBattleRules(regulation='latest',now=Date.now()) {
  const requested=regulation.trim().toLowerCase();
  const current=now>=Date.parse(BATTLE_PROFILE.validFrom)&&now<Date.parse(BATTLE_PROFILE.validTo);
  const supported=['latest','m-c',BATTLE_PROFILE.id,BATTLE_PROFILE.format].includes(requested);
  const available=supported&&(requested!=='latest'||current);
  const format=Dex.formats.get(BATTLE_PROFILE.format),table=Dex.formats.getRuleTable(format);
  return {
    source:'bundled-pinned-showdown',networkRequired:false,checkedAt:new Date(now).toISOString(),
    selection:{requested:regulation,available,formatId:available?BATTLE_PROFILE.format:null,
      reason:!supported?'Local human battles support Champions M-C only.':!available?'The latest regulation is not verified for this date. Specify M-C explicitly to play the supported format.':null},
    latestVerified:current?BATTLE_PROFILE.format:null,
    supportedFormats:[{...BATTLE_PROFILE,showdownName:format.name,gameType:format.gameType,
      aliases:['M-C',BATTLE_PROFILE.id,BATTLE_PROFILE.format],currentInVerifiedWindow:current,
      teamRules:{requiredTeamSize:table.minTeamSize,maxTeamSize:table.maxTeamSize,pickedTeamSize:table.pickedTeamSize,
        activePerSide:2,requiredMovesPerPokemon:4,adjustLevel:table.adjustLevel,totalInvestmentLimit:table.evLimit,
        speciesClause:table.has('speciesclause'),itemClause:table.has('itemclause'),
        validation:'The pinned Champions TeamValidator checks species, moves, abilities, items and investment legality during start. Use Champions investments in the EVs export field.'}}],
    defaults:{regulation:'latest',user_timer:true,agent_timer:false,reasoning_effort:'medium',model:'host-selected'},
    requiredInputs:['user_team: full six-Pokémon export or PokePaste link','agent_team: full six-Pokémon export or PokePaste link','team_sheet: explicitly open_sheet or closed'],
    teamSheets:{open_sheet:'Opponent species, moves, items, abilities and natures; no stats or investments.',closed:'Opponent species only initially; additional facts come from battle observations.'},
    timers:{...BATTLE_PROFILE.timer,
      policy:'Each enabled player gets a separate 90-second preview, 45-second selections and a 7-minute player bank. Selection expiry auto-chooses; bank expiry loses. Shared 20-minute time runs only while at least one timed player owes a choice. Preview consumes neither bank nor shared time. Untimed players have no deadline. Both players must be ready before clocks start.'},
    launchInstructions:'For a supported local battle, call vgc_battle_start directly with the assigned teams and explicit sheet mode; omit regulation to resolve latest locally. No web rules lookup or meta refresh is needed. This catalog is the authority for what this installed simulator supports, not a live feed of rule changes. If selection.available is false, report the reason; an online ruleset cannot enable an unsupported engine format. Launch the isolated player using the returned handoff.',
  };
}
