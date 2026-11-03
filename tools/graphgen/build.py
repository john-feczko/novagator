from regions import *
import pickle, json, math
from collections import defaultdict
doors=pickle.load(open('doors.pkl','rb'))
doors=[d for d in doors if area[d['a']]>0.4 and area[d['b']]>0.4 and 1 not in (d['a'],d['b'])]
# ---------- region roles
roomreg={}                       # region -> [room numbers]
for R in ROOMS:
    roomreg.setdefault(labat(R['x'],R['y']),[]).append(R['room'])
for Lm in LMS:
    if Lm['type']=='restroom': roomreg.setdefault(labat(Lm['x'],Lm['y']),[]).append(Lm['no'])
degree=defaultdict(int)
for d in doors: degree[d['a']]+=1; degree[d['b']]+=1
HUB={42,146}
for k in range(2,n):
    if k not in roomreg and area[k]>3 and degree[k]>=2: HUB.add(k)
# rooms whose label landed inside a hub (closets drawn without their own walls etc.)
inhub={k:v for k,v in roomreg.items() if k in HUB}
for k in inhub: del roomreg[k]
# ---------- skeleton of hubs at 0.1 m
F=2  # downsample factor (0.05->0.1 m)
def thin(img):
    img=img.copy().astype(np.uint8)
    while True:
        changed=False
        for it in (0,1):
            P=np.pad(img,1)
            p2,p3,p4,p5,p6,p7,p8,p9=(P[:-2,1:-1],P[:-2,2:],P[1:-1,2:],P[2:,2:],P[2:,1:-1],P[2:,:-2],P[1:-1,:-2],P[:-2,:-2])
            B=p2+p3+p4+p5+p6+p7+p8+p9
            seq=[p2,p3,p4,p5,p6,p7,p8,p9,p2]
            A=sum(((seq[i]==0)&(seq[i+1]==1)).astype(np.uint8) for i in range(8))
            if it==0: c=(p2*p4*p6==0)&(p4*p6*p8==0)
            else: c=(p2*p4*p8==0)&(p2*p6*p8==0)
            m=(img==1)&(B>=2)&(B<=6)&(A==1)&c
            if m.any(): img[m]=0; changed=True
        if not changed: return img
hubmask=np.isin(lab,list(HUB))
hm=cv2.resize(hubmask.astype(np.uint8),(NX//F,NY//F),interpolation=cv2.INTER_NEAREST)
hl=cv2.resize(lab.astype(np.int32).astype(np.float32),(NX//F,NY//F),interpolation=cv2.INTER_NEAREST).astype(int)
# smooth: open with 0.5 m disk removes door alcoves/jogs
ker=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5))
hm=cv2.morphologyEx(hm,cv2.MORPH_OPEN,ker)
sk=thin(hm)
RS=RES*F
def w(c,r): return (X0+(c+0.5)*RS, Y1-(r+0.5)*RS)
# ---------- trace skeleton to graph
ys,xs=np.nonzero(sk); S=set(zip(ys,xs))
def nb(p):
    r,c=p
    return [(r+dr,c+dc) for dr in(-1,0,1) for dc in(-1,0,1) if (dr or dc) and (r+dr,c+dc) in S]
deg={p:len(nb(p)) for p in S}
nodespx={p for p in S if deg[p]!=2}
# cluster adjacent node pixels
edges=[];visited=set()
for s in nodespx:
    for q in nb(s):
        if (s,q) in visited: continue
        path=[s,q]; visited.add((s,q)); prev,cur=s,q
        while cur not in nodespx:
            nx_=[t for t in nb(cur) if t!=prev and t not in path[-3:]]
            if not nx_: break
            prev,cur=cur,nx_[0]; path.append(cur)
        visited.add((path[-1],path[-2]))
        edges.append(path)
# isolated loops (no node pixels) ignored
def plen(path): return sum(math.hypot(path[i+1][0]-path[i][0],path[i+1][1]-path[i][1]) for i in range(len(path)-1))*RS
# prune spurs < 1.2 m repeatedly
for _ in range(4):
    cnt=defaultdict(int)
    for e in edges: cnt[e[0]]+=1; cnt[e[-1]]+=1
    keep=[]
    for e in edges:
        spur=(cnt[e[0]]==1 or cnt[e[-1]]==1) and not(cnt[e[0]]==1 and cnt[e[-1]]==1)
        if spur and plen(e)<1.2: continue
        if e[0]==e[-1] and len(e)<4: continue
        keep.append(e)
    edges=keep
# merge degree-2 junctions after pruning
def merge(edges):
    while True:
        cnt=defaultdict(list)
        for i,e in enumerate(edges): cnt[e[0]].append(i); cnt[e[-1]].append(i)
        done=True
        for p,ids in cnt.items():
            if len(ids)==2 and ids[0]!=ids[1]:
                a,b=edges[ids[0]],edges[ids[1]]
                if a[-1]!=p: a=a[::-1]
                if b[0]!=p: b=b[::-1]
                newe=a+b[1:]
                edges=[e for i,e in enumerate(edges) if i not in ids]+[newe]; done=False; break
        if done: return edges
edges=merge(edges)
# cluster junction pixels within 0.4 m into one node
ends=sorted({e[0] for e in edges}|{e[-1] for e in edges})
rep={}
for p in ends:
    for q in list(rep.values()):
        if math.hypot(p[0]-q[0],p[1]-q[1])*RS<0.4: rep[p]=q; break
    else: rep[p]=p
# RDP simplification
def rdp(pts,eps):
    if len(pts)<3: return pts
    a,b=np.array(pts[0],float),np.array(pts[-1],float); P=np.array(pts,float)
    d=b-a; L=np.hypot(*d)
    dist=np.abs(np.cross(d,P-a))/L if L>0 else np.hypot(*(P-a).T)
    i=int(np.argmax(dist))
    if dist[i]>eps: return rdp(pts[:i+1],eps)[:-1]+rdp(pts[i:],eps)
    return [pts[0],pts[-1]]
G_nodes={}; G_edges=[]
def addnode(xy,typ,**kw):
    nid='3-%s-%d'%(typ[0].upper(),len(G_nodes))
    G_nodes[nid]=dict(id=nid,floor='3',x=round(float(xy[0]),2),y=round(float(xy[1]),2),type=typ,**kw); return nid
pxnode={}
def nodeat(p):
    p=rep[p]
    if p not in pxnode: pxnode[p]=addnode(w(p[1],p[0]),'junction',region=int(hl[p]))
    return pxnode[p]
for e in edges:
    e=[rep.get(e[0],e[0])]+e[1:-1]+[rep.get(e[-1],e[-1])]
    pts=rdp(e,0.25/RS)
    ids=[nodeat(pts[0])]
    for p in pts[1:-1]: ids.append(addnode(w(p[1],p[0]),'corridor',region=int(hl[p])))
    ids.append(nodeat(pts[-1]))
    for a,b in zip(ids,ids[1:]):
        if a!=b: G_edges.append([a,b,'corridor'])
pickle.dump(dict(G_nodes=G_nodes,G_edges=G_edges,HUB=HUB,roomreg=roomreg,inhub=inhub,doors=doors),open('stage1.pkl','wb'))
from collections import Counter
print('hubs',sorted((k,round(area[k])) for k in HUB)); print('in-hub rooms',inhub)
print('nodes',Counter(v['type'] for v in G_nodes.values()),'edges',len(G_edges))
