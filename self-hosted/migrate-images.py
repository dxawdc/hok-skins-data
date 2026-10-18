import concurrent.futures, hashlib, http.client, json, os, pathlib, re, shutil, threading, time, urllib.parse, sys
from PIL import Image

ROOT = pathlib.Path('/opt/hokskins/storage')
PUBLIC = ROOT / 'public'
ORIGINALS = PUBLIC / 'originals/hokskins/img'
MANIFEST = json.loads((ROOT / 'migration/manifest.json').read_text())
PATHS = MANIFEST['paths']
LOG = ROOT / 'migration/download.jsonl'
SIZES = [60,80,120,160,200,320]
CONNECTIONS = threading.local()

def validate(path):
    with Image.open(path) as image:
        image.verify()

def download(key):
    if not re.fullmatch(r'(skin|tag|hero|resource)/[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp|gif|avif)',key,re.I):
        return {'path':key,'ok':False,'error':'invalid path'}
    path=ORIGINALS/key
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        try:
            validate(path)
            return {'path':key,'ok':True,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'existing':True}
        except Exception: pass
    if shutil.disk_usage(ROOT).free < 5*1024**3:
        return {'path':key,'ok':False,'error':'disk reserve reached'}
    error='unknown'
    for source in ['https://erphrsydujqrcvtpdtnf.supabase.co/storage/v1/object/public/skin-images/','https://skinsdata.top/img/']:
        for attempt in range(2):
            try:
                url=urllib.parse.urlsplit(source+key)
                if not hasattr(CONNECTIONS,'hosts'): CONNECTIONS.hosts={}
                connection=CONNECTIONS.hosts.setdefault(url.hostname,http.client.HTTPSConnection(url.hostname,timeout=20))
                connection.request('GET',url.path,headers={'Accept':'image/*','User-Agent':'Hokskins-Image-Migration/1.0'})
                response=connection.getresponse()
                data=response.read(10*1024*1024+1)
                if response.status in (400,404):
                    error='HTTP '+str(response.status)
                    break
                if response.status!=200 or not response.getheader('Content-Type','').startswith('image/'):
                    raise ValueError('non-image response '+str(response.status))
                if not data or len(data)>10*1024*1024: raise ValueError('invalid image size')
                temp=path.with_name(path.name+'.part')
                temp.write_bytes(data)
                validate(temp)
                os.replace(temp,path)
                os.chmod(path,0o644)
                return {'path':key,'ok':True,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
            except Exception as exc:
                error=type(exc).__name__+': '+str(exc)[:120]
                if hasattr(CONNECTIONS,'hosts'):
                    for connection in CONNECTIONS.hosts.values(): connection.close()
                    CONNECTIONS.hosts={}
                time.sleep(attempt+1)
    return {'path':key,'ok':False,'error':error}

def thumbs(key):
    source=ORIGINALS/key
    if not source.exists(): return 0
    made=0
    with Image.open(source) as image:
        image.load()
        if getattr(image,'is_animated',False): return 0
        for size in SIZES:
            if max(image.size) <= size: continue
            dest=PUBLIC/f'thumbs/{size}/hokskins/img'/key
            if dest.exists():
                try:
                    validate(dest)
                    continue
                except Exception: pass
            dest.parent.mkdir(parents=True,exist_ok=True)
            thumbnail=image.copy()
            thumbnail.thumbnail((size,size),Image.Resampling.LANCZOS)
            if image.format=='JPEG' and thumbnail.mode not in ('RGB','L'): thumbnail=thumbnail.convert('RGB')
            temp=dest.with_name(dest.name+'.part')
            thumbnail.save(temp,format=image.format,quality=75,compress_level=3)
            os.chmod(temp,0o644)
            os.replace(temp,dest)
            made+=1
    return made

if '--thumbs-only' not in sys.argv:
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool, LOG.open('a') as log:
        for index,result in enumerate(pool.map(download,PATHS),1):
            results.append(result)
            log.write(json.dumps(result)+'\n');log.flush()
            if index%50==0: print(json.dumps({'phase':'download','done':index,'total':len(PATHS),'ok':sum(r['ok'] for r in results)}),flush=True)
    summary={'total':len(PATHS),'ok':sum(r['ok'] for r in results),'bytes':sum(r.get('bytes',0) for r in results),'failed':[r for r in results if not r['ok']]}
    (ROOT/'migration/summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary),flush=True)
for index,key in enumerate(PATHS,1):
    try: thumbs(key)
    except Exception as exc: print(json.dumps({'thumbnail_error':key,'error':type(exc).__name__}),flush=True)
    if index%100==0: print(json.dumps({'phase':'thumbnails','done':index,'total':len(PATHS)}),flush=True)
print('migration copy finished',flush=True)
