from regions import *
WO=raster([W],th=3)
dooronly=(blk>0)&(WO==0)
L=lab.astype(np.float32); L[free==0]=0
k=np.ones((15,15),np.uint8)
mx=cv2.dilate(L,k)
Lm=L.copy(); Lm[Lm==0]=1e6
mn=-cv2.dilate(-Lm,k)
cand=dooronly&(mx>0)&(mn<1e6)&(mx!=mn)
# pixels can border >2 regions; record (mn,mx) pair
pairs={}
ys,xs=np.nonzero(cand)
pm=np.stack([mn[ys,xs].astype(int),mx[ys,xs].astype(int)],1)
doors=[]
for (a,b) in np.unique(pm,axis=0):
    sel=(pm[:,0]==a)&(pm[:,1]==b)
    m=np.zeros_like(blk); m[ys[sel],xs[sel]]=1
    m=cv2.dilate(m,np.ones((11,11),np.uint8))
    nn,cl,st,cen=cv2.connectedComponentsWithStats(m)
    for i in range(1,nn):
        cnt=int(((cl==i)[ys[sel],xs[sel]]).sum())
        if cnt<8: continue
        cx,cy=w2(*cen[i])
        doors.append(dict(a=int(a),b=int(b),x=float(cx),y=float(cy),n=cnt))
import pickle; pickle.dump(doors,open('doors.pkl','wb'))
print(len(doors))
from collections import Counter
print(Counter((d['a'],d['b']) for d in doors).most_common(10))
