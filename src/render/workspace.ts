import type { ImageRGBA } from '../core/types.js';
export interface RasterTexture {
  width: number;
  height: number;
  data: Float32Array;
}

/** One reusable framebuffer. Resolved ImageRGBA outputs never alias this scratch storage. */
export class RasterWorkspace {
  private samples = new Float32Array(0);
  private textures = new WeakMap<ImageRGBA, RasterTexture>();
  /** Cache textures only when source pixels are immutable for this workspace's lifetime. */
  constructor(private readonly options: { cacheTextures?: boolean } = {}) {}
  /** @internal renderImage validates the framebuffer size before requesting storage. */
  framebuffer(length: number): Float32Array {
    if (this.samples.length !== length) this.samples = new Float32Array(length);
    return this.samples;
  }
  /** @internal Identity keys keep differently named or newly loaded textures independent. */
  texture(image: ImageRGBA, build: () => RasterTexture): RasterTexture {
    if (!this.options.cacheTextures) return build();
    let texture = this.textures.get(image);
    if (!texture) {
      texture = build();
      this.textures.set(image, texture);
    }
    return texture;
  }
  /** Call after editing pixels when immutable-texture caching was explicitly enabled. */
  resetTextures(): void {
    this.textures = new WeakMap();
  }
}
