from regions import *
import pickle, json, math
from collections import defaultdict, Counter
st=pickle.load(open('stage1.pkl','rb'))
N,E,HUB,roomreg,inhub,doors=st['G_nodes'],st['G_edges'],st['HUB'],st['roomreg'],st['inhub'],st['doors']
flags=[]
skel_regions={N[a].get('region') for a,b,k in E}|{N[b].get('region') for a,b,k in E}
HUB={h for h in HUB if h in skel_regions}
cnt=[len(N)]
def addnode(x,y,typ,**kw):
    nid='3-%s%d'%({'junction':'J','corridor':'C','door':'D','room':'R','space':'P','elevator':'E','stairs':'S','restroom':'R'}[typ],cnt[0]); cnt[0]+=1
    N[nid]=dict(id=nid,floor='3',x=round(float(x),2),y=round(float(y),2),type=typ,**kw); return nid
def d2(a,b): return math.hypot(a[0]-b[0],a[1]-b[1])
# corridor edges by region
ALLOW=None
def nearest_on_corridor(x,y,region=None,maxd=6.0):
    best=None
    for i,(a,b,k) in enumerate(E):
        if k!='corridor': continue
        if ALLOW is not None and a not in ALLOW: continue
        A,B=N[a],N[b]
        if region is not None and N[a].get('region')!=region and N[b].get('region')!=region: continue
        ax,ay,bx,by=A['x'],A['y'],B['x'],B['y']; dx,dy=bx-ax,by-ay; L2=dx*dx+dy*dy
        t=0 if L2==0 else max(0,min(1,((x-ax)*dx+(y-ay)*dy)/L2))
        px_,py_=ax+t*dx,ay+t*dy; d=math.hypot(x-px_,y-py_)
        if d<=maxd and (best is None or d<best[0]): best=(d,i,t,px_,py_)
    return best
def attach(x,y,region=None,maxd=6.0):
    b=nearest_on_corridor(x,y,region,maxd)
    if b is None: return None
    d,i,t,px_,py_=b; a,bn,k=E[i]
    if d2((px_,py_),(N[a]['x'],N[a]['y']))<0.4: return a
    if d2((px_,py_),(N[bn]['x'],N[bn]['y']))<0.4: return bn
    m=addnode(px_,py_,'corridor',region=N[a].get('region'))
    E[i]=[a,m,'corridor']; E.append([m,bn,'corridor']); return m
# room nodes
rname={R['room']:R for R in ROOMS}; lm={L['no']:L for L in LMS}
roomnode={}
def mkroom(num,x,y,kind='room',**kw):
    nm=rname[num]['name'] if num in rname else lm[num]['label']
    typ='restroom' if (num in lm and lm[num]['type']=='restroom') else 'room'
    roomnode[num]=addnode(x,y,typ,room=num,name=nm,**kw); return roomnode[num]
for k,rooms in roomreg.items():
    for r in rooms:
        src=rname.get(r) or lm[r]; mkroom(r,src['x'],src['y'],region=int(k))
# space nodes for unknown non-hub regions with doors
spacenode={}
def regnode(k):
    if k in roomreg: return [roomnode[r] for r in roomreg[k]]
    if k not in spacenode:
        ys,xs=np.nonzero(lab==k); cx,cy=w2(xs.mean(),ys.mean())
        spacenode[k]=addnode(cx,cy,'space',region=int(k),area=round(float(area[k]),1))
    return [spacenode[k]]
# doors
doorids=[]
for dd in doors:
    did=addnode(dd['x'],dd['y'],'door',regions=[dd['a'],dd['b']])
    doorids.append(did); rooms_served=[]
    for k in (dd['a'],dd['b']):
        if k in HUB:
            m=attach(dd['x'],dd['y'],region=k,maxd=4.0 if area[k]<150 else 10.0) or attach(dd['x'],dd['y'],maxd=3.0)
            if m: E.append([did,m,'door'])
            else: flags.append('door %s could not reach corridor of region %d'%(did,k))
        else:
            for t in regnode(k):
                E.append([did,t,'room'])
                if N[t].get('room'): rooms_served.append(N[t]['room'])
    N[did]['rooms']=rooms_served
# rooms whose label lands in a hub
for k,rooms in inhub.items():
    for r in rooms:
        R=rname[r]; rn=mkroom(r,R['x'],R['y'],inferred=True)
        m=attach(R['x'],R['y'],region=k); E.append([rn,m,'inferred']); flags.append('room %s: no walls of its own on plan; linked straight to corridor'%r)
# landmarks: elevators, stairs
for L in LMS:
    if L['type'] in ('elevator','stairs'):
        nid=addnode(L['x'],L['y'],'elevator' if L['type']=='elevator' else 'stairs',landmark=L['no'],name=L['label'],serves=L['serves'])
        b=nearest_on_corridor(L['x'],L['y'],maxd=15.0)
        m=attach(L['x'],L['y'],maxd=15.0); E.append([nid,m,'landmark'])
        if b and b[0]>2.5: N[nid]['inferred']=True; flags.append('%s (%s): entrance not found on plan; linked to the nearest corridor %.1f m away'%(L['label'],L['no'],b[0]))
# rooms with no door: link to nearest hub pixel
hubmask=np.isin(lab,list(HUB))
dist,lbl=cv2.distanceTransformWithLabels((~hubmask).astype(np.uint8),cv2.DIST_L2,5,labelType=cv2.DIST_LABEL_PIXEL)
hy,hx=np.nonzero(hubmask); idx2pix={}
# map label->pixel
lp=lbl[hy,hx]; pix={int(l):(int(y),int(x)) for l,y,x in zip(lp,hy,hx)}
def has_edge(n): return any(n in (a,b) for a,b,k in E)
for num,rn in sorted(roomnode.items(),key=lambda kv:(len(kv[0]),kv[0])):
    if has_edge(rn): continue
    via=(rname.get(num) or {}).get('via'); base=num.rstrip('ABCDEFGHI')
    par=via if via in roomnode and has_edge(roomnode[via]) else (base if base!=num and base in roomnode else None)
    if par:
        E.append([rn,roomnode[par],'inferred']); flags.append('room %s: no door found on plan; assumed it is entered through %s'%(num,par)); continue
    k=N[rn].get('region')
    ys,xs=np.nonzero(lab==k)
    j=np.argmin(dist[ys,xs]); y,x=ys[j],xs[j]; hyx=pix[int(lbl[y,x])]
    gx,gy=w2(hyx[1],hyx[0]); ex,ey=w2(x,y)
    did=addnode((gx+ex)/2,(gy+ey)/2,'door',rooms=[num],inferred=True)
    E.append([did,rn,'room']); m=attach(gx,gy,region=int(lab[hyx]),maxd=4.0) or attach(gx,gy,maxd=6)
    E.append([did,m,'door']); flags.append('room %s: no door found on plan; guessed a door at (%.1f, %.1f) toward %s'%(num,(gx+ex)/2,(gy+ey)/2,'corridor'))
E[:]=[e for e in E if e[0] is not None and e[1] is not None]
# ---- reconnect cut-off pieces through a guessed door to the nearest corridor
def components():
    adj=defaultdict(set)
    for a,b,k in E: adj[a].add(b); adj[b].add(a)
    seen=set(); out=[]
    for s0 in N:
        if s0 in seen or not adj[s0]: continue
        c=[];q=[s0];seen.add(s0)
        while q:
            u=q.pop();c.append(u)
            for v in adj[u]:
                if v not in seen: seen.add(v);q.append(v)
        out.append(c)
    return sorted(out,key=len,reverse=True)
for _ in range(20):
    cs=components()
    cut=[c for c in cs[1:] if any(N[n]['type'] in('room','restroom','space') for n in c)]
    if not cut: break
    c=cut[0]; ALLOW=set(cs[0])
    # 1) corridor piece separated by a narrow spot: bridge it directly
    cn=[n for n in c if N[n]['type'] in('junction','corridor')]
    bb=None
    for n in cn:
        r=nearest_on_corridor(N[n]['x'],N[n]['y'],maxd=3.0)
        if r and (bb is None or r[0]<bb[0]): bb=(r[0],n)
    if bb:
        m=attach(N[bb[1]]['x'],N[bb[1]]['y'],maxd=3.0); E.append([bb[1],m,'corridor']); ALLOW=None; continue
    regs=[N[n]['region'] for n in c if N[n]['type'] in('room','restroom','space') and N[n].get('region') is not None]
    best=None
    for k in set(regs):
        ys,xs=np.nonzero(lab==k)
        if not len(ys): continue
        j=np.argmin(dist[ys,xs])
        if best is None or dist[ys[j],xs[j]]<best[0]: best=(dist[ys[j],xs[j]],k,ys[j],xs[j])
    _,k,y,x=best; hyx=pix[int(lbl[y,x])]
    gx,gy=w2(hyx[1],hyx[0]); ex,ey=w2(x,y)
    tgt=[n for n in c if N[n].get('region')==k and N[n]['type'] in('room','restroom','space')][0]
    did=addnode((gx+ex)/2,(gy+ey)/2,'door',rooms=[N[t]['room'] for t in c if N[t].get('room') and N[t].get('region')==k],inferred=True)
    m=attach(gx,gy,region=int(lab[hyx]),maxd=6) or attach(gx,gy,maxd=8)
    E.append([did,tgt,'room']); E.append([did,m,'door']); ALLOW=None
    flags.append('rooms %s: no door to a corridor found on plan; guessed one at (%.1f, %.1f)'%(','.join(N[tgt].get('room') and [N[t]['room'] for t in c if N[t].get('room')] or [tgt]),(gx+ex)/2,(gy+ey)/2))
pickle.dump(dict(G_nodes=N,G_edges=E,HUB=HUB,flags=flags,roomnode=roomnode),open('stage2.pkl','wb'))
print(Counter(v['type'] for v in N.values()), len(E)); print('\n'.join(flags))
