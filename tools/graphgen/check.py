import pickle,math,sys
from collections import defaultdict,Counter
st=pickle.load(open(sys.argv[1],'rb')); N,E=st['G_nodes'],st['G_edges']
adj=defaultdict(set)
for a,b,k in E: adj[a].add(b); adj[b].add(a)
comps=[];seen=set()
for s in N:
    if s in seen or not adj[s]: continue
    c=[];q=[s];seen.add(s)
    while q:
        u=q.pop();c.append(u)
        for v in adj[u]:
            if v not in seen: seen.add(v);q.append(v)
    comps.append(c)
comps.sort(key=len,reverse=True)
print('components',[len(c) for c in comps[:15]],'isolated',sum(1 for n in N if not adj[n]))
main=set(comps[0])
for c in comps[1:]:
    rooms=[N[n].get('room') or N[n].get('landmark') for n in c if N[n].get('room') or N[n].get('landmark')]
    if rooms: print('  cut off:',rooms, 'near', N[c[0]]['x'],N[c[0]]['y'])
print('rooms unreachable:',[N[n]['room'] for n in N if N[n]['type'] in('room','restroom') and n not in main])
