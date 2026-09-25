/** Thrown when a part's shape, paint or stroke cannot be compiled (bad data, unknown texture, ...). */
export class GeometryError extends Error {
  override name = 'GeometryError';
}

/** Throw a GeometryError unless every value is a finite number. */
export function assertFinite(what: string, values: ArrayLike<number>): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new GeometryError(`${what} must be finite numbers (got ${values[i]} at index ${i})`);
  }
}
