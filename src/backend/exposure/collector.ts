/** Fixed read-only collector. Configuration is projected on the host before it leaves SSH. */
export const PYTHON_COLLECTOR = String.raw`
import json, re, subprocess, shutil, ipaddress, urllib.parse, os, signal, stat, time
LIMIT = 300
MAX = 2000000

class Records(list):
    def __init__(self):
        super().__init__()
        self.complete=True
        self.issues=[]
    def gap(self,key):
        self.complete=False
        if len(self.issues)<LIMIT: self.issues.append({'objectKey':str(key),'reason':'unsupported-rule'})

def endpoint(address, port, protocol='tcp'):
    return {'address':str(address), 'port':int(port), 'protocol':protocol}

def target(url):
    p = urllib.parse.urlsplit(url if '://' in url else 'tcp://' + url)
    if p.username or p.password or p.query or p.fragment: return None
    if not p.hostname or p.scheme not in ('http','https','tcp','udp','ssh'): return None
    port=p.port or {'http':80,'https':443,'ssh':22}.get(p.scheme)
    if not port: return None
    return endpoint(p.hostname, port, 'udp' if p.scheme == 'udp' else 'tcp')

def row(key, kind, ep, backend=None, **fields):
    r = dict(objectKey=str(key), kind=kind, endpoint=ep, tls='unknown', restricted='unknown', constraints=[])
    if backend: r['backend'] = backend
    r.update(fields)
    return r

def nginx(text):
    # Preserve only static routing directives; credentials, headers and keys never leave this process.
    tokens=re.findall(r'"(?:\\.|[^"\\])*"|\x27[^\x27]*\x27|#[^\n]*|[{};]|[^\s{};]+',text)
    stack=[]; directive=[]; servers=[]; server=None
    for token in tokens:
        if token.startswith('#'): continue
        if token=='{':
            name=directive[0] if directive else ''
            stack.append((name, list(directive)))
            if name=='server' and server is None:
                server={'listen':[], 'names':[], 'routes':[], 'depth':len(stack)}
            directive=[]
        elif token=='}':
            if server and len(stack)==server['depth']: servers.append(server); server=None
            if stack: stack.pop()
            directive=[]
        elif token==';':
            if server and directive:
                name,*values=directive
                values=[v.strip('"\x27') for v in values]
                if name=='listen': server['listen'].append(values)
                if name=='server_name': server['names'].extend(values)
                if name=='proxy_pass' and values:
                    location=next((d[1][-1] for d in reversed(stack) if d[0]=='location'),'/')
                    server['routes'].append((location,values[0]))
            directive=[]
        else: directive.append(token)
    if stack: raise ValueError('incomplete nginx configuration')
    rows=Records()
    for n,s in enumerate(servers):
        for spec in s['listen']:
            raw=spec[0]
            if '$' in raw or 'unix:' in raw:
                rows.gap('rule:'+str(len(rows))); continue
            if raw.isdigit(): addr,port='0.0.0.0',raw
            else: addr,port=raw.rsplit(':',1); addr=addr.strip('[]')
            for path,url in s['routes']:
                if '$' in url or '$' in path:
                    rows.gap('rule:'+str(len(rows))); continue
                backend=target(url)
                if not backend:
                    rows.gap('rule:'+str(len(rows))); continue
                for host in (s['names'] or ['']):
                    rows.append(row(str(n)+':'+raw+':'+host+':'+path,'proxy',endpoint(addr,port,'udp' if 'udp' in spec else 'tcp'),backend,hostname=host,path=path,tls='configured' if 'ssl' in spec else 'unknown',constraints=['proxy-access-policy-unverified']))
    return rows

def ingress(text):
    rows=Records()
    for item in json.loads(text).get('items',[]):
        meta=item.get('metadata',{}); spec=item.get('spec',{}); namespace=meta.get('namespace','default')
        if spec.get('defaultBackend'): rows.gap('rule:'+str(len(rows)))
        for rule in spec.get('rules',[]):
            host=rule.get('host','')
            tls=any(host in t.get('hosts',[]) for t in spec.get('tls',[]))
            for path in rule.get('http',{}).get('paths',[]):
                service=path.get('backend',{}).get('service',{}); port=service.get('port',{}).get('number')
                if not port:
                    rows.gap('rule:'+str(len(rows))); continue
                backend=endpoint(service.get('name','')+'.'+namespace+'.svc',port)
                rows.append(row(namespace+'/'+meta.get('name','')+':'+host+':'+path.get('path','/'),'proxy',endpoint(host or '*',443 if tls else 80),backend,hostname=host,path=path.get('path','/'),tls='configured' if tls else 'unknown',constraints=['ingress-controller-and-access-policy-unverified']))
    return rows

def tailscale(text):
    data=json.loads(text); rows=Records()
    if data.get('Foreground') or any(v.get('TCPForward') for v in data.get('TCP',{}).values()): rows.gap('rule:'+str(len(rows)))
    for key,web in data.get('Web',{}).items():
        host,port=key.rsplit(':',1)
        if data.get('AllowFunnel',{}).get(key) is not True: continue
        for path,handler in web.get('Handlers',{}).items():
            backend=target(handler.get('Proxy',''))
            if not backend: rows.gap('rule:'+str(len(rows)))
            if backend: rows.append(row(key+path,'tunnel',endpoint(host,port),backend,hostname=host,path=path,tls='configured',constraints=['funnel-runtime-unverified']))
    return rows

def frp(text):
    try:
        import tomllib
        data=tomllib.loads(text)
    except ModuleNotFoundError: data=frp_subset(text)
    rows=Records()
    if data.get('includes'): rows.gap('rule:'+str(len(rows)))
    server=data.get('serverAddr','')
    for proxy in data.get('proxies',[]):
        proto=proxy.get('type','tcp')
        if proto not in ('tcp','udp') or proxy.get('plugin') or not proxy.get('remotePort') or not proxy.get('localPort'):
            rows.gap('rule:'+str(len(rows))); continue
        rows.append(row(proxy.get('name','')+':'+str(proxy['remotePort']),'tunnel',endpoint(server,proxy['remotePort'],proto),endpoint(proxy.get('localIP','127.0.0.1'),proxy['localPort'],proto),constraints=['frp-server-binding-and-runtime-unverified']))
    return rows

def cloudflared(text):
    try: data=json.loads(text)
    except ValueError:
        try:
            import yaml
            data=yaml.safe_load(text)
        except ModuleNotFoundError: data=cloudflared_subset(text)
    rows=Records()
    for route in data.get('ingress',[]):
        service=route.get('service','')
        if service.startswith('http_status:'): continue
        hostname=route.get('hostname'); backend=target(service)
        if not hostname or not backend: rows.gap('rule:'+str(len(rows))); continue
        rows.append(row(hostname+':'+route.get('path','/'),'tunnel',endpoint(hostname,443),backend,hostname=hostname,path=route.get('path','/'),constraints=['edge-dns-tls-access-and-runtime-unverified']))
    return rows

def scalar(value):
    value=value.strip()
    if value.startswith('"'): return json.loads(value)
    if value.startswith("'") and value.endswith("'") and "'" not in value[1:-1]: return value[1:-1]
    if re.fullmatch(r'[a-zA-Z0-9_./:*\[\]-]+',value): return value
    raise ValueError('unsupported scalar')

def frp_subset(text):
    # Python 3.8+ fallback: scalar TOML TCP/UDP proxies only, never eval or imports.
    data={'proxies':[]}; section=''; current=data
    if chr(34)*3 in text or chr(39)*3 in text: raise ValueError("multiline TOML")
    for line in text.splitlines():
        line=line.strip()
        if not line or line.startswith('#'): continue
        if line=='[[proxies]]': current={}; data['proxies'].append(current); section='proxy'; continue
        if line.startswith('['):
            if line.startswith('[proxies.'): current['plugin']=True
            section='other'; continue
        if '=' not in line: raise ValueError('TOML')
        key,value=line.split('=',1); key=key.strip()
        if key=='includes': data['includes']=True
        if section=='other': continue
        if key not in ('serverAddr','name','type','localIP','localPort','remotePort'): continue
        value=scalar(value)
        current[key]=int(value) if key in ('localPort','remotePort') else value
    return data

def cloudflared_subset(text):
    # Only project top-level ingress sequence scalars; nested originRequest is never read.
    if re.search(r':\s*[|>]',text): raise ValueError('multiline YAML')
    routes=[]; active=False; base=None; field_indent=None; current=None
    for line in text.splitlines():
        if '\t' in line: raise ValueError('YAML tabs')
        stripped=line.strip(); indent=len(line)-len(line.lstrip())
        if not stripped or stripped.startswith('#'): continue
        if not active:
            if stripped=='ingress:' and indent==0: active=True
            continue
        if indent==0 and not stripped.startswith('-'): break
        if stripped.startswith('- '):
            if base is None: base=indent
            if indent!=base: continue
            current={}; routes.append(current); field_indent=indent+2; stripped=stripped[2:]
        elif current is None or indent!=field_indent: continue
        if ':' not in stripped: raise ValueError('YAML ingress')
        key,value=stripped.split(':',1)
        if key not in ('hostname','service','path'): continue
        current[key]=scalar(value)
    if not active: raise ValueError('missing ingress')
    return {'ingress':routes}

def caddy(text, runtime=False):
    data=json.loads(text); rows=Records()
    def walk(routes, ep, prefix, hosts=None, paths=None, depth=0):
        if depth>20: rows.gap('rule:'+str(len(rows))); return
        for i,route in enumerate(routes):
            key=prefix+':'+str(i)
            matches=route.get('match') or [{}]
            for m,match in enumerate(matches):
                h=match.get('host',hosts) or ['']; p=match.get('path',paths) or ['/']
                for j,handler in enumerate(route.get('handle',[])):
                    if handler.get('handler')=='subroute': walk(handler.get('routes',[]),ep,key+':'+str(m)+':'+str(j),h,p,depth+1)
                    if handler.get('handler')!='reverse_proxy': continue
                    if handler.get('dynamic_upstreams'): rows.gap('rule:'+str(len(rows)))
                    for k,upstream in enumerate(handler.get('upstreams',[])):
                        dial=upstream.get('dial','')
                        if '{' in dial or '/' in dial: rows.gap('rule:'+str(len(rows))); continue
                        backend=target(dial)
                        if not backend: rows.gap('rule:'+str(len(rows))); continue
                        for hostname in h:
                            for path in p:
                                rows.append(row(key+':'+str(m)+':'+str(j)+':'+str(k)+':'+hostname+':'+path,'proxy',ep,backend,hostname=hostname,path=path,constraints=['caddy-runtime-config' if runtime else 'caddy-config-not-runtime','route-match-and-access-policy-unverified','tls-policy-unverified']))
    for i,server in enumerate(data.get('apps',{}).get('http',{}).get('servers',{}).values()):
        for listen in server.get('listen',[]):
            try:
                address,port=listen.rsplit(':',1); address=address.strip('[]') or '0.0.0.0'
                if '/' in address or '{' in address: raise ValueError('address')
                walk(server.get('routes',[]),endpoint(address,port),str(i)+':'+listen)
            except (ValueError,TypeError): rows.gap('rule:'+str(len(rows)))
    return rows

DEADLINE = None

def read_command(args):
    if DEADLINE is not None and time.monotonic()>=DEADLINE: raise TimeoutError('budget')
    proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    import threading
    def kill():
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
    timer=threading.Timer(min(5,max(.01,DEADLINE-time.monotonic())) if DEADLINE else 5,kill); timer.start()
    try:
        raw=proc.stdout.read(MAX+1)
        if len(raw)>MAX: kill(); raise ValueError('truncated')
        if proc.wait()!=0: raise ValueError('command failed')
        return raw.decode('utf-8','replace')
    finally:
        timer.cancel()
        if proc.poll() is None: kill()
        proc.wait(); proc.stdout.close()

def config_path(args):
    for i,arg in enumerate(args):
        if arg in ('--config','-c') and i+1<len(args): return args[i+1]
        if arg.startswith('--config='): return arg.split('=',1)[1]
    return None

def process_configs():
    result={'frp':[], 'cloudflared':[], 'caddy':[]}
    for pid in sorted(os.listdir('/proc'))[:8192]:
        if not pid.isdigit(): continue
        try:
            with open('/proc/'+pid+'/cmdline','rb') as f: raw=f.read(65537)
            if len(raw)>65536: continue
            args=raw.decode('utf-8','replace').strip('\0').split('\0')
            executable=os.path.basename(args[0]); source={'frpc':'frp','cloudflared':'cloudflared','caddy':'caddy'}.get(executable)
            if not source: continue
            path=config_path(args)
            if path and not os.path.isabs(path): path=os.path.join(os.readlink('/proc/'+pid+'/cwd'),path)
            if path and len(path)<=4096 and '\n' not in path: result[source].append(path)
        except (OSError,ValueError): pass
    return result

def caddy_config(args, prefix=None):
    path=config_path(args) or '/etc/caddy/Caddyfile'
    if not os.path.isabs(path) or len(path)>4096 or '\n' in path: raise ValueError('path')
    if path.endswith('.json'):
        if prefix: return caddy(read_command(prefix+['cat','--',path]))
        if not os.path.isfile(path): raise ValueError('not a regular config')
        with open(path,'r') as f: text=f.read(MAX+1)
        if len(text)>MAX: raise ValueError('truncated')
        return caddy(text)
    command=['caddy','adapt','--config',path,'--adapter','caddyfile']
    return caddy(read_command((prefix or [])+command))

def container_proxies():
    entry={'source':'container_proxy','status':'unsupported','complete':False,'records':[], 'issues':[]}
    if not shutil.which('docker'): return entry
    try:
        ids=read_command(['docker','ps','-q','--no-trunc']).splitlines()
        entry.update(status='ok',complete=len(ids)<=32)
        for cid in ids[:32]:
            if not re.fullmatch('[a-f0-9]{64}',cid): entry['complete']=False; continue
            try:
                # Inspect only command identity and port bindings, not environment or labels.
                info=json.loads(read_command(['docker','inspect','--format','{"path":{{json .Path}},"args":{{json .Args}},"ports":{{json .NetworkSettings.Ports}},"network":{{json .HostConfig.NetworkMode}}}',cid]))
                args=[info.get('path','')]+(info.get('args') or [])
                names=[os.path.basename(a) for a in args[:4]]
                if 'nginx' in names: rows=nginx(read_command(['docker','exec',cid,'nginx','-T']))
                elif 'caddy' in names: rows=caddy_config(args,['docker','exec',cid])
                else: continue
                entry['complete']=entry['complete'] and rows.complete
                entry['issues'].extend(rows.issues)
                for r in rows:
                    port=str(r['endpoint']['port'])+'/'+r['endpoint']['protocol']
                    bindings=(info.get('ports') or {}).get(port) or []
                    if not bindings:
                        bindings=[{'HostIp':r['endpoint']['address'] if info.get('network')=='host' else 'container-'+cid, 'HostPort':str(r['endpoint']['port'])}]
                    for binding in bindings:
                        projected=dict(r)
                        projected['endpoint']=endpoint(binding['HostIp'],binding['HostPort'],r['endpoint']['protocol'])
                        projected['objectKey']=cid+':'+r['objectKey']+':'+binding['HostIp']+':'+binding['HostPort']
                        projected['constraints']=r['constraints']+([] if info.get('network')=='host' else ['container-backend-namespace-unresolved'])
                        entry['records'].append(projected)
            except Exception:
                entry['complete']=False
                entry['issues'].append({'objectKey':'container:'+cid,'reason':'unsupported-rule'})
        if len(entry['records'])>LIMIT: entry.update(status='truncated',complete=False)
        entry['records']=entry['records'][:LIMIT]
    except Exception: entry.update(status='failed',complete=False)
    return entry

FILES = [
 ('frp',['/etc/frp/frpc.toml'],frp),
 ('cloudflared',['/etc/cloudflared/config.yml','/etc/cloudflared/config.yaml','/usr/local/etc/cloudflared/config.yml'],cloudflared)]

def caddy_runtime():
    # Fixed loopback GET only. http.client ignores proxy env and never follows redirects.
    import http.client
    for address in ('127.0.0.1','::1'):
        end=min(time.monotonic()+2,DEADLINE) if DEADLINE else time.monotonic()+2
        if end<=time.monotonic(): raise TimeoutError('budget')
        conn=http.client.HTTPConnection(address,2019,timeout=max(.01,end-time.monotonic()))
        try:
            conn.request('GET','/config/',headers={'Host':'localhost:2019','Accept':'application/json'})
            sock=conn.sock
            response=conn.getresponse()
            if response.status!=200: continue
            raw=bytearray()
            while len(raw)<=MAX:
                if response.isclosed(): break
                remaining=end-time.monotonic()
                if remaining<=0: raise TimeoutError('budget')
                # Bound each read by the remaining total request budget, including slow streams.
                sock.settimeout(remaining)
                chunk=response.read1(min(65536,MAX+1-len(raw)))
                if not chunk: break
                raw.extend(chunk)
            if len(raw)>MAX: raise ValueError('truncated')
            data=json.loads(raw)
            if not isinstance(data,dict) or not isinstance(data.get('apps'),dict): raise ValueError('schema')
            return caddy(json.dumps(data),runtime=True)
        except Exception: pass
        finally: conn.close()
    raise ValueError('local admin unavailable')

def collect_caddy(paths):
    entry={'source':'caddy','status':'ok','complete':True,'records':[], 'issues':[]}
    try:
        rows=caddy_runtime()
        entry.update(records=rows[:LIMIT],issues=rows.issues,complete=rows.complete and len(rows)<=LIMIT)
        if len(rows)>LIMIT: entry['status']='truncated'
        return entry
    except Exception: pass
    entry['complete']=len(paths)<=16
    for path in paths[:16]:
        try:
            rows=caddy_config(['--config',path])
            entry['records'].extend(rows)
            entry['issues'].extend(rows.issues)
            entry['complete']=entry['complete'] and rows.complete
        except Exception: entry.update(status='failed',complete=False)
    if len(entry['records'])>LIMIT: entry.update(status='truncated',complete=False)
    entry['records']=entry['records'][:LIMIT]
    return entry

def collect_files():
    output=[]
    discovered=process_configs()
    for name,paths,parse in FILES:
        paths=list(dict.fromkeys(paths+discovered[name]))
        entry={'source':name,'status':'unsupported','complete':False,'records':[], 'issues':[]}
        found=False; complete=len(paths)<=16
        for path in paths[:16]:
            if not os.path.isfile(path): continue
            found=True
            try:
                with open(path,'r') as f: text=f.read(MAX+1)
                if len(text)>MAX: entry['status']='truncated'; complete=False; continue
                rows=parse(text)
                for r in rows:
                    r['objectKey']=path+':'+r['objectKey']
                entry['records'].extend(rows[:LIMIT])
                entry['issues'].extend(rows.issues)
                complete=complete and rows.complete and len(rows)<=LIMIT
                if entry['status']=='unsupported': entry['status']='ok'
            except ModuleNotFoundError: complete=False
            except PermissionError: entry['status']='denied'; complete=False
            except Exception: entry['status']='failed'; complete=False
        entry['complete']=found and complete and entry['status']=='ok' and len(entry['records'])<=LIMIT
        if len(entry['records'])>LIMIT: entry['status']='truncated'
        entry['records']=entry['records'][:LIMIT]
        output.append(entry)
    caddy_entry={'source':'caddy','status':'unsupported','complete':False,'records':[], 'issues':[]}
    if shutil.which('caddy') or discovered['caddy']:
        caddy_entry=collect_caddy(discovered['caddy'] or ['/etc/caddy/Caddyfile'])
    output.append(caddy_entry)
    return output

COMMANDS = [
 ('nginx',['nginx','-T'],nginx),
 ('ingress',['kubectl','get','ingress','--all-namespaces','-o','json'],ingress),
 ('tailscale',['tailscale','serve','status','--json'],tailscale)]

def collect():
    output=[]
    for name,args,parse in COMMANDS:
        entry={'source':name,'status':'unsupported','complete':False,'records':[], 'issues':[]}
        if shutil.which(args[0]):
            try:
                # Bound both execution and buffered output; no shell or inherited proxy settings.
                proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
                import threading
                def kill():
                    try: os.killpg(proc.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                timer=threading.Timer(5,kill); timer.start()
                try:
                    raw=proc.stdout.read(MAX+1)
                    if len(raw)>MAX: kill(); entry['status']='truncated'
                    elif proc.wait()==0:
                        rows=parse(raw.decode('utf-8','replace'))
                        entry.update(status='ok' if len(rows)<=LIMIT else 'truncated',complete=len(rows)<=LIMIT and rows.complete,records=rows[:LIMIT],issues=rows.issues)
                    else: entry['status']='failed'
                finally:
                    timer.cancel()
                    if proc.poll() is None: kill()
                    proc.wait(); proc.stdout.close()
            except Exception: entry['status']='failed'
        output.append(entry)
    return output

if __name__ == '__main__':
    DEADLINE=time.monotonic()+50
    print(json.dumps(collect()+collect_files()+[container_proxies()],separators=(',',':')))
`;
export function unavailableSecureObservations(): string {
  return JSON.stringify(
    [
      "nginx",
      "ingress",
      "tailscale",
      "frp",
      "cloudflared",
      "caddy",
      "container_proxy",
    ].map((source) => ({
      source,
      status: "unsupported",
      complete: false,
      records: [],
    })),
  );
}
export function exposureScript(): string {
  const unsupported = unavailableSecureObservations();
  return `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY\nif ! command -v python3 >/dev/null 2>&1; then printf '%s\\n' '${unsupported}'; exit 0; fi\npython3 - 2>/dev/null <<'TERMIX_EXPOSURE_PY'\n${PYTHON_COLLECTOR}\nTERMIX_EXPOSURE_PY`;
}
