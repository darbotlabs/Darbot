#!/usr/bin/env python3
"""Rebuild the Mint/Opal identity assets from fixed source masks, never traced paths.

Run: python tools/build_assets.py --root . --workers 4
All material randomness is seeded. The full-size token alpha is copied byte for byte.
"""
from __future__ import annotations
import argparse, base64, colorsys, concurrent.futures as cf, hashlib, json, math
from io import BytesIO
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

SIZE=2048
BOX=(96,65,1952,1983)
CHEST=(768,984,1280,1513)
ANCHORS=[('nitrous-blue','Nitrous Blue','#00CFFF'),('cobalt-blue','Cobalt Blue','#0047AB'),('magenta','Magenta','#FF00D4'),('competition-orange','Competition Orange','#FF5A00'),('lava','Lava','#C51A0B'),('opal-lightning','Opal Lightning Splatter','#69CFC2'),('mint-green','Mint Green','#50E6C2'),('frost-white','Frost White','#F4FBFF')]

def sha(p:Path)->str: return hashlib.sha256(p.read_bytes()).hexdigest()
def rawsha(im:Image.Image)->str: return hashlib.sha256(im.tobytes()).hexdigest()
def rgb(h:str)->tuple[int,int,int]: return tuple(int(h[k:k+2],16)for k in(1,3,5))
def hx(c)->str:return '#'+''.join(f'{int(v):02X}'for v in c)
def srgb_to_lab(c):
    x=np.asarray(c,dtype=float)/255
    x=np.where(x<=.04045,x/12.92,((x+.055)/1.055)**2.4)
    lms=x@np.array([[.4122214708,.5363325363,.0514459929],[.2119034982,.6806995451,.1073969566],[.0883024619,.2817188376,.6299787005]]).T
    return np.cbrt(lms)@np.array([[.2104542553,.793617785,-.0040720468],[1.9779984951,-2.428592205,.4505937099],[.0259040371,.7827717662,-.808675766]]).T

def lab_to_srgb(lab):
    l,a,b=np.asarray(lab,dtype=float)
    lms=np.array([l+.3963377774*a+.2158037573*b,l-.1055613458*a-.0638541728*b,l-.0894841775*a-1.291485548*b])**3
    v=np.array([[4.0767416621,-3.3077115913,.2309699292],[-1.2684380046,2.6097574011,-.3413193965],[-.0041960863,-.7034186147,1.707614701]])@lms
    v=np.clip(v,0,1)
    return np.rint(255*np.where(v<=.0031308,12.92*v,1.055*np.power(v,1/2.4)-.055)).astype(np.uint8)

def xterm_table():
    # Fixed indexed colors only: 0..15 are user-theme controlled.
    levels=(0,95,135,175,215,255)
    d={16+36*r+6*g+b:(levels[r],levels[g],levels[b]) for r in range(6)for g in range(6)for b in range(6)}
    d.update({232+i:(8+10*i,)*3 for i in range(24)})
    assert d[51]==(0,255,255) and d[196]==(255,0,0) and d[46]==(0,255,0)
    return d

XT=xterm_table()
XTKEYS=list(XT)
XTLAB=srgb_to_lab(np.array(list(XT.values())))
def color_meta(c):
    c=tuple(map(int,c));h,l,s=colorsys.rgb_to_hls(*(v/255 for v in c))
    lab=srgb_to_lab(c)
    nearest=XTKEYS[int(np.argmin(np.sum((XTLAB-lab)**2,axis=1)))]
    # Validate HSL fields independently via the inverse transform.
    rt=tuple(int(round(x*255))for x in colorsys.hls_to_rgb(h,l,s));assert rt==c
    return dict(hex=hx(c),rgb=dict(zip(('r','g','b'),c)),argb_hex='#FF'+hx(c)[1:],hsl={'h':round(h*360,4),'s':round(s*100,4),'l':round(l*100,4)},oklab=list(map(float,lab)),terminal={'unicode_swatch':'■','codepoint':'U+25A0','ansi_foreground':f'\x1b[38;2;{c[0]};{c[1]};{c[2]}m','ansi_background':f'\x1b[48;2;{c[0]};{c[1]};{c[2]}m','reset':'\x1b[0m','xterm_256_index':nearest,'xterm_256_hex':hx(XT[nearest]),'xterm_distance_metric':'Euclidean OKLab; fixed entries 16..255 only'})

def palette():
    labs=[srgb_to_lab(rgb(a[2]))for a in ANCHORS]
    out=[]
    for i in range(64):
        segment=min(i//9,6);step=i-segment*9;t=step/9
        c=lab_to_srgb(labs[segment]*(1-t)+labs[segment+1]*t)
        if i%9==0:c=np.array(rgb(ANCHORS[i//9][2]),dtype=np.uint8)
        anchor=i//9 if i%9==0 else None
        # Material has its own identity. The fallback color is not the material.
        strength=max(0,1-abs((i+1)-46)/9)
        name=ANCHORS[anchor][1] if anchor is not None else f'{ANCHORS[segment][1]} / {ANCHORS[segment+1][1]} {step}/9'
        out.append(dict(index=i+1,palette_token=f'DSW-MO-P{i+1:02d}',name=name,anchor=ANCHORS[anchor][0] if anchor is not None else None,from_anchor=ANCHORS[segment][0],to_anchor=ANCHORS[segment+1][0],step=step,intervals=9,**color_meta(c),material={'kind':'opal-splatter' if strength>0 else 'solid','material_id':'darbot.opal-lightning-splatter.v1' if strength>0 else None,'strength':round(strength,8),'seed':640246 if strength>0 else None,'fallback_color_is_approximation':strength>0}))
    assert len({a['hex']for a in out})==64
    assert out[54]['hex']=='#50E6C2' and out[0]['hsl']['s']==100 and out[0]['hsl']['l']==50
    return out

def material(root:Path)->Image.Image:
    """Reference chroma + seeded mineral flakes. No shape pixels are generated here."""
    n=2048
    # The photo is a low-resolution color/texture reference, not a high-res scan.
    photo=Image.open(root/'source/opal_reference.png').convert('RGB')
    photo=ImageEnhance.Color(photo).enhance(1.55).resize((n,n),Image.Resampling.BICUBIC)
    photo=ImageEnhance.Contrast(photo).enhance(1.15)
    a=np.array(photo,dtype=np.float32)/255
    mx=a.max(axis=2,keepdims=True)
    chroma=a/np.maximum(mx,.12)
    # Retain photo color fields, lift dark regions, then weave mineral interference bands.
    base=.57*np.power(chroma,2.1)+.43*a
    yy,xx=np.mgrid[0:n,0:n].astype(np.float32);x=xx/n;y=yy/n
    phase=np.clip(.49+.31*np.sin(8*x-5*y)+.14*np.sin(17*x+6*y),0,1)
    stops=np.array([rgb(h)for h in['#00CFFF','#50E6C2','#5943EC','#EC25C2','#FF783D','#50E6C2']],dtype=np.float32)/255
    pos=phase*5;ix=np.minimum(pos.astype(int),4);f=(pos-ix)[...,None]
    band=stops[ix]*(1-f)+stops[ix+1]*f
    a=.78*base+.22*band
    out=Image.fromarray(np.uint8(np.clip(a*255,0,255)),'RGB')
    del a,base,band,chroma,phase,pos,ix,f,yy,xx,x,y,mx
    rng=np.random.default_rng(640246)
    flakes=Image.new('RGBA',(n,n));draw=ImageDraw.Draw(flakes)
    ink=['#00E4FF','#50E6C2','#C7FFEE','#5085FF','#F762DD','#FF955F','#F4FBFF']
    clusters=rng.uniform(0,n,size=(100,2))
    for k in range(4800):
        center=clusters[int(rng.integers(0,len(clusters)))];cx,cy=center+rng.normal(0,82,2)
        w=float(rng.uniform(1.2,8));h=w*rng.uniform(.25,1.1);theta=float(rng.uniform(-math.pi,math.pi))
        local=np.array([[-w,-h*.3],[w*.15,-h],[w,h*.25],[-w*.4,h]])
        rot=np.array([[math.cos(theta),-math.sin(theta)],[math.sin(theta),math.cos(theta)]])
        pts=local@rot.T+np.array([cx,cy])
        co=rgb(ink[int(rng.integers(0,len(ink)))]);alpha=int(rng.integers(70,220))
        draw.polygon([tuple(p)for p in pts],fill=(*co,alpha))
    # Fine diagonal flashes, without an external glow or altered contour.
    for k in range(110):
        cx,cy=rng.uniform(0,n,2);length=rng.uniform(12,54)
        draw.line([(cx,cy),(cx+length*.55,cy-length)],fill=(*rgb('#DDFFF7'),int(rng.integers(90,170))),width=int(rng.integers(1,4)))
    out=Image.alpha_composite(out.convert('RGBA'),flakes).convert('RGB')
    out.save(root/'materials/opal_lightning_splatter_2048.png')
    return out

def savepng(im,path):
    path.parent.mkdir(parents=True,exist_ok=True);im.save(path,compress_level=6)

def datauri(im):
    b=BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()

def rgba_fill(fill:Image.Image,alpha:Image.Image)->Image.Image:
    out=fill.convert('RGBA');out.putalpha(alpha);return out

class Builder:
    def __init__(self,root:Path):
        self.root=root
        self.alpha=Image.open(root/'source/token_original.png').getchannel('A')
        assert self.alpha.size==(2048,2048) and self.alpha.getbbox()==BOX
        self.line=Image.open(root/'source/outline_alpha_2048.png').convert('L')
        self.chest=self.alpha.crop(BOX).resize((512,529),Image.Resampling.LANCZOS)
        self.line.save(root/'qa/expected_outline_alpha.png')
        self.chest.save(root/'qa/expected_chest_alpha.png')
        old=np.array(Image.open(root/'source/previous_agent_nitrous.png').convert('RGB'))
        lm=np.array(self.line)>0
        old[lm]=0;old[980:1520,750:1290]=0
        self.static=Image.fromarray(old,'RGB')
        self.static.save(root/'source/visor_and_dots_static.png')
        self.staticmask=Image.fromarray(np.uint8(old.max(axis=2)>0)*255)
        self.staticrgba=rgba_fill(self.static,self.staticmask)
        self.texture=Image.open(root/'materials/opal_lightning_splatter_2048.png').convert('RGB') if (root/'materials/opal_lightning_splatter_2048.png').exists() else material(root)
        self.pal=palette()
        self.entries=json.loads((root/'manifest/roster.input.json').read_text())
        self.chestarr=np.array(self.chest)
        self.tokenarr=np.array(self.alpha)
        self.linearr=np.array(self.line)

    def render(self,a):
        p=self.pal[a['palette_index']-1];c=rgb(p['hex']);i=a['swarm_index'];aid=a['agent_id']
        stem=f'{i:03d}_{aid}'
        fill=Image.new('RGB',(SIZE,SIZE),c)
        if p['material']['strength']>0:
            fill=Image.blend(fill,self.texture,p['material']['strength'])
        tok=rgba_fill(fill,self.alpha)
        # Independent alpha and RGB resampling prevent colored edge halos.
        cf=fill.crop(BOX).resize((512,529),Image.Resampling.LANCZOS)
        ct=rgba_fill(cf,self.chest)
        chestlayer=Image.new('RGBA',(SIZE,SIZE));chestlayer.paste(ct,(768,984))
        line=rgba_fill(fill,self.line)
        ag=Image.alpha_composite(line,self.staticrgba)
        ag=Image.alpha_composite(ag,chestlayer)
        dark=Image.alpha_composite(Image.new('RGBA',(SIZE,SIZE),(0,0,0,255)),ag).convert('RGB')
        assets={}
        for n in (2048,1024,512,256):
            alpha=self.alpha if n==2048 else self.alpha.resize((n,n),Image.Resampling.LANCZOS)
            f=fill if n==2048 else fill.resize((n,n),Image.Resampling.LANCZOS)
            t=rgba_fill(f,alpha)
            path=f'tokens/png_{n}/{stem}.png';savepng(t,self.root/path);assets[f'token_{n}']=path
            if n in(2048,1024,512):
                d=dark if n==2048 else dark.resize((n,n),Image.Resampling.LANCZOS)
                path=f'agents/png_{n}_black/{stem}.png';savepng(d,self.root/path);assets[f'agent_{n}_black']=path
            if n in(1024,512,256):
                ap=ag.resize((n,n),Image.Resampling.LANCZOS)
                path=f'agents/png_{n}_transparent/{stem}.png';savepng(ap,self.root/path);assets[f'agent_{n}_transparent']=path
        # A wrapper is explicitly marked as raster-backed; no false vector claim.
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" viewBox="0 0 2048 2048" role="img" aria-label="{a["display_name"]} exact token"><title>{a["display_name"]} — raster-backed canonical-alpha token</title><image width="2048" height="2048" href="{datauri(tok)}"/></svg>'
        path=f'tokens/svg_raster_backed/{stem}.svg';(self.root/path).parent.mkdir(parents=True,exist_ok=True);(self.root/path).write_text(svg);assets['token_svg_raster_backed']=path
        # Verify actual saved files, not just the arrays passed to the encoder.
        saved=Image.open(self.root/assets['token_2048']).convert('RGBA')
        sa=np.array(saved.getchannel('A'));td=np.abs(sa.astype(int)-self.tokenarr.astype(int))
        savedag=np.array(Image.open(self.root/assets['agent_2048_black']).convert('RGB'))
        expectedch=np.array(Image.alpha_composite(Image.new('RGBA',ct.size,(0,0,0,255)),ct).convert('RGB'))
        chestdiff=np.abs(savedag[984:1513,768:1280].astype(int)-expectedch.astype(int))
        staticmask=np.array(self.staticmask)>0
        staticdiff=np.abs(savedag[staticmask].astype(int)-np.array(self.static)[staticmask].astype(int))
        opaque_rgb=np.array(saved.convert('RGB'))[self.tokenarr>0]
        solid_error=int(np.count_nonzero(np.any(opaque_rgb!=np.array(c),axis=1))) if p['material']['kind']=='solid' else None
        assert int(td.max())==0 and int(chestdiff.max())==0 and int(staticdiff.max())==0
        if solid_error is not None:assert solid_error==0
        q=dict(agent_id=aid,swarm_index=i,token_alpha_mismatch_pixels=int(np.count_nonzero(td)),token_alpha_max_delta=int(td.max()),chest_mismatch_pixels=int(np.count_nonzero(np.any(chestdiff>0,axis=2))),static_visor_dot_max_delta=int(staticdiff.max()),solid_rgb_mismatch_pixels=solid_error,token_2048_sha256=sha(self.root/assets['token_2048']),agent_2048_sha256=sha(self.root/assets['agent_2048_black']))
        a=dict(a,visual={'palette_token':p['palette_token'],'fallback_hex':p['hex'],'color':color_meta(c),'material':p['material']},assets=assets)
        return a,q

    def build(self,workers,limit=64):
        out=[]
        pending=[]
        state=self.root/'qa/entry_state';state.mkdir(exist_ok=True)
        for a in self.entries:
            cache=state/f'{a["swarm_index"]}.json'
            if cache.exists():out.append(tuple(json.loads(cache.read_text())))
            else:pending.append(a)
        with cf.ThreadPoolExecutor(max_workers=workers)as ex:
            fs={ex.submit(self.render,a):a for a in pending[:limit]}
            for fut in cf.as_completed(fs):
                a,q=fut.result();out.append((a,q));(state/f'{a["swarm_index"]}.json').write_text(json.dumps([a,q]));print(f'[{len(out):02}/64] {a["identity_code"]} {a["display_name"]}',flush=True)
        if len(out)<64:
            print(f'Checkpoint saved: {len(out)}/64 complete.',flush=True);return None
        out.sort(key=lambda v:v[0]['local_index'])
        manifest=dict(schema_id='darbot.swarm.mint-opal64.v3',version='3.0.0',title='Darbot Swarm — Mint / Opal Extension',cohort_id='mint-opal64',count=64,swarm_index_range=[65,128],previous_cohort_unchanged=True,asset_kind='brand-identity-assets-and-proposed-agent-perspectives',execution_note='These are persona definitions and visual assets, not instantiated or connected agent runtimes.',naming_policy='Mint + a distinct domain role noun. Requested machine IDs are retained verbatim.',material_note='Opal is a patterned material, not a single RGB color. Fallback hex values are used for schema keys and terminals; artwork retains the opal texture.',source_lock={'original_logo_sha256':sha(self.root/'source/darbot_original.png'),'token_master_sha256':sha(self.root/'source/token_original.png'),'token_alpha_raw_sha256':rawsha(self.alpha),'outline_alpha_raw_sha256':rawsha(self.line),'source_alpha_bbox':BOX,'chest_bbox':CHEST,'chest_alpha_raw_sha256':rawsha(self.chest),'token_alpha_policy':'2048 alpha copied exactly; no path approximation, redraw or morphology. Lower sizes use deterministic Lanczos alpha resampling.','outline_policy':'Mask recovered exactly from the previously accepted solid64 Nitrous avatar; opaque RGB and alpha recomposed without a new contour.','transparent_policy':'Outline + original opaque visor/dots + chest token; black negative-space body and external background remain transparent.','opal_reference_sha256':sha(self.root/'source/opal_reference.png')},palette_model={'anchor_indices':[1,10,19,28,37,46,55,64],'anchors':[dict(index=1+i*9,slug=s,name=n,fallback_hex=h,kind='material'if i==5 else 'solid')for i,(s,n,h)in enumerate(ANCHORS)],'interpolation':'OKLab for the fallback colors; seeded reference-derived material blends at indices 38..54.','opal_material_indices':list(range(38,55)),'requested_cohort_palette_indices':list(range(50,65)),'mint_anchor_hex':'#50E6C2','solid_count':47,'material_count':17,'unique_fallback_colors':64},palette=self.pal,agents=[v[0]for v in out])
        report=dict(version='3.0.0',variant_count=64,required_ids_preserved=[a['agent_id']for a in manifest['agents'][:15]],unique_semantic_ids=len(set(a['agent_id']for a in manifest['agents'])),unique_identity_codes=len(set(a['identity_code']for a in manifest['agents'])),unique_palette_colors=len(set(p['hex']for p in self.pal)),token_alpha_mismatch_pixels=sum(q['token_alpha_mismatch_pixels']for _,q in out),chest_mismatch_pixels=sum(q['chest_mismatch_pixels']for _,q in out),maximum_visor_dot_delta=max(q['static_visor_dot_max_delta']for _,q in out),solid_rgb_mismatch_pixels=sum(q['solid_rgb_mismatch_pixels']or 0 for _,q in out),hsl_rgb_roundtrip_pass=True,xterm_cube_index_tests_pass=True,validation_scope='Saved 2048 PNGs; exact canonical token alpha, expected placed chest render and preserved static visor/dots. No claim of full-image RGB equality, because recoloring/materials are intentional.',variants=[q for _,q in out])
        (self.root/'manifest/agent-perspectives.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf-8')
        (self.root/'qa/render-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        (self.root/'manifest/palette.json').write_text(json.dumps(self.pal,indent=2,ensure_ascii=False),encoding='utf-8')
        return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--workers',type=int,default=4);parser.add_argument('--limit',type=int,default=64);parser.add_argument('--rebuild',action='store_true',help='Discard checkpoints and regenerate the material after input changes.');args=parser.parse_args()
    if args.workers<1:parser.error('--workers must be positive')
    if args.rebuild:
        import shutil
        shutil.rmtree(args.root/'qa/entry_state',ignore_errors=True)
        (args.root/'materials/opal_lightning_splatter_2048.png').unlink(missing_ok=True)
    Builder(args.root.resolve()).build(args.workers,args.limit)
