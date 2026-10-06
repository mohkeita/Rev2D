/**
 * The placeholder character of the gallery's editor mock: Rev2D's own "hana" example, compiled and
 * rasterized in the browser by the same core and software renderer the CLI uses. Being a real rig,
 * the inspector sliders of the mock really turn her head.
 */
import { useEffect, useMemo, useRef } from 'react';
import hanaText from '../../../../examples/hana/hana.r2d.json?raw';
import { Rig, buildRenderList, parseModelText } from '../../../../src/core/index.js';
import { renderImage } from '../../../../src/render/browser.js';

export interface CharacterParameter {
  id: string;
  min: number;
  max: number;
  default: number;
}

export interface Character {
  width: number;
  height: number;
  parameters: CharacterParameter[];
  /** Part ids in draw order (back to front). */
  parts: string[];
  /** Rasterize a pose with a transparent background. */
  render: (params: Record<string, number>, scale: number, supersample: number) => ImageData;
}

let cached: Character | null = null;

export function loadCharacter(): Character {
  if (cached) return cached;
  const result = parseModelText(hanaText);
  if (!result.model) throw new Error('the hana example failed to validate');
  const model = result.model;
  const rig = new Rig(model);
  const character: Character = {
    width: model.meta.width,
    height: model.meta.height,
    parameters: model.parameters.map((p) => ({ id: p.id, min: p.min, max: p.max, default: p.default ?? 0 })),
    parts: model.parts.map((p) => p.id),
    render: (params, scale, supersample) => {
      // Physics off: a still pose must not depend on a simulated history.
      const pose = rig.pose({ params, physics: false });
      const list = buildRenderList(rig, pose);
      const image = renderImage(list, {}, { scale, supersample, background: [0, 0, 0, 0] });
      return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    },
  };
  cached = character;
  return character;
}

export interface CharacterCanvasProps {
  params: Record<string, number>;
  /** Output pixels per model unit. */
  scale?: number;
  className?: string;
}

/** Draws the character; re-rasterizes (at most once per frame) when the parameters change. */
export function CharacterCanvas({ params, scale = 1, className }: CharacterCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const character = useMemo(() => {
    try {
      return loadCharacter();
    } catch (e) {
      console.error(e);
      return null;
    }
  }, []);
  const key = JSON.stringify(params);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !character) return;
    const frame = requestAnimationFrame(() => {
      const image = character.render(JSON.parse(key) as Record<string, number>, scale, 2);
      el.width = image.width;
      el.height = image.height;
      el.getContext('2d')?.putImageData(image, 0, 0);
      el.dataset.rendered = 'true';
    });
    return () => cancelAnimationFrame(frame);
  }, [character, key, scale]);

  return <canvas ref={canvas} className={className} role="img" aria-label="Hana, the Rev2D example character" />;
}
