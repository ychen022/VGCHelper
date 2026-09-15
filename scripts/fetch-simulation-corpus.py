"""Bounded, hash-verified sampling of pinned Champions-only HolidayOugi shards.

Requires requests and pyarrow; workspace-local pyarrow is detected automatically.
Raw source text is data and is never executed. No other generations are fetched.
"""
import argparse, collections, hashlib, json, pathlib, random, sys, time, urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path('.vgc-helper/python-libs').resolve()))
import requests
import pyarrow.parquet as pq

DATASET='HolidayOugi/pokemon-showdown-replays'
FORMATS={'gen9championsvgc2026regmc','gen9championsvgc2026regmcbo3'}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--revision',required=True,help='Immutable dataset commit containing explicit M-C games')
    parser.add_argument('--parts',default='4')
    parser.add_argument('--max-records',type=int,default=2000)
    parser.add_argument('--max-download-mb',type=int,default=350)
    parser.add_argument('--seed',type=int,default=20260907)
    parser.add_argument('--output',default='.vgc-helper/experiments/m-c')
    args=parser.parse_args()
    revision=args.revision
    if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision): parser.error('revision must be a full lowercase commit SHA')
    parts=[int(x) for x in args.parts.split(',')]
    if not parts or any(x not in range(1,5) for x in parts) or len(set(parts))!=len(parts): parser.error('parts must be distinct values 1–4')
    if not 1<=args.max_records<=100000 or not 1<=args.max_download_mb<=2048: parser.error('invalid bounded sample/download limit')
    root=pathlib.Path(args.output);root.mkdir(parents=True,exist_ok=True)
    session=requests.Session()
    response=session.get(f'https://huggingface.co/api/datasets/{DATASET}/tree/{revision}',params={'recursive':'false','limit':1000},timeout=30);response.raise_for_status()
    entries={x['path']:x for x in response.json()}
    downloaded=0;scanned=0;accepted=0;formats=collections.Counter();sample=[];rng=random.Random(args.seed);manifest=[]
    for part in parts:
        name=f'[Gen 9] CHAMPIONS VGC 2026_part{part}.parquet'
        entry=entries[name];expected=entry['lfs']['oid'];path=root/f'part{part}.parquet'
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            if downloaded+entry['size']>args.max_download_mb*1024*1024: raise RuntimeError('Requested source would exceed the declared download bound')
            url=f'https://huggingface.co/datasets/{DATASET}/resolve/{revision}/{urllib.parse.quote(name)}'
            temp=path.with_suffix('.partial');digest=hashlib.sha256();size=0;last=time.monotonic()
            with session.get(url,stream=True,timeout=60) as response:
                response.raise_for_status()
                with temp.open('wb') as output:
                    for chunk in response.iter_content(1024*1024):
                        size+=len(chunk)
                        if size>entry['size'] or downloaded+size>args.max_download_mb*1024*1024: raise RuntimeError('Source stream exceeded its size/download bound')
                        output.write(chunk);digest.update(chunk)
                        if time.monotonic()-last>5: print(json.dumps({'stage':'download','part':part,'bytes':size}),flush=True);last=time.monotonic()
            if size!=entry['size'] or digest.hexdigest()!=expected: raise RuntimeError('Pinned Parquet SHA-256/size verification failed')
            temp.replace(path);downloaded+=size
        parquet=pq.ParquetFile(path)
        for batch in parquet.iter_batches(batch_size=512):
            for row in batch.to_pylist():
                scanned+=1;fmt=row.get('formatid','');formats[fmt]+=1
                if fmt not in FORMATS or not isinstance(row.get('log'),str):continue
                tier=next((line.split('|',2)[2] for line in row['log'].splitlines() if line.startswith('|tier|')),'')
                wanted='[Gen 9 Champions] VGC 2026 Reg M-C'+(' (Bo3)' if fmt.endswith('bo3') else '')
                if tier!=wanted:continue
                accepted+=1
                value={**row,'source':{'provider':'HolidayOugi','revision':revision,'sourceVersion':expected,'url':f'https://huggingface.co/datasets/{DATASET}/blob/{revision}/{urllib.parse.quote(name)}'}}
                if len(sample)<args.max_records:sample.append(value)
                else:
                    index=rng.randrange(accepted)
                    if index<args.max_records:sample[index]=value
        manifest.append({'path':name,'sha256':expected,'bytes':entry['size'],'rows':parquet.metadata.num_rows,'rowGroups':parquet.num_row_groups})
        print(json.dumps({'stage':'scanned','part':part,'rows':scanned,'eligible':accepted,'sample':len(sample),'formats':formats}),flush=True)
    sample.sort(key=lambda row:(row.get('uploadtime',0),row.get('id','')))
    data=''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in sample).encode('utf-8')
    (root/'holidayougi-mc.jsonl').write_bytes(data)
    result={'dataset':DATASET,'revision':revision,'retrievedAt':datetime.now(timezone.utc).isoformat(),'shards':manifest,'downloadedBytes':downloaded,'scannedRows':scanned,'eligibleRows':accepted,'sampledRows':len(sample),'sourceFormats':formats,'seed':args.seed,'sampleSha256':hashlib.sha256(data).hexdigest(),'selection':'Uniform reservoir over explicit log-verified M-C rows in the selected shards; not a random sample of the entire dataset.','limits':{'maxRecords':args.max_records,'maxDownloadMB':args.max_download_mb}}
    (root/'corpus-manifest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
