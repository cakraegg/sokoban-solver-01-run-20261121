import{readFileSync,mkdirSync,writeFileSync}from'node:fs'
const I=process.env.MAKEFUN_INPUT_DIR??'/input',O=process.env.MAKEFUN_OUTPUT_DIR??'/output'
function S(L){
const g=L.split('\n').filter(r=>r),W=Math.max(...g.map(r=>r.length)),V=[[1,'r'],[-1,'l'],[W,'d'],[-W,'u']]
let P=0,B=[],G=new Set,ALL=new Set
g.forEach((r,y)=>{for(let x=0;x<r.length;x++){const c=r[x],p=y*W+x
if(c!=='#')ALL.add(p)
if(c==='@')P=p
if(c==='$'||c==='*')B.push(p)
if(c==='.'||c==='*')G.add(p)}})
const F=p=>ALL.has(p),hy=P/W|0
function rc(s,blk,ok){
const par=new Map([[s,-1]]),ch=new Map,q=[s]
for(let h=0;h<q.length;h++){const p=q[h]
for(let i=0;i<4;i++){const n=p+V[i][0]
if(!par.has(n)&&ok.has(n)&&!blk.has(n)){par.set(n,p);ch.set(n,V[i][1]);q.push(n)}}}
return[par,ch]}
function pt(R,t){
const par=R[0],ch=R[1]
if(!par.has(t))return null
let r='',p=t;while(par.get(p)!==-1){r=ch.get(p)+r;p=par.get(p)}return r}
const seen=new Set,rooms=[]
for(const p of ALL){const y=p/W|0
if(y===hy||seen.has(p))continue
const comp=[],q=[p];seen.add(p)
for(let h=0;h<q.length;h++){const c=q[h];comp.push(c)
for(let i=0;i<4;i++){const n=c+V[i][0];if(!seen.has(n)&&ALL.has(n)&&(n/W|0)!==hy){seen.add(n);q.push(n)}}}
const bs=B.filter(b=>comp.includes(b))
if(bs.length){let door=0
for(const c of comp)for(let i=0;i<4;i++){const n=c+V[i][0];if((n/W|0)===hy&&ALL.has(n))door=n}
rooms.push({c:comp,d:door,b:bs})}}
function rm(r){
const cells=new Set(r.c);cells.add(r.d)
for(let x=0;x<W;x++){const p=hy*W+x;if(ALL.has(p))cells.add(p)}
const rc2=new Set(r.c);rc2.add(r.d)
const dist=new Map([...G].map(x=>[x,0])),q=[...G]
for(let h=0;h<q.length;h++){const p=q[h]
for(let i=0;i<4;i++){const n=p+V[i][0];if(cells.has(n)&&!dist.has(n)){dist.set(n,dist.get(p)+1);q.push(n)}}}
const H=b=>b.reduce((s,x)=>s+(dist.get(x)??99),0)
const st={b:r.b,p:r.d,g:0,f:H(r.b),s:''}
const Q=[st],best=new Map([[r.b.join()+'|'+r.d,0]])
while(Q.length){
Q.sort((a,b)=>b.f-a.f)
const n=Q.pop(),k=n.b.join()+'|'+n.p
if(n.g>best.get(k))continue
if(n.b.every(x=>G.has(x)))return n
const blk=new Set(n.b),R=rc(n.p,blk,cells)
for(const b of n.b)for(let i=0;i<4;i++){
const np=b+V[i][0],bh=b-V[i][0]
if(!rc2.has(np)||blk.has(np)||dist.get(np)===undefined)continue
if(!G.has(np)&&(!F(np-1)||!F(np+1))&&(!F(np-W)||!F(np+W)))continue
const w=pt(R,bh)
if(w===null)continue
const nb=[...n.b];nb[nb.indexOf(b)]=np;nb.sort((a,b)=>a-b)
const k2=nb.join()+'|'+b
if((best.get(k2)??1e9)>n.g+1){best.set(k2,n.g+1);Q.push({b:nb,p:b,g:n.g+1,f:n.g+1+H(nb),s:n.s+w+V[i][1]})}}}
return null}
let out='',pl=P,boxes=[...B]
for(const r of rooms){
const w=pt(rc(pl,new Set(boxes),ALL),r.d)
if(w===null)return ''
out+=w;pl=r.d
const n=rm(r)
if(!n)return ''
out+=n.s;pl=n.p
boxes=boxes.filter(x=>!r.b.includes(x)).concat(n.b)}
return out}
for(let k=1;k<6;k++){const id='i00'+k
const m=S(readFileSync(I+'/'+id+'/level.txt','utf8'))
mkdirSync(O+'/'+id,{recursive:true})
writeFileSync(O+'/'+id+'/solution.txt',m+'\n')}
