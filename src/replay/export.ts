import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VgcError,errorMessage} from '../errors.js';
import {dataDirectory} from '../util/fs.js';
import {loadReplay} from './input.js';

export const MAX_EXPORT_LOG_BYTES=4*1024*1024;
export type BattleLogInput=string|string[]|{lines:string[];status?:'complete'|'partial'|'unavailable';ended?:boolean;turn?:number;reason?:string};

function escapeHtml(text:string):string {
  return text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

/** Downloaded-replay format documented by Showdown's battle-log.ts and replay-embed.ts. */
export function createReplayHtml(input:BattleLogInput,options:{title?:string}={}) {
  const supplied=typeof input==='string'||Array.isArray(input)?undefined:input;
  if(supplied?.status==='unavailable')throw new VgcError('INVALID_REPLAY','Battle log is unavailable. Rerun an older simulation with the updated server before exporting.');
  const parts=typeof input==='string'?[input]:Array.isArray(input)?input:input.lines;
  let bytes=0;
  for(const [index,line] of parts.entries()){
    bytes+=Buffer.byteLength(line)+(index?1:0);
    if(bytes>MAX_EXPORT_LOG_BYTES)throw new VgcError('INVALID_REPLAY','Battle log exceeds the 4 MiB export limit.');
  }
  const raw=parts.join('\n');
  if(!raw.trim()||!raw.split(/\r?\n/).some(line=>line.startsWith('|')))throw new VgcError('INVALID_REPLAY','A non-empty Showdown protocol battle log is required.');
  const replay=loadReplay({content:raw.replace(/\r\n?/g,'\n')});
  const lines=replay.log.split('\n');
  const ended=lines.some(line=>/^\|win\|.+/.test(line)||/^\|tie(?:\||$)/.test(line));
  if((supplied?.ended!==undefined&&supplied.ended!==ended)||(supplied?.status!==undefined&&(supplied.status==='complete')!==ended)){
    throw new VgcError('INVALID_REPLAY','Battle log status conflicts with its winner/tie event. Use a complete saved log or accurately label an unfinished log.');
  }
  const status=ended?'complete' as const:'partial' as const;
  const title=options.title??`${replay.metadata.format??'Pokémon Showdown'} replay: ${replay.metadata.players.join(' vs. ')||'Battle'}`;
  if(!title.trim()||title.length>500)throw new VgcError('INVALID_INPUT','Replay title must contain 1–500 characters.');
  const warnings=ended?[]:['Partial battle: the supplied log has no winner/tie event. Playback ends at the last recorded event.'];
  // Showdown's embed restores escaped slashes. Escaping every slash prevents a
  // user-controlled closing script tag from ending the inert protocol element.
  const payload=replay.log.replaceAll('/','\\/');
  const html=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- version 1 -->
<title>${escapeHtml(title)}</title>
<style>
body{font:14px Verdana,sans-serif;margin:0;padding:16px;color:#222;background:#f5f7fa}
h1{font-size:20px;font-weight:normal;text-align:center}.export-note,.raw-log{max-width:1180px;margin:12px auto}
.raw-log pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:white;border:1px solid #ccd3dc}
.partial{padding:10px;background:#fff1cf}.battle-log{background:white}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="export-note">Open this file in a browser. Animated playback loads Pokémon Showdown's player and assets over the internet.</p>
${warnings.length?`<p class="export-note partial">${escapeHtml(warnings[0]!)}</p>`:''}
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<input type="hidden" name="replayid" value="">
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${payload}</script>
</div>
<details class="raw-log"><summary>Raw battle log (available offline)</summary><pre>${escapeHtml(replay.log)}</pre></details>
<noscript><p class="export-note">Enable JavaScript for animated playback, or expand the raw battle log above.</p></noscript>
<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>
</body>
</html>
`;
  return {html,title,status,ended,lineCount:lines.length,logHash:replay.contentHash,requiresInternet:true as const,warnings};
}

export async function exportReplayHtml(input:{battleLog:BattleLogInput;outputPath?:string;title?:string}) {
  const rendered=createReplayHtml(input.battleLog,input.title===undefined?{}:{title:input.title});
  const path=resolve(input.outputPath??join(dataDirectory(),'replays',`replay-${randomUUID()}.html`));
  if(extname(path).toLowerCase()!=='.html')throw new VgcError('INVALID_INPUT','Replay output path must end in .html');
  try{
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,rendered.html,{encoding:'utf8',flag:'wx'});
  }catch(error){
    throw new VgcError('STORAGE_ERROR',(error as NodeJS.ErrnoException).code==='EEXIST'?'Output file already exists; choose a new path. Existing files are never overwritten.':`Cannot write replay HTML: ${errorMessage(error)}`,{path},{cause:error});
  }
  const {html,...metadata}=rendered;
  return {path,mimeType:'text/html' as const,bytes:Buffer.byteLength(html),...metadata};
}
