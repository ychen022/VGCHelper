import {readFileSync,unlinkSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {createReplayHtml,exportReplayHtml} from '../src/replay/export.js';
import {loadReplay} from '../src/replay/input.js';

const log='|gametype|singles\n|gen|9\n|tier|[Gen 9] OU\n|player|p1|Alice 雪|\n|player|p2|Bob|\n|start\n|turn|1\n|move|p1a: Pikachu|Thunderbolt|p2a: Squirtle\n|-damage|p2a: Squirtle|0 fnt\n|faint|p2a: Squirtle\n|win|Alice 雪';

describe('Showdown replay HTML export',()=>{
  it.each([log,log.split('\n'),{lines:log.split('\n'),status:'complete' as const,ended:true,turn:1}])('round-trips the complete protocol from supported battleLog inputs',input=>{
    const result=createReplayHtml(input);
    const imported=loadReplay({content:result.html});
    expect(imported.log).toBe(log);
    expect(imported.metadata.winner).toBe('Alice 雪');
    expect(result).toMatchObject({status:'complete',requiresInternet:true});
    expect(result.html).toContain('https://play.pokemonshowdown.com/js/replay-embed.js');
    expect(result.html).toContain('class="replay-controls"');
  });
  it('preserves Unicode, literal slashes and closing-script text without embedding executable markup',()=>{
    const attack='</ScRiPt><img src=x onerror="alert(1)"> & 雪 \\/';
    const input=log.replace('Alice 雪',attack)+'\n|c|Bob|'+attack;
    const result=createReplayHtml(input,{title:attack});
    expect(loadReplay({content:result.html}).log).toBe(input);
    expect(result.html.replace(/<script type="text\/plain" class="battle-log-data">[\s\S]*?<\/script>/,'')).not.toContain('<img src=x');
    expect(result.html.match(/<\/script>/gi)).toHaveLength(2);
    expect(result.html).toContain('&lt;/ScRiPt&gt;');
  });
  it('exports unfinished logs as partial without manufacturing a result',()=>{
    const partial=log.slice(0,log.lastIndexOf('\n|win|'));
    const result=createReplayHtml({lines:partial.split('\n'),status:'partial',ended:false});
    expect(result.status).toBe('partial');
    expect(result.warnings.join(' ')).toMatch(/partial/i);
    expect(result.html).toContain('Partial battle');
    expect(loadReplay({content:result.html}).log).toBe(partial);
  });
  it('recognizes draws as terminal',()=>{
    expect(createReplayHtml(log.replace('|win|Alice 雪','|tie')).status).toBe('complete');
  });
  it('rejects unavailable, empty, invalid, oversized, and contradictory logs',()=>{
    for(const input of ['', 'not a battle', {status:'unavailable' as const,lines:[]}, {lines:['|turn|1'],ended:true}, '雪'.repeat(1500000)]){
      expect(()=>createReplayHtml(input)).toThrow();
    }
  });
  it('rejects aggregate oversized arrays before allocating their joined protocol string',()=>{
    // Shared strings keep this fixture small; joining it would exceed V8's string limit.
    const lines=Array<string>(2048).fill('x'.repeat(1024*1024));
    expect(()=>createReplayHtml(lines)).toThrow(/4 MiB export limit/);
    expect(()=>createReplayHtml({lines})).toThrow(/4 MiB export limit/);
  });
  it('writes a real HTML artifact and refuses to overwrite an existing file',async()=>{
    const path=resolve('.vgc-helper',`replay-export-test-${randomUUID()}.html`);
    try{
      const result=await exportReplayHtml({battleLog:log,outputPath:path});
      expect(result.path).toBe(path);
      expect(result.bytes).toBe(Buffer.byteLength(readFileSync(path)));
      expect(loadReplay({path}).log).toBe(log);
      await expect(exportReplayHtml({battleLog:log,outputPath:path})).rejects.toThrow(/exist|overwrite/i);
      expect(loadReplay({path}).log).toBe(log);
    }finally{if(existsSync(path))unlinkSync(path);}
    await expect(exportReplayHtml({battleLog:log,outputPath:'wrong-extension.txt'})).rejects.toThrow(/html/i);
  });
});
