import {mkdir,writeFile} from 'node:fs/promises';
import {ingestReplay} from '../dist/replay/index.js';
import {loadRegulationProfile} from '../dist/regulation/profile.js';

const profile=loadRegulationProfile();
const endpoint='https://replay.pokemonshowdown.com/search.json?format=gen9championsvgc2026regmc';
async function get(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}
await mkdir('examples/public-replays',{recursive:true});
const listing=await get(endpoint);
const results=[];
for(const entry of listing.slice(0,10)) {
  const replay=await get(`https://replay.pokemonshowdown.com/${entry.id}.json`);
  const parsed=ingestReplay({content:JSON.stringify(replay)},profile);
  await writeFile(`examples/public-replays/${entry.id}.json`,JSON.stringify(replay));
  const summary={id:entry.id,format:parsed.document.metadata.format,turns:parsed.turns.length,winner:parsed.document.metadata.winner,
    sheets:Object.values(parsed.initialState.sides).map(s=>s.teamSheet?.length??0),
    finalActive:Object.values(parsed.finalState.sides).map(s=>s.activeSlots.length)};
  results.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile('examples/public-replays/validation.json',JSON.stringify({retrievedAt:new Date().toISOString(),endpoint,results},null,2));
if(!results.length) throw new Error('No current M-C public replays found');
