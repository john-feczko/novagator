from regions import *
import json,heapq,math
g=json.load(open('floor3.graph.json'))
N={n['id']:n for n in g['nodes']}; E=g['edges']
def build():
    adj={}
    for e in E: adj.setdefault(e['a'],[]).append((e['b'],e['length'])); adj.setdefault(e['b'],[]).append((e['a'],e['length']))
    return adj
def gd(adj,s,t,cap):
    D={s:0};pq=[(0,s)]
    while pq:
        d,u=heapq.heappop(pq)
        if u==t: return d
        if d>cap: return 1e9
        if d>D[u]: continue
        for v,w in adj.get(u,[]):
            if N[v]['type'] not in('corridor',) and v!=t: continue
            if d+w<D.get(v,1e9): D[v]=d+w; heapq.heappush(pq,(d+w,v))
    return 1e9
WO=raster([W],th=3)
def los(a,b):
    L=math.hypot(b[0]-a[0],b[1]-a[1]); m=max(2,int(L/0.03))
    for i in range(m+1):
        t=i/m; c,r=px(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t)
        if WO[int(round(r)),int(round(c))]: return False
    return True
added=0; c=[max(int(n['id'][3:]) for n in g['nodes'] if n['id'].startswith('3-C'))]
for it in range(3):
    adj=build()
    for n in list(N.values()):
        if n['type']!='corridor': continue
        cands=[]
        for i,e in enumerate(E):
            if e['kind']!='corridor' or n['id'] in(e['a'],e['b']): continue
            A,B=N[e['a']],N[e['b']]; dx,dy=B['x']-A['x'],B['y']-A['y']; L2=dx*dx+dy*dy or 1e-9
            t=max(0,min(1,((n['x']-A['x'])*dx+(n['y']-A['y'])*dy)/L2)); px_,py_=A['x']+t*dx,A['y']+t*dy
            d=math.hypot(n['x']-px_,n['y']-py_)
            if d<3.0: cands.append((d,i,t,px_,py_))
        for d,i,t,px_,py_ in sorted(cands)[:3]:
            e=E[i]
            tgt=e['a'] if t<0.5 else e['b']
            if gd(adj,n['id'],tgt,2*d+6)<=2*d+6+math.hypot(px_-N[tgt]['x'],py_-N[tgt]['y']): continue
            if not los((n['x'],n['y']),(px_,py_)): continue
            # split edge i
            c[0]+=1; mid='3-C%03d'%c[0]
            N[mid]=dict(id=mid,floor='3',x=round(px_,2),y=round(py_,2),type='corridor'); g['nodes'].append(N[mid])
            a,b=e['a'],e['b']; E[i]=dict(a=a,b=mid,length=round(math.hypot(N[a]['x']-px_,N[a]['y']-py_),2),kind='corridor')
            E.append(dict(a=mid,b=b,length=round(math.hypot(N[b]['x']-px_,N[b]['y']-py_),2),kind='corridor'))
            E.append(dict(a=n['id'],b=mid,length=round(d,2),kind='corridor'))
            added+=1; adj=build(); break
print('bridges added',added)
json.dump(g,open('floor3.graph.json','w'),indent=1)
