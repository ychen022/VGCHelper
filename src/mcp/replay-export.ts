import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod/v4';
import type {AppContext} from '../app/context.js';
import type {EpisodeTrace} from '../simulation/runner.js';
import {VgcError} from '../errors.js';
import {exportReplayHtml,MAX_EXPORT_LOG_BYTES,type BattleLogInput} from '../replay/export.js';
import {executeTool} from './results.js';

export function registerReplayExportTool(server:McpServer,context:AppContext):void {
  const lines=z.array(z.string().max(MAX_EXPORT_LOG_BYTES)).max(100000);
  server.registerTool('vgc_replay_export_html',{
    title:'Export a Showdown replay HTML file',
    description:'Convert battle_log (a battleLog object, array of protocol lines, or protocol text) OR a retained simulation job_id/trace_index into a local Showdown replay HTML file. Saved traces use only the requested player perspective. Partial logs are labeled; unavailable legacy logs require a rerun. No upload is performed. Playback needs internet for official Showdown scripts/sprites; raw text remains readable offline. Returns the absolute file path; defaults to the data directory under replays. Existing files are never overwritten.',
    inputSchema:{
      battle_log:z.union([z.string().min(1).max(MAX_EXPORT_LOG_BYTES),lines,z.object({lines,status:z.enum(['complete','partial','unavailable']).optional(),ended:z.boolean().optional(),turn:z.number().int().min(0).optional(),reason:z.string().optional()})]).optional(),
      job_id:z.string().min(1).optional(),trace_index:z.number().int().min(0).max(4).default(0),perspective:z.enum(['p1','p2']).default('p1'),
      output_path:z.string().min(1).max(4096).optional(),title:z.string().min(1).max(500).optional(),
    },
    outputSchema:{result:z.unknown()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async input=>executeTool(async()=>{
    if((input.battle_log!==undefined)===(input.job_id!==undefined))throw new VgcError('INVALID_INPUT','Supply exactly one of battle_log or job_id.');
    let battleLog:BattleLogInput;
    if(input.job_id!==undefined){
      const trace=context.simulations.trace(input.job_id,input.trace_index,1).items[0] as EpisodeTrace|undefined;
      if(!trace)throw new VgcError('NOT_FOUND','No retained episode at this trace_index.');
      const log=trace.battleLogs?.[input.perspective];
      if(!log)throw new VgcError('INVALID_REPLAY','No battle log was saved for this episode. Rerun the simulation with the updated server.');
      battleLog=log;
    }else{
      battleLog=input.battle_log as BattleLogInput;
    }
    return exportReplayHtml({battleLog,...(input.output_path!==undefined?{outputPath:input.output_path}:{}),...(input.title!==undefined?{title:input.title}:{})});
  }));
}
