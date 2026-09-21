#!/usr/bin/env python3
"""Publish sheets, bindings, offline gallery and schema for the completed render pack."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO
import base64, csv, hashlib, html, json, math, textwrap
import jsonschema

ROOT=Path(__file__).resolve().parents[1]
M=json.loads((ROOT/'manifest/agent-perspectives.json').read_text())
A=M['agents'];P=M['palette']
BG='#070D12';PANEL='#101A22';MINT='#50E6C2';TEXT='#F4FBFF';MUTED='#9CAEBB';LINE='#263640'

def font(n,bold=False,mono=False):
    options=([Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf')] if mono else [Path('/usr/share/fonts/opentype/inter/Inter-SemiBold.otf' if bold else '/usr/share/fonts/opentype/inter/Inter-Regular.otf'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')])
    for p in options:
        if p.exists():return ImageFont.truetype(str(p),n)
    return ImageFont.load_default(size=n)

def textfit(d,pos,text,maxw,size=28,fill=TEXT,bold=False,mono=False):
    f=font(size,bold,mono)
    while d.textlength(text,font=f)>maxw and size>12:
        size-=1;f=font(size,bold,mono)
    assert d.textlength(text,font=f)<=maxw
    d.text(pos,text,font=f,fill=fill)

def draw_header(im,title,subtitle,kicker='DARBOT LABS  /  SWARM IDENTITIES  /  SERIES 02'):
    d=ImageDraw.Draw(im);w=im.width
    d.rounded_rectangle((64,56,76,100),radius=4,fill=MINT)
    d.text((100,60),kicker,font=font(26,True),fill=MINT)
    textfit(d,(64,124),title,w-128,84,bold=True)
    textfit(d,(64,240),subtitle,w-128,31,fill=MUTED)
    d.line((64,308,w-64,308),fill=LINE,width=2)
    return d

def card(im,a,box,token=False):
    x,y,w,h=box;d=ImageDraw.Draw(im);p=P[a['palette_index']-1]
    d.rounded_rectangle((x,y,x+w,y+h),radius=18,fill=PANEL,outline=LINE,width=2)
    d.rounded_rectangle((x+20,y+18,x+101,y+57),radius=10,fill=p['hex'])
    # Choose legible text against each identity chip.
    c=tuple(int(p['hex'][k:k+2],16)/255 for k in(1,3,5));lum=sum(v*t for v,t in zip(c,(.2126,.7152,.0722)))
    d.text((x+33,y+21),str(a['swarm_index']),font=font(26,True),fill='#071014' if lum>.5 else TEXT)
    mode='OPAL / MINT' if p['material']['kind']=='opal-splatter' else p['hex']
    d.text((x+122,y+26),mode,font=font(20,mono=True),fill=MUTED)
    img=Image.open(ROOT/a['assets']['token_512' if token else 'agent_512_transparent']).convert('RGBA')
    # Compositing on true black avoids treating a new background as a logo fill.
    s=min(w-38,h-177);tile=Image.new('RGBA',(s,s),(0,0,0,255))
    tile=Image.alpha_composite(tile,img.resize((s,s),Image.Resampling.LANCZOS))
    im.paste(tile.convert('RGB'),(int(x+(w-s)/2),y+71))
    textfit(d,(x+21,y+h-101),a['display_name'],w-42,31,TEXT,True)
    textfit(d,(x+21,y+h-62),a['agent_id'],w-42,20,fill=MUTED,mono=True)
    textfit(d,(x+21,y+h-34),a['domain'],w-42,19,fill=MUTED)

def contact_sheets():
    w=4096;cols=8;gap=16;cw=482;ch=562;top=350;h=top+8*ch+7*gap+106
    for token in(False,True):
        im=Image.new('RGB',(w,h),BG)
        draw_header(im,'Mint / Opal — 64 agent perspectives' if not token else 'Mint / Opal — 64 canonical tokens','65–128  ·  15 requested framework / interaction identities  ·  49 domain specialists  ·  exact token alpha')
        for i,a in enumerate(A):card(im,a,(64+(i%8)*(cw+gap),top+(i//8)*(ch+gap),cw,ch),token)
        d=ImageDraw.Draw(im);d.text((64,h-60),'MINT #50E6C2  /  OPAL = MATERIAL + FALLBACK COLOR  /  NAMES AND IDs CARRY IDENTITY, NOT COLOR ALONE',font=font(24),fill=MUTED)
        path=ROOT/'contact_sheets'/('all_64_tokens.png' if token else 'all_64_agents.png');im.save(path)
        if not token:
            im.resize((1600,round(h*1600/w)),Image.Resampling.LANCZOS).save(ROOT/'contact_sheets/all_64_agents_preview.jpg',quality=92)
    w=2656;cw=492;ch=594;cols=5;gap=16;top=350;h=top+3*ch+2*gap+100
    im=Image.new('RGB',(w,h),BG)
    draw_header(im,'The Mint framework cohort','All 15 requested machine IDs retained verbatim. Mint names are Darbot aliases, not vendor branding.')
    for i,a in enumerate(A[:15]):card(im,a,(64+(i%5)*(cw+gap),top+(i//5)*(ch+gap),cw,ch))
    ImageDraw.Draw(im).text((64,h-58),'MINT SEED  /  MINT COUNCIL  /  MINT GROVE  /  MINT RELAY  /  MINT FORGE  +  10 SPECIALISTS',font=font(22),fill=MUTED)
    im.save(ROOT/'contact_sheets/framework_cohort_15.png')
    # Compact eight-anchor material proof; helps inspect the opal at useful scale.
    w=3072;h=1340;im=Image.new('RGB',(w,h),BG)
    draw_header(im,'Mint precision. Opal energy.','A material change only: original contour, negative spaces and lightning-bolt geometry remain intact.')
    choices=[next(a for a in A if a['palette_index']==v)for v in(55,46,1)]
    names=['MINT GREEN  /  #50E6C2','OPAL LIGHTNING SPLATTER','NITROUS BLUE  /  #00CFFF']
    for i,(a,name)in enumerate(zip(choices,names)):
        x=64+i*1000
        t=Image.open(ROOT/a['assets']['token_1024']).convert('RGBA').resize((840,840),Image.Resampling.LANCZOS)
        im.paste(t,(x+55,350),t)
        ImageDraw.Draw(im).text((x+45,1230),name,font=font(30,True),fill=MINT if i==0 else TEXT)
    im.save(ROOT/'contact_sheets/mint_opal_material_proof.png')
    # Ordered palette samples remain distinct from the persona ordering.
    w=3072;cw=354;gap=16;top=350;ch=145;h=top+8*ch+7*gap+100
    im=Image.new('RGB',(w,h),BG);d=draw_header(im,'The 64-step Mint / Opal palette','Eight anchors · nine OKLab intervals per segment · 47 solid fills + 17 graded opal materials')
    texture=Image.open(ROOT/'materials/opal_lightning_splatter_2048.png').convert('RGB')
    for i,p in enumerate(P):
        x=64+(i%8)*(cw+gap);y=top+(i//8)*(ch+gap)
        sw=Image.new('RGB',(cw,78),p['hex'])
        if p['material']['strength']>0:sw=Image.blend(sw,texture.resize(sw.size),p['material']['strength'])
        im.paste(sw,(x,y));d.text((x,y+88),f'{p["palette_token"]}  {p["hex"]}',font=font(20,mono=True),fill=TEXT)
        d.text((x,y+118),'OPAL MATERIAL' if p['material']['strength'] else 'SOLID RGB',font=font(16),fill=MUTED)
    im.save(ROOT/'contact_sheets/palette_64.png')

def qa_sheet():
    im=Image.new('RGB',(3072,1280),BG);d=draw_header(im,'Shape fidelity — source versus exports','Compare alpha, not RGB. Color differences are intentional; token contour differences must be zero.')
    source=Image.open(ROOT/'source/token_original.png').convert('RGBA')
    mint=next(a for a in A if a['palette_index']==55);opal=next(a for a in A if a['palette_index']==46)
    assets=[source,Image.open(ROOT/mint['assets']['token_2048']),Image.open(ROOT/opal['assets']['token_2048'])]
    titles=['SUPPLIED MASTER','MINT FILL / SAME ALPHA','OPAL FILL / SAME ALPHA']
    for i,(a,title)in enumerate(zip(assets,titles)):
        a=a.convert('RGBA').resize((820,820),Image.Resampling.LANCZOS);im.paste(a,(120+i*1000,350),a)
        d.text((100+i*1000,1195),title,font=font(30,True),fill=MINT if i else TEXT)
    im.save(ROOT/'qa/source_comparison.png')

def write_schema():
    color={'type':'object','required':['hex','rgb','hsl','terminal'],'properties':{'hex':{'type':'string','pattern':'^#[0-9A-F]{6}$'},'rgb':{'type':'object','required':['r','g','b'],'properties':{k:{'type':'integer','minimum':0,'maximum':255}for k in('r','g','b')}},'hsl':{'type':'object','required':['h','s','l'],'properties':{'h':{'type':'number','minimum':0,'maximum':360},'s':{'type':'number','minimum':0,'maximum':100},'l':{'type':'number','minimum':0,'maximum':100}}}}}
    agent={'type':'object','required':['agent_id','display_name','swarm_index','identity_code','visual','assets'],'properties':{'agent_id':{'type':'string','pattern':'^agent-[a-z0-9]+(?:-[a-z0-9]+)*$'},'display_name':{'type':'string','pattern':'^Mint '},'swarm_index':{'type':'integer','minimum':65,'maximum':128},'identity_code':{'type':'string','pattern':'^DSW-MO-[0-9]{3}$'},'visual':{'type':'object','required':['palette_token','fallback_hex','color','material'],'properties':{'color':color,'material':{'type':'object','required':['kind','strength'],'properties':{'kind':{'enum':['solid','opal-splatter']},'strength':{'type':'number','minimum':0,'maximum':1}}}}},'assets':{'type':'object','required':['token_2048','token_1024','agent_2048_black','agent_1024_black']}}}
    s={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'urn:darbot:swarm:mint-opal64:v3','title':'Darbot Swarm Mint/Opal 64 Agent Perspective Registry','type':'object','required':['schema_id','version','count','source_lock','palette','agents'],'properties':{'schema_id':{'const':'darbot.swarm.mint-opal64.v3'},'version':{'const':'3.0.0'},'count':{'const':64},'palette':{'type':'array','minItems':64,'maxItems':64},'agents':{'type':'array','minItems':64,'maxItems':64,'items':agent,'allOf':[{'contains':{'type':'object','properties':{'agent_id':{'const':a['agent_id']}},'required':['agent_id']},'minContains':1,'maxContains':1}for a in A[:15]]}}}
    jsonschema.Draft202012Validator.check_schema(s);jsonschema.validate(M,s)
    (ROOT/'manifest/agent-perspectives.schema.json').write_text(json.dumps(s,indent=2))

def write_bindings():
    fields=['swarm_index','identity_code','agent_id','display_name','domain','role','perspective','group','palette_token','fallback_hex','material_kind','material_strength']
    rows=[]
    for a in A:rows.append({**{k:a[k]for k in fields if k in a},'palette_token':a['visual']['palette_token'],'fallback_hex':a['visual']['fallback_hex'],'material_kind':a['visual']['material']['kind'],'material_strength':a['visual']['material']['strength']})
    with (ROOT/'manifest/agent-perspectives.csv').open('w',newline='',encoding='utf-8-sig')as f:
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
    css=['/* Mint / Opal v3. The fallback hex is NOT the opal texture. */',':root {','  --darbot-mint: #50E6C2;']
    css += [f'  --{a["identity_code"].lower()}: {a["visual"]["fallback_hex"]};'for a in A]
    css+=['}','/* Exact material image, not a procedural browser approximation. */','.darbot-opal-material { background-image: url("../materials/opal_lightning_splatter_2048.png"); background-size: cover; }']
    (ROOT/'bindings/colors.css').write_text('\n'.join(css))
    tokens={}
    for a in A:
        rgb=a['visual']['color']['rgb'];tokens[a['identity_code']]={'$type':'color','$value':{'colorSpace':'srgb','components':[rgb[k]/255 for k in('r','g','b')],'alpha':1},'$description':a['display_name']+' — solid fallback color; material metadata is separate.','$extensions':{'darbot':{'agentId':a['agent_id'],'material':a['visual']['material']}}}
    (ROOT/'bindings/design-tokens.json').write_text(json.dumps({'darbot':{'mintOpal':tokens}},indent=2))
    (ROOT/'bindings/agents.ts').write_text('// Generated immutable identity records; these do not instantiate framework agents.\nexport const mintOpalAgents = '+json.dumps(rows,indent=2)+' as const;\nexport type MintOpalAgentId = typeof mintOpalAgents[number]["agent_id"];\nexport function findMintOpalAgent(id: MintOpalAgentId) { return mintOpalAgents.find(a => a.agent_id === id)!; }\n')
    cs=['// Generated identity registry. Solid fallback colors only.','namespace Darbot.Swarm;','public static class MintOpalPalette','{','    public static readonly System.Collections.Generic.IReadOnlyDictionary<string, uint> Argb =','        new System.Collections.Generic.Dictionary<string, uint>','        {']
    cs += [f'            ["{a["agent_id"]}"] = 0xFF{a["visual"]["fallback_hex"][1:]}u,' for a in A];cs+=['        };','}']
    (ROOT/'bindings/MintOpalPalette.cs').write_text('\n'.join(cs))
    fx='Table(\n'+',\n'.join('    { AgentId: "'+a['agent_id']+'", Name: "'+a['display_name']+'", Color: ColorValue("'+a['visual']['fallback_hex']+'"), Material: "'+a['visual']['material']['kind']+'" }'for a in A)+'\n)\n'
    (ROOT/'bindings/power-fx.txt').write_text(fx)
    ansi=''.join(a['visual']['color']['terminal']['ansi_foreground']+'■'+ '\x1b[0m '+a['identity_code']+' '+a['agent_id']+' '+a['visual']['fallback_hex']+(' [OPAL: solid fallback]' if a['visual']['material']['kind']=='opal-splatter' else '')+'\n'for a in A)
    (ROOT/'bindings/swatches.ansi').write_text(ansi,encoding='utf-8')
    lines=['# Darbot Swarm — Mint / Opal roster','', 'All display names and domain assignments below are Darbot design definitions. These are not claims of an installed, connected or deployed agent fleet.','', '| Swarm ID | Exact machine ID | Mint name | Domain | Assigned perspective |','|---|---|---|---|---|']
    lines+=['| '+ ' | '.join([a['identity_code'],a['agent_id'],a['display_name'],a['domain'],a['perspective']])+' |'for a in A]
    (ROOT/'manifest/agent-roster.md').write_text('\n'.join(lines),encoding='utf-8')
    refs={'note':'Official framework context used to choose proposed perspectives. Names, artwork and assignments are Darbot-specific; no affiliation or vendor endorsement is implied. agent-bot and agent-computer are generic requested role IDs, not inferred third-party SDKs.','references':[{'agent_id':a['agent_id'],'url':a['framework_reference']}for a in A if a['framework_reference']],'ansi_reference':{'user_supplied':'fnky/ANSI.md, RGB color and indexed-color sections','official':'https://invisible-island.net/xterm/ctlseqs/ctlseqs.html'}}
    (ROOT/'manifest/framework-references.json').write_text(json.dumps(refs,indent=2))

HTML=r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Darbot Swarm · Mint / Opal 64</title><style>
:root{--bg:#070d12;--panel:#111c24;--line:#263840;--text:#f4fbff;--muted:#a1b2be;--mint:#50e6c2}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,Segoe UI,sans-serif}main{max-width:1510px;margin:auto;padding:44px 32px}header{display:grid;grid-template-columns:1.3fr .7fr;align-items:center;border-bottom:1px solid var(--line);padding-bottom:26px;gap:24px}.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--mint);font-weight:700}h1{font-size:clamp(40px,5vw,72px);line-height:1.08;letter-spacing:-.045em;margin:20px 0}h1 span{color:var(--mint)}.lead{color:var(--muted);font-size:17px;max-width:740px}header img{width:min(100%,360px);justify-self:center;aspect-ratio:1;object-fit:contain}.pills{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid var(--line);border-radius:100px;padding:5px 13px;font-size:12px;color:var(--muted)}.controls{position:sticky;top:0;z-index:3;background:#070d12f5;backdrop-filter:blur(10px);padding:22px 0;display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)}input,select,button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 13px}input{flex:1;min-width:215px}button{cursor:pointer}button:hover,button[aria-pressed="true"]{border-color:var(--mint)}:focus-visible{outline:2px solid var(--mint);outline-offset:3px}.status{padding:14px 0;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}.card .top{padding:15px 16px 0;display:flex;justify-content:space-between;align-items:center;color:var(--muted);font:11px ui-monospace,monospace}.chip{width:22px;height:7px;border-radius:5px;display:inline-block;margin-right:7px}.art{display:block;width:100%;height:248px;object-fit:contain;background:#000;margin-top:12px}.content{padding:17px}h2{font-size:20px;line-height:1.3;margin:0 0 6px}code{font:12px ui-monospace,monospace;overflow-wrap:anywhere;color:var(--mint)}.domain{color:var(--muted);font-size:13px;margin:10px 0 0}.perspective{min-height:68px;color:var(--muted);font-size:13px;margin:8px 0 16px}.card button{font-size:12px;padding:7px 10px}.card .actions{display:flex;gap:7px;flex-wrap:wrap}.meta{font:11px ui-monospace,monospace;color:var(--muted);margin:12px 0 0}details{border:1px solid var(--line);background:var(--panel);padding:20px;border-radius:12px;margin:26px 0}summary{cursor:pointer;color:var(--mint);font-weight:600}details p{color:var(--muted);max-width:1100px}.note{font-size:12px;color:var(--muted);margin:24px 0}dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;width:min(920px,94vw);max-height:90vh}dialog::backdrop{background:#000c}dialog img{width:100%;max-height:52vh;object-fit:contain;background:#000}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--muted)}.modalbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}footer{color:var(--muted);font-size:12px;padding:30px 0}.empty{padding:70px 0;color:var(--muted)}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:760px){main{padding:26px 17px}header{grid-template-columns:1fr}header img{display:none}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.art{height:215px}.controls{position:static}}@media(max-width:450px){.grid{grid-template-columns:1fr}.art{height:290px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><main><header><div><div class="eyebrow">DARBOT LABS / SWARM IDENTITIES / SERIES 02</div><h1>Mint precision.<br><span>Opal energy.</span></h1><p class="lead">64 additional agent perspectives. Canonical contours, exact machine IDs, and a mint-led framework cohort. Source-derived opal splatter adds spectral variation without changing the token shape.</p><div class="pills"><span class="pill">Agents 65–128</span><span class="pill">15 requested identities</span><span class="pill">47 solid + 17 opal</span><span class="pill">Offline / self-contained</span></div></div><img id="hero" alt="Exact canonical Darbot token with opal lightning splatter material"></header>
<div class="controls"><input id="q" type="search" aria-label="Search agent identities" placeholder="Search name, framework, role or perspective…"><select id="group" aria-label="Filter agent group"><option value="">All domains</option></select><select id="finish" aria-label="Filter finish"><option value="">All finishes</option><option value="solid">Solid color</option><option value="opal-splatter">Opal material</option></select><button id="view" aria-pressed="false">Token view</button><button id="export">Export registry JSON</button></div><div class="status" id="status" role="status"></div><section class="grid" id="grid" aria-label="Agent identity gallery"></section><details><summary>Fidelity and schema contract</summary><p>Every 2048px token keeps the original alpha channel exactly. Opal changes the RGB material only. The inherited ghost outline, original visor and three status dots are retained. The canonical chest alpha is placed at [768, 984, 1280, 1513] on the 2048px agent canvas.</p><p>Unicode swatches do not carry RGB colors. The registry pairs ■ with exact RGB and ANSI Truecolor sequences. Opal uses a material ID plus a solid fallback; the fallback does not reproduce the material. The mint anchor is #50E6C2. Prior Solid64 identities are not overwritten.</p><p>These are artwork and proposed perspective definitions, not deployed agent runtimes. Framework names identify intended integration domains; all Mint aliases are Darbot naming choices.</p></details><p class="note">This file embeds 512px PNG previews and the complete registry. Large masters are provided separately in the asset packs. The SVG exports are explicitly raster-backed wrappers, not reconstructed vector paths.</p><footer>Darbot Swarm / Mint–Opal 64 / v3.0.0 · Identity uses IDs and readable labels, never color alone.</footer></main><dialog id="detail"><div class="modalbar"><strong id="dtitle"></strong><button id="close">Close</button></div><img id="dimage" alt="Selected Darbot agent"><pre id="djson"></pre></dialog><script id="payload" type="application/json">__PAYLOAD__</script><script>
'use strict';const D=JSON.parse(document.getElementById('payload').textContent),$=id=>document.getElementById(id);let tokenView=false;
const registry=structuredClone(D.manifest);const art=a=>D.images[a.agent_id][tokenView?'token':'agent'];
$('hero').src=D.images[registry.agents.find(a=>a.palette_index===46).agent_id].token;
for(const g of [...new Set(registry.agents.map(a=>a.group))].sort()){const o=document.createElement('option');o.value=g;o.textContent=g.replaceAll('-',' ');$('group').append(o)}
function download(name,text,type){const u=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function copy(text){try{await navigator.clipboard.writeText(text);$('status').textContent='Identity code copied.'}catch{const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();$('status').textContent=ok?'Identity code copied.':'Clipboard unavailable. Open Details to select the identity code.'}}
function show(a){$('dtitle').textContent=a.display_name+' · '+a.identity_code;$('dimage').src=art(a);$('dimage').alt=a.display_name+' Darbot identity';$('djson').textContent=JSON.stringify(a,null,2);$('detail').showModal()}
function render(){const q=$('q').value.toLowerCase(),g=$('group').value,f=$('finish').value;const list=registry.agents.filter(a=>(!g||a.group===g)&&(!f||a.visual.material.kind===f)&&[a.agent_id,a.display_name,a.identity_code,a.domain,a.perspective].join(' ').toLowerCase().includes(q));$('grid').replaceChildren();$('status').textContent=list.length+' of 64 agents · '+(tokenView?'canonical token':'full Darbot')+' view';for(const a of list){const card=document.createElement('article');card.className='card';const top=document.createElement('div');top.className='top';const label=document.createElement('span'),sw=document.createElement('i');sw.className='chip';sw.style.backgroundColor=a.visual.fallback_hex;label.append(sw,document.createTextNode(a.identity_code));const finish=document.createElement('span');finish.textContent=a.visual.material.kind==='solid'?a.visual.fallback_hex:'OPAL + MINT';top.append(label,finish);const img=document.createElement('img');img.className='art';img.src=art(a);img.alt=a.display_name+' — '+a.domain;img.loading='lazy';img.width=512;img.height=512;const content=document.createElement('div');content.className='content';const title=document.createElement('h2');title.textContent=a.display_name;const id=document.createElement('code');id.textContent=a.agent_id;const domain=document.createElement('p');domain.className='domain';domain.textContent=a.domain+' / '+a.role;const p=document.createElement('p');p.className='perspective';p.textContent=a.perspective;const actions=document.createElement('div');actions.className='actions';const info=document.createElement('button');info.textContent='Details';info.onclick=()=>show(a);const c=document.createElement('button');c.textContent='Copy ID';c.onclick=()=>copy(a.agent_id);const png=document.createElement('button');png.textContent='Save PNG';png.onclick=()=>{const l=document.createElement('a');l.href=art(a);l.download=a.identity_code+'_'+a.agent_id+'_'+(tokenView?'token':'agent')+'_512.png';l.click()};actions.append(info,c,png);content.append(title,id,domain,p,actions);card.append(top,img,content);$('grid').append(card)}if(!list.length){const e=document.createElement('p');e.className='empty';e.textContent='No identities match these filters.';$('grid').append(e)}}
for(const id of ['q','group','finish'])$(id).addEventListener('input',render);$('view').onclick=()=>{tokenView=!tokenView;$('view').setAttribute('aria-pressed',String(tokenView));$('view').textContent=tokenView?'Agent view':'Token view';render()};$('export').onclick=()=>download('darbot-mint-opal-agent-perspectives.json',JSON.stringify(registry,null,2),'application/json');$('close').onclick=()=>$('detail').close();$('detail').addEventListener('click',e=>{if(e.target===$('detail'))$('detail').close()});render();
</script></body></html>'''

def gallery():
    images={}
    for a in A:
        def uri(key):return 'data:image/png;base64,'+base64.b64encode((ROOT/a['assets'][key]).read_bytes()).decode()
        images[a['agent_id']]={'agent':uri('agent_512_transparent'),'token':uri('token_512')}
    payload=json.dumps({'manifest':M,'images':images},ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    (ROOT/'html/darbot_mint_opal_gallery.html').write_text(HTML.replace('__PAYLOAD__',payload),encoding='utf-8')

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('stage',choices=['sheets','metadata','gallery','qa']);stage=p.parse_args().stage
    if stage=='sheets':contact_sheets()
    if stage=='qa':qa_sheet()
    if stage=='metadata':write_schema();write_bindings()
    if stage=='gallery':gallery()
    print('Published:',stage,flush=True)
