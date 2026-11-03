import pickle,math,json,datetime
from collections import defaultdict,Counter
st=pickle.load(open('stage2.pkl','rb')); N,E,flags=st['G_nodes'],st['G_edges'],st['flags']
E=[list(e) for e in E if e[0]!=e[1]]
# dedupe
seen=set(); E2=[]
for a,b,k in E:
    key=tuple(sorted((a,b)))
    if key in seen: continue
    seen.add(key); E2.append([a,b,k])
E=E2
def L(a,b): return math.hypot(N[a]['x']-N[b]['x'],N[a]['y']-N[b]['y'])
# contract very short corridor edges
changed=True
while changed:
    changed=False
    for i,(a,b,k) in enumerate(E):
        if k=='corridor' and L(a,b)<0.35 and N[a]['type'] in('junction','corridor') and N[b]['type'] in('junction','corridor'):
            # merge b into a
            E=[[a if x==b else x, a if y==b else y, kk] for x,y,kk in E]
            E=[e for e in E if e[0]!=e[1]]; changed=True; break
seen=set(); E=[e for e in E if not (tuple(sorted(e[:2])) in seen or seen.add(tuple(sorted(e[:2]))))]
# remove degree-2 pass-through corridor nodes that are straight and carry nothing
while True:
    adj=defaultdict(list)
    for i,(a,b,k) in enumerate(E): adj[a].append(i); adj[b].append(i)
    rm=None
    for n,ids in adj.items():
        if N[n]['type'] not in('junction','corridor') or len(ids)!=2: continue
        e1,e2=E[ids[0]],E[ids[1]]
        if e1[2]!='corridor' or e2[2]!='corridor': continue
        p=e1[0] if e1[1]==n else e1[1]; q=e2[0] if e2[1]==n else e2[1]
        if p==q: continue
        v1=(N[n]['x']-N[p]['x'],N[n]['y']-N[p]['y']); v2=(N[q]['x']-N[n]['x'],N[q]['y']-N[n]['y'])
        ang=abs(math.degrees(math.atan2(v1[0]*v2[1]-v1[1]*v2[0],v1[0]*v2[0]+v1[1]*v2[1])))
        if ang<12: rm=(n,ids,p,q); break
    if not rm: break
    n,ids,p,q=rm
    E=[e for i,e in enumerate(E) if i not in ids]+[[p,q,'corridor']]
used={x for e in E for x in e[:2]}
# renumber nodes in a readable way
order=sorted(used,key=lambda n:(['room','restroom','door','elevator','stairs','space','junction','corridor'].index(N[n]['type']),N[n].get('room') or '',N[n]['x'],N[n]['y']))
pref={'room':'R','restroom':'R','door':'D','elevator':'E','stairs':'S','space':'P','junction':'C','corridor':'C'}
newid={};c=Counter()
for n in order:
    t=N[n]['type']
    if t in('room','restroom'): newid[n]='3-R%s'%N[n]['room']
    elif t in('elevator','stairs'): newid[n]='3-%s'%N[n]['landmark']
    else: c[pref[t]]+=1; newid[n]='3-%s%03d'%(pref[t],c[pref[t]])
nodes=[]
for n in order:
    v=N[n]; t=v['type']
    o=dict(id=newid[n],floor='3',x=v['x'],y=v['y'],type='corridor' if t=='junction' else t)
    if t in('room','restroom'): o.update(room=v['room'],name=v['name'])
    if t=='door': o['rooms']=sorted(set(v.get('rooms',[])))
    if t in('elevator','stairs'): o.update(name=v['name'],serves=v.get('serves'))
    if v.get('inferred'): o['inferred']=True
    nodes.append(o)
KIND={'corridor':'corridor','door':'doorway','room':'room','inferred':'room','landmark':'doorway'}
edges=[]
for a,b,k in E:
    e=dict(a=newid[a],b=newid[b],length=round(L(a,b),2),kind=KIND[k])
    if k=='inferred' or N[a].get('inferred') or N[b].get('inferred'): e['inferred']=True
    if N[a]['type']=='stairs' or N[b]['type']=='stairs': e['stairs']=True
    edges.append(e)
rooms={}
for o in nodes:
    if o['type'] in('room','restroom'): rooms[o['room']]=dict(node=o['id'],name=o['name'],floor='3')
pois=[dict(node=o['id'],type=o['type'],name=o['name']) for o in nodes if o['type'] in('elevator','stairs','restroom')]
out=dict(version=1,building='Drosdick Hall',generated=datetime.date.today().isoformat(),
  units='meters',frame='x right, y up on the plan sheet; origin = Stair 1 inner corner (same on every floor)',
  floors=['3'],nodes=nodes,edges=edges,rooms=rooms,pois=pois,todo=flags)
json.dump(out,open('floor3.graph.json','w'),indent=1)
print(Counter(o['type'] for o in nodes),len(edges),'kb',len(json.dumps(out))//1024)
