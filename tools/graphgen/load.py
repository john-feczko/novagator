import re, numpy as np, cv2, json
from openpyxl import load_workbook
import os
FP=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','private','floorplans')
s=open(FP+'/Drosdick_3_floor.svg').read()
def segs(g):
    m=re.search(r'<g id="%s"[^>]*>(.*?)</g>'%g,s,re.S)
    out=[]
    for d in re.findall(r'd="([^"]*)"',m.group(1)):
        toks=re.findall(r'([ML])\s*(-?[\d.]+),(-?[\d.]+)',d)
        prev=None
        for c,x,y in toks:
            p=(float(x),float(y))
            if c=='L' and prev: out.append((prev,p))
            prev=p
    return np.array(out)
W=segs('walls'); D=segs('doors'); DET=segs('detail')
RES=0.05; X0,Y0,X1,Y1=-50.7,-21.0,58.3,41.9
NX=int((X1-X0)/RES)+1; NY=int((Y1-Y0)/RES)+1
def px(x,y): return ((np.asarray(x)-X0)/RES, (Y1-np.asarray(y))/RES)
def w2(c,r): return X0+c*RES, Y1-r*RES
def raster(arrs,th=2):
    im=np.zeros((NY,NX),np.uint8)
    for A in arrs:
        for (a,b) in A:
            c0,r0=px(*a); c1,r1=px(*b)
            cv2.line(im,(int(round(c0)),int(round(r0))),(int(round(c1)),int(round(r1))),255,th)
    return im
wb=load_workbook(FP+'/Novagator_Phase1_Field_Log_v3.xlsx')
ROOMS=[dict(id=r[0],room=r[2],name=r[3],via=r[4],note=r[5],x=r[6],y=r[7]) for r in wb['Plaques'].iter_rows(min_row=2,values_only=True) if r[1]=='3']
LMS=[dict(id=r[0],type=r[2],label=r[3],no=r[4],serves=r[5],x=r[6],y=r[7]) for r in wb['Landmarks'].iter_rows(min_row=2,values_only=True) if r[1]=='3']
