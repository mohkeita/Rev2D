import type { ImageRGBA, Mat2D, Pose } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import type { Scene, SceneLayer } from './schema.js';
import type { ResolvedCue } from './alignment.js';

export interface SceneSource {
  width: number;
  height: number;
  image?: ImageRGBA;
  rig?: Rig;
  textures: Record<string, ImageRGBA>;
  anchor: [number, number];
  scale: number;
  points?: Record<string, { at: [number, number]; parent?: string }>;
  pointParent?: string;
}
export interface LayerAssets {
  sources: Record<string, SceneSource>;
  anchors?: Record<string, { at: [number, number]; scale: number }>;
  content?: ImageRGBA;
  contentRect?: [number, number, number, number];
}
export interface SceneAssets {
  layers: Record<string, LayerAssets>;
}
export interface PreparedScene {
  scene: Scene;
  assets: SceneAssets;
  cues: ResolvedCue[];
}
export interface LayerState {
  layer: SceneLayer;
  source: SceneSource;
  poseId: string;
  pose?: Pose;
  matrix: Mat2D;
  opacity: number;
  reveal: number;
}
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
}
export interface EvaluatedScene {
  time: number;
  camera: CameraState;
  layers: LayerState[];
}
