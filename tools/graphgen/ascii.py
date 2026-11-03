from regions import *
import pickle,sys,math
st=pickle.load(open(sys.argv[1],'rb'))
Nn,E=st['G_nodes'],st['G_edges']
HUB=st.get('HUB',set())
x0,x1,y0,y1=[float(v) for v in sys.argv[2:6]] if len(sys.argv)>5 else (-50,58,-20,40)
s=float(sys.argv[6]) if len(sys.argv)>6 else 0.5
W_=int((x1-x0)/s); H_=int((y1-y0)/s)
g=[[' ']*W_ for _ in range(H_)]
def put(x,y,ch,force=False):
    c=int((x-x0)/s); r=int((y1-y)/s)
    if 0<=r<H_ and 0<=c<W_ and (force or g[r][c] in ' .#'): g[r][c]=ch
for r in range(H_):
    for c in range(W_):
        x=x0+(c+.5)*s; y=y1-(r+.5)*s
        cc,rr=px(x,y); cc=int(cc); rr=int(rr)
        if not(0<=rr<NY and 0<=cc<NX): continue
        if blk[rr-2:rr+3,cc-2:cc+3].mean()>100: g[r][c]='#'
        elif lab[rr,cc] in HUB: g[r][c]='.'
for a,b,k in E:
    A,B=Nn[a],Nn[b]; L=math.hypot(B['x']-A['x'],B['y']-A['y']); m=max(2,int(L/s*2))
    for i in range(m+1):
        t=i/m; put(A['x']+(B['x']-A['x'])*t,A['y']+(B['y']-A['y'])*t,{'corridor':'*','door':'+','room':'~','link':'='}.get(k,'*'))
sym={'junction':'o','corridor':'*','door':'D','room':'R','elevator':'E','stairs':'S','restroom':'R'}
for v in Nn.values(): put(v['x'],v['y'],sym.get(v['type'],'?'),True)
print('\n'.join(''.join(r).rstrip() for r in g))
