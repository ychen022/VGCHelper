import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod/v4';
import type {AppContext} from '../app/context.js';
import {executeTool} from './results.js';

const credential=z.string().min(1).max(256),outputSchema={result:z.unknown()};
const paste=z.string().min(1).max(32_000);
/** Resolve only PokePaste URLs; never arbitrary URLs/local paths supplied by a player. */
export async function resolveBattlePaste(input:string,fetcher:typeof fetch=fetch):Promise<string> {
  if(!/^https?:\/\//i.test(input.trim()))return input;
  const url=new URL(input.trim());
  if(url.protocol!=='https:' || url.hostname!=='pokepast.es' || url.port || url.username || url.password || !/^\/[a-f0-9]{16}(?:\/raw)?\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Provide a Showdown export or an https://pokepast.es/<paste-id> URL.');
  }
  url.pathname=url.pathname.replace(/\/(?:raw\/?)?$/,'')+'/raw';
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(!response.ok || !response.body)throw new Error(`Could not load team paste (${response.status}).`);
  let result='';const reader=response.body.getReader(),decoder=new TextDecoder();
  try {while(true){const {done,value}=await reader.read();if(done)break;result+=decoder.decode(value,{stream:true});if(Buffer.byteLength(result)>32_000)throw new Error('Team paste exceeds 32 KB.');}result+=decoder.decode();}
  finally {await reader.cancel();}
  return result;
}
export function registerBattleAgentTools(server:McpServer,context:AppContext,boundToken?:string):void {
  const auth=(supplied?:string)=>{if(boundToken && supplied && supplied!==boundToken)throw new Error('This connection is bound to a different battle agent.');const token=boundToken??supplied;if(!token)throw new Error('agent_token is required.');return token;};
  server.registerTool('vgc_battle_agent_view',{title:'Get your human-battle decision',
    description:'Connect as the isolated agent and read your own team/request, permitted opponent sheet, public observations, legal command menu, Champions move descriptions and actor-only priorBattles for memory rematches. No hidden opponent stats or pending choices. Wait in lobby/waiting; play until completed/cancelled. Respect agentTimer when enabled; otherwise thinking time is unlimited.',
    inputSchema:z.strictObject({agent_token:credential.optional()}),outputSchema,annotations:{readOnlyHint:true}},
    async input=>executeTool(()=>context.humanBattles.view(auth(input.agent_token),'agent')));
  server.registerTool('vgc_battle_agent_submit',{title:'Commit your human-battle choice',
    description:'Submit a command from your current legalCommands after choosing the strongest line using your knowledge and judgment. Supply the decisionId and a concise summary, optionally a forward plan. Choices lock until simultaneous resolution; exact retries are idempotent. Inspect accepted:false feedback and fetch the updated view before repairing a choice. An enabled agent selection timer auto-chooses at expiry.',
    inputSchema:z.strictObject({agent_token:credential.optional(),decision_id:z.string().max(200),command:z.string().min(1).max(256),summary:z.string().min(1).max(1000),plan:z.string().max(2000).default('')}),outputSchema,annotations:{destructiveHint:false,idempotentHint:true}},
    async input=>executeTool(()=>context.humanBattles.submit(auth(input.agent_token),'agent',input.decision_id,input.command,input.summary,input.plan)));
}
export function registerHumanBattleTools(server:McpServer,context:AppContext):void {
  registerBattleAgentTools(server,context);
  server.registerTool('vgc_battle_rules',{title:'Get bundled local battle rules and defaults',
    description:'Offline source of truth for launching local human-versus-agent battles. Returns supported regulations, date-aware latest resolution, pinned Showdown format/team rules, official clock values with local timer adaptations, sheet visibility, required inputs and defaults. Use this instead of searching the web for launch rules. No battle, credentials, browser or network request is created. Optional: vgc_battle_start already resolves and returns these rules, so ready-to-launch requests can start directly. Does not refresh analysis/meta data or discover unsupported future regulations.',
    inputSchema:z.strictObject({regulation:z.string().max(100).default('latest')}),outputSchema,
    annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
    async input=>executeTool(()=>context.humanBattles.rules(input.regulation)));
  server.registerTool('vgc_battle_start',{title:'Open a local user-versus-agent battle',
    description:'Start the browser battle requested in conversation directly; no web rules lookup or meta refresh is needed. The MCP resolves the latest verified local format, enforces the pinned rules and returns them with the handoff. Use vgc_battle_rules only if you need rules before starting. Requires two full team exports/PokePaste URLs, explicitly assigned to user and agent, and explicit open/closed sheet mode. Regulation defaults to latest (currently Champions M-C only); an expired latest alias or unsupported format is reported locally. Return the private browser URL to the user and open it if the host supports browsers. REQUIRED: launch a fresh isolated agent with only the agent handoff and player-only tools; never fork the coordinator history containing both teams. The MCP server is the referee, not a model runtime. No API key needed. Apply the initial ask to user_timer (default true), agent_timer (default false) and reasoning_effort (default medium). Timers begin after both players are ready. Explicitly apply the returned reasoning effort when launching the agent.',
    inputSchema:z.strictObject({user_team:paste,agent_team:paste,team_sheet:z.enum(['open_sheet','closed']),regulation:z.string().max(100).default('latest'),
      user_timer:z.boolean().default(true),agent_timer:z.boolean().default(false),
      reasoning_effort:z.enum(['low','medium','high','xhigh','max','ultra']).default('medium')}),outputSchema,annotations:{destructiveHint:false}},
    async input=>executeTool(async()=>{
      const rules=context.humanBattles.rules(input.regulation);
      if(!rules.selection.available)throw new Error(rules.selection.reason!);
      const [userPaste,agentPaste]=await Promise.all([resolveBattlePaste(input.user_team),resolveBattlePaste(input.agent_team)]);
      const start=context.humanBattles.start({userPaste,agentPaste,mode:input.team_sheet,regulation:input.regulation,userTimer:input.user_timer,agentTimer:input.agent_timer,reasoningEffort:input.reasoning_effort});
      const url=await context.battleHttp.open(start.userToken);
      return {matchId:start.matchId,url,adminToken:start.adminToken,profile:start.profile,rules:start.rules,settings:start.settings,agent:start.agent,
        instructions:'Open url for the user. Launch a fresh isolated player with only agent.prompt and a token-bound MCP connection sharing this database. Explicitly set the host reasoning effort to agent.reasoningEffort (default medium); leave model at the host default unless the user requested one. Use agent.codexSpawn for Codex subagents. Do not inherit either paste, browser URL, admin token, or coordinator history. Keep this MCP process alive. After a game ends, keep supervising this session using vgc_battle_get with after_state and wait_ms=30000. When rematch is present, call vgc_battle_rematch with its request ID and launch/rebind the player according to the returned contextPolicy. A fresh rematch MUST use a new isolated agent; never reuse its previous conversation. The browser stays in a lobby until the player connects and the user presses Begin.'};
    }));
  server.registerTool('vgc_battle_get',{title:'Get local battle progress and rematch requests',description:'Coordinator status only; no private sets/plans/actions. Continue supervision after completed while the user may request a rematch. Pass the returned stateId as after_state with wait_ms=30000 to wait for a change. A rematch field requires vgc_battle_rematch and a player handoff.',
    inputSchema:z.strictObject({admin_token:credential,after_state:z.string().max(300).optional(),wait_ms:z.number().int().min(0).max(30000).default(0)}),outputSchema,annotations:{readOnlyHint:true}},async input=>executeTool(async()=>{
      const until=Date.now()+input.wait_ms;
      let state=context.humanBattles.status(input.admin_token);
      while(input.after_state===state.stateId && Date.now()<until){await new Promise(resolve=>setTimeout(resolve,Math.min(250,until-Date.now())));state=context.humanBattles.status(input.admin_token);}
      return state;
    }));
  server.registerTool('vgc_battle_rematch',{title:'Fulfill a requested browser rematch',
    description:'Coordinator-only fulfillment of the rematch request in vgc_battle_get. Reuses teams/rules/timer settings, resets the game and clocks, and returns a rotated player capability. Explicitly apply agent.reasoningEffort to the host launch. For remember, resume the existing isolated player with the new credential or launch an isolated player using actor-only priorBattles. For fresh, terminate the old player and launch a new context with ONLY the returned handoff. Never fork prior battle/coordinator history for fresh. Retries of the same request ID return the same handoff without restarting the game. Keep supervising for further rematches.',
    inputSchema:z.strictObject({admin_token:credential,request_id:z.string().min(1).max(200)}),outputSchema,annotations:{destructiveHint:false,idempotentHint:true}},
    async input=>executeTool(()=>context.humanBattles.rematch(input.admin_token,input.request_id)));
  server.registerTool('vgc_battle_cancel',{title:'Cancel a local battle',description:'Cancel the saved battle without selecting further actions.',
    inputSchema:z.strictObject({admin_token:credential}),outputSchema,annotations:{destructiveHint:false,idempotentHint:true}},async input=>executeTool(()=>context.humanBattles.cancel(input.admin_token)));
  server.registerTool('vgc_battle_open',{title:'Reopen a saved local battle',description:'Restart the local browser transport for a saved battle using the human credential from its original private URL fragment. Saved choices and clocks remain authoritative; disconnected time while a human decision was pending still counts.',
    inputSchema:z.strictObject({user_token:credential}),outputSchema,annotations:{destructiveHint:false}},async input=>executeTool(async()=>({url:await context.battleHttp.open(input.user_token)})));
}
