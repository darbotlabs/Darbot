#!/usr/bin/env python3
"""Independent saved-file validation. Run from any directory; exits on a failed gate."""
from pathlib import Path
import colorsys, hashlib, json
import numpy as np
from PIL import Image
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
m=json.loads((ROOT/'manifest/agent-perspectives.json').read_text())
s=json.loads((ROOT/'manifest/agent-perspectives.schema.json').read_text())
jsonschema.validate(m,s)
assert len(m['agents'])==64
assert {a['swarm_index']for a in m['agents']}==set(range(65,129))
assert len({a['agent_id']for a in m['agents']})==64
assert len({a['identity_code']for a in m['agents']})==64
assert len({p['hex']for p in m['palette']})==64
alpha=Image.open(ROOT/'source/token_original.png').getchannel('A');a0=np.array(alpha)
line=np.array(Image.open(ROOT/'source/outline_alpha_2048.png').convert('L'))
static=np.array(Image.open(ROOT/'source/visor_and_dots_static.png').convert('RGB')).max(axis=2)>0
full_alpha=np.maximum(line,np.uint8(static)*255)
chest=alpha.crop((96,65,1952,1983)).resize((512,529),Image.Resampling.LANCZOS)
full_alpha[984:1513,768:1280]=np.maximum(full_alpha[984:1513,768:1280],np.array(chest))
expected1024=np.array(Image.fromarray(full_alpha).resize((1024,1024),Image.Resampling.LANCZOS))
asset_count=0;token_delta=0;avatar_delta=0;roundtrip_error=0;hash_errors=[]
record={r['agent_id']:r for r in json.loads((ROOT/'qa/render-validation.json').read_text())['variants']}
for a in m['agents']:
 for rel in a['assets'].values():assert (ROOT/rel).is_file(),rel;asset_count+=1
 im=Image.open(ROOT/a['assets']['token_2048']);diff=np.array(im.getchannel('A'))!=a0;token_delta+=int(np.count_nonzero(diff))
 ag=Image.open(ROOT/a['assets']['agent_1024_transparent']);avatar_delta+=int(np.count_nonzero(np.array(ag.getchannel('A'))!=expected1024))
 c=a['visual']['color'];v=c['hsl'];rr=tuple(round(z*255)for z in colorsys.hls_to_rgb(v['h']/360,v['l']/100,v['s']/100));orig=tuple(c['rgb'][k]for k in('r','g','b'));roundtrip_error+=int(rr!=orig)
 for key,field in [('token_2048','token_2048_sha256'),('agent_2048_black','agent_2048_sha256')]:
  actual=hashlib.sha256((ROOT/a['assets'][key]).read_bytes()).hexdigest()
  if actual!=record[a['agent_id']][field]:hash_errors.append(a['agent_id']+':'+key)
assert token_delta==0 and avatar_delta==0 and roundtrip_error==0 and not hash_errors
assert sum(a['visual']['material']['kind']=='solid'for a in m['agents'])==47
assert sum(a['visual']['material']['kind']=='opal-splatter'for a in m['agents'])==17
report={'schema_validation':'PASS','agent_count':64,'unique_agent_ids':64,'unique_identity_codes':64,'unique_fallback_hex':64,'asset_paths_verified':asset_count,'token_2048_alpha_mismatch_pixels_total':token_delta,'agent_1024_alpha_mismatch_pixels_total':avatar_delta,'hsl_to_rgb_mismatches':roundtrip_error,'master_checksum_mismatches':hash_errors,'source_alpha_raw_sha256':hashlib.sha256(alpha.tobytes()).hexdigest(),'note':'Independent reopened-file checks. Color similarity and vendor-affiliation claims are not inferred from these tests.'}
(ROOT/'qa/independent-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
