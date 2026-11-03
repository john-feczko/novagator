from load import *
blk=raster([W,D],th=3)
free=(blk==0).astype(np.uint8)
n,lab=cv2.connectedComponents(free,connectivity=4)
area=np.bincount(lab.ravel())*RES*RES
border=set(np.unique(np.concatenate([lab[0],lab[-1],lab[:,0],lab[:,-1]])))
def labat(x,y):
    c,r=px(x,y); c=int(round(c)); r=int(round(r))
    if free[r,c]: return lab[r,c]
    for k in range(1,15):
        win=lab[r-k:r+k+1,c-k:c+k+1]; fw=free[r-k:r+k+1,c-k:c+k+1]
        v=win[fw>0]
        if len(v): return np.bincount(v).argmax()
    return 0
seed={}
for R in ROOMS: seed.setdefault(labat(R['x'],R['y']),[]).append(R['room'])
for L in LMS: seed.setdefault(labat(L['x'],L['y']),[]).append(L['no'])
