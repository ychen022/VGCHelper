import {createServer,type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {z} from 'zod/v4';
import type {HumanBattles} from './matches.js';
import {createReplayHtml} from '../replay/export.js';

const commandSchema=z.strictObject({decisionId:z.string().max(200),command:z.string().max(256)});
/** Preserve Showdown format capitalization; strip punctuation and use local download time. */
export function battleDownloadFilename(formatName:string,extension:'html'|'log',date=new Date()):string {
  const format=formatName.replace(/[^A-Za-z0-9]/g,'')||'Battle';
  const timestamp=[date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds()]
    .map((part,index)=>String(part).padStart(index===0?4:2,'0')).join('-');
  return `${format}-sim-${timestamp}.${extension}`;
}
/** Loopback-only browser transport. It has no agent/admin route or raw-state endpoint. */
export class BattleHttpServer {
  private server:Server|undefined;
  private starting:Promise<string>|undefined;
  private interval:NodeJS.Timeout|undefined;
  private origin='';
  constructor(private readonly matches:HumanBattles) {}
  async open(userToken:string):Promise<string> {
    this.matches.view(userToken,'user');
    if(!this.starting)this.starting=this.listen().catch(error => {this.starting=undefined;throw error;});
    return `${await this.starting}/#${userToken}`;
  }
  private async listen():Promise<string> {
    const assets=new Map<string,[string,string]>([
      ['/', ['index.html','text/html; charset=utf-8']],
      ['/app.js',['app.js','text/javascript; charset=utf-8']],
      ['/presentation.js',['presentation.js','text/javascript; charset=utf-8']],
      ['/style.css',['style.css','text/css; charset=utf-8']],
    ]);
    const server=createServer(async (req,res) => {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https://play.pokemonshowdown.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      try {
        if(req.headers.host!==new URL(this.origin).host || (req.headers.origin && req.headers.origin!==this.origin)) {
          res.writeHead(403).end('Local origin required');return;
        }
        const path=new URL(req.url??'/',this.origin).pathname;
        const asset=assets.get(path);
        if(asset && req.method==='GET') {
          res.setHeader('Content-Type',asset[1]);res.end(await readFile(new URL(`./web/${asset[0]}`,import.meta.url)));return;
        }
        const credential=req.headers.authorization?.replace(/^Bearer /,'');
        if(!credential) {res.writeHead(401).end('Battle credential required');return;}
        res.setHeader('Content-Type','application/json; charset=utf-8');
        if(path==='/api/view' && req.method==='GET') {res.end(JSON.stringify(this.matches.view(credential,'user')));return;}
        if((path==='/api/replay'||path==='/api/log') && req.method==='GET') {
          const view=this.matches.view(credential,'user');
          const formatName=view.observations.find(line=>line.startsWith('|tier|'))?.slice(6)||view.profile.format;
          if(path==='/api/replay') {
            const replay=createReplayHtml(view.observations,{title:'Champions M-C · You vs. Agent'});
            res.end(JSON.stringify({html:replay.html,filename:battleDownloadFilename(formatName,'html')}));
          }else res.end(JSON.stringify({log:view.observations.join('\n'),filename:battleDownloadFilename(formatName,'log')}));
          return;
        }
        if(req.method!=='POST' || req.headers.origin!==this.origin || !req.headers['content-type']?.startsWith('application/json')) {
          res.writeHead(403).end(JSON.stringify({error:'Same-origin JSON request required'}));return;
        }
        let body='';
        for await(const chunk of req) {body+=chunk.toString();if(Buffer.byteLength(body)>4096){res.writeHead(413).end();return;}}
        const data:unknown=JSON.parse(body||'{}');
        let result:unknown;
        if(path==='/api/choose') {const input=commandSchema.parse(data);result=this.matches.submit(credential,'user',input.decisionId,input.command);}
        else if(path==='/api/rematch') {const input=z.strictObject({decisionId:z.string().max(200),mode:z.enum(['remember','fresh'])}).parse(data);result=this.matches.requestRematch(credential,input.decisionId,input.mode);}
        else if(path==='/api/ready') {z.strictObject({}).parse(data);result=this.matches.ready(credential);}
        else if(path==='/api/forfeit') {z.strictObject({}).parse(data);result=this.matches.forfeit(credential);}
        else {res.writeHead(404).end(JSON.stringify({error:'Unknown endpoint'}));return;}
        res.end(JSON.stringify(result));
      } catch(error) {
        res.statusCode=400;res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({error:error instanceof Error?error.message:'Request failed'}));
      }
    });
    this.server=server;
    await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();
    if(!address || typeof address==='string')throw new Error('Could not bind local battle server');
    this.origin=`http://127.0.0.1:${address.port}`;
    this.interval=setInterval(() => {try {this.matches.tick();}catch(error){console.error('Battle timer error:',error instanceof Error?error.message:'unknown');}},250);
    this.interval.unref();server.unref();
    return this.origin;
  }
  close():void {if(this.interval)clearInterval(this.interval);this.server?.closeAllConnections();this.server?.close();}
}
