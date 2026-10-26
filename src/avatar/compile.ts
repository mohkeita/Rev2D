/**
 * Stage 2 of the avatar build: spec + layer metadata -> the Rev2D model document (DESIGN.md §3).
 * Pure and fast (no pixels): the editor runs it in the browser on every handle drag.
 *
 * The skeleton built here, before any feature runs:
 *
 *   warp "avatarWarp"   ONE lattice over the whole image, cells of about 2% of the long side
 *     part "base"       the base layer as an image grid with the same cells: head, neck and body
 *                       are one continuous mesh
 *
 * Every feature (./features/) then adds its parameters, bindings on the root lattice, nested warps
 * and parts. The result also carries the fold plan the features declared (which poses to check
 * besides the defaults, which lattices collapse by design); `findFolds(model, compiled.folds)`
 * (./folds.ts) uses it. The fold check itself is not run here: it evaluates dozens of poses.
 */
import { AVATAR_Z, ModelBuilder, STANDARD_PARAMETERS } from './builder.js';
import { AVATAR_FEATURES } from './features/index.js';
import { createReportSink } from './features/report.js';
import type { AvatarFeature, CompileContext } from './features/types.js';
import { avatarMetrics, MAX_LATTICE_CELLS } from './fields.js';
import type { FoldPlan } from './folds.js';
import { BASE_LAYER, layerFile } from './layers.js';
import type { AvatarSpec, CompileAvatarResult, LayerInfo, LayersMeta } from './types.js';

/** Id of the root warp: the one lattice over the whole image that everything is parented to. */
export const ROOT_WARP = 'avatarWarp';

export interface CompiledAvatar extends CompileAvatarResult {
  /** What the fold checker needs to know about this model (extra poses, lattices that collapse by design). */
  folds: Required<FoldPlan>;
}

/** compileAvatar with an explicit feature list (tests compile with a subset). */
export function compileModel(spec: AvatarSpec, meta: LayersMeta, features: readonly AvatarFeature[] = AVATAR_FEATURES): CompiledAvatar {
  const { width, height } = spec.image;
  const metrics = avatarMetrics(spec);
  const report = createReportSink();
  const folds: Required<FoldPlan> = { poses: [], collapsible: [], skip: [] };

  if (meta.image.width !== width || meta.image.height !== height) {
    report.warning('avatar-layers-size', `the layers were built for a ${meta.image.width}x${meta.image.height} image, the spec says ${width}x${height}`, { hint: 'build the layers again ("rev2d avatar build")' });
  }
  if (metrics.cellClamped) {
    report.info('avatar-cell-clamped', `build.cell.body = ${spec.build?.cell?.body} px would need more than ${MAX_LATTICE_CELLS} lattice cells per side: using ${Math.round(metrics.cell.body * 100) / 100} px`, { path: '/build/cell/body' });
  }

  const model = new ModelBuilder({
    name: spec.name,
    width,
    height,
    description: `Avatar built from ${spec.image.file} by "rev2d avatar build". Generated: edit avatar.json (or its "post" ops), not this file.`,
  });
  const root = model.warp({
    id: ROOT_WARP,
    rect: [0, 0, width, height],
    cell: metrics.cell.body,
    description: 'The whole illustration as one lattice: head turn, tilt, body sway and breath are bindings on it, every layer is its child.',
  });

  let base: LayerInfo | undefined = meta.layers.find((l) => l.id === BASE_LAYER);
  if (!base) {
    report.warning('avatar-layers-incomplete', 'layers.json lists no "base" layer', { hint: 'build the layers again ("rev2d avatar build")' });
    base = { id: BASE_LAYER, file: layerFile(BASE_LAYER), rect: [0, 0, width, height] };
  }
  // The same cells as the lattice: every mesh vertex is a lattice point, so the base moves exactly as the lattice does.
  const bounds=meta.fullBaseBounds;
  if(spec.framing==='full'&&Array.isArray(bounds)&&bounds.length===4&&bounds.every(Number.isFinite)){
    // Retain the original lattice vertices; omit the large transparent border from drawable bounds.
    const xs=Array.from({length:root.lattice.cols+1},(_,i)=>i*width/root.lattice.cols).filter(x=>x>=bounds[0]-metrics.cell.body&&x<=bounds[2]+metrics.cell.body);
    const ys=Array.from({length:root.lattice.rows+1},(_,i)=>i*height/root.lattice.rows).filter(y=>y>=bounds[1]-metrics.cell.body&&y<=bounds[3]+metrics.cell.body);
    const vertices=ys.flatMap(y=>xs.flatMap(x=>[x,y])),uvs=vertices.map((v,i)=>v/(i%2?height:width)),triangles:number[]=[];
    for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++){const a=y*xs.length+x,b=a+1,c=a+xs.length,d=c+1;triangles.push(a,b,c,b,d,c);}
    model.part({id:'base',parent:root.id,z:AVATAR_Z.base,shape:{type:'mesh',texture:model.texture(base),vertices,uvs,triangles},description:'Continuous base lattice, restricted to the occupied image region.'});
  }else{
  model.imagePart(base, {
    parent: root.id,
    cols: root.lattice.cols,
    rows: root.lattice.rows,
    z: AVATAR_Z.base,
    description: 'The illustration (moving layers cut out and filled in behind) as one continuous mesh.',
  });
  }

  const ctx: CompileContext = {
    spec,
    meta,
    metrics,
    model,
    root,
    layer: (id) => meta.layers.find((l) => l.id === id),
    featureMeta: <T>(key: string) => (Object.hasOwn(meta, key) ? (meta[key] as T) : undefined),
    folds: {
      pose: (params) => void folds.poses.push({ ...params }),
      collapsible: (kind, id) => void folds.collapsible.push(`${kind}:${id}`),
      skip: (kind, id) => void folds.skip.push(`${kind}:${id}`),
    },
    report,
  };
  for (const feature of features) feature.compile?.(ctx);
  if(spec.framing==='full'||spec.arms?.length){
    const ids=['BodyY','BodyAngleZ','ArmRA','ArmLA','ArmRB','ArmLB','HandR','HandL','HandRForm','HandLForm','EyeWide','MouthShape'] as const;
    for(const id of ids)if(model.hasParameter(id))for(const v of [STANDARD_PARAMETERS[id].min,STANDARD_PARAMETERS[id].max])for(const x of [-30,30])for(const b of [-10,10])folds.poses.push({[id]:v,AngleX:x,BodyAngleX:b});
  }

  for (const [name, value] of Object.entries(model.stats())) report.stat(name, value);
  report.stat('latticeCols', root.lattice.cols);
  report.stat('latticeRows', root.lattice.rows);
  return { doc: model.build(), report: { issues: report.issues, stats: report.stats }, folds };
}
