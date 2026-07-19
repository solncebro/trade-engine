function setNestedField<T>(source: T, path: string[], value: unknown): T {
  if (path.length === 0) {
    return value as T;
  }

  const [head, ...rest] = path;
  const sourceObj = source as Record<string, unknown>;
  const childSource = sourceObj[head];

  return {
    ...sourceObj,
    [head]: setNestedField(childSource, rest, value),
  } as T;
}

function buildNestedPartial(path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error('buildNestedPartial: path must contain at least one segment');
  }

  if (path.length === 1) {
    return { [path[0]]: value };
  }

  return { [path[0]]: buildNestedPartial(path.slice(1), value) };
}

export { setNestedField, buildNestedPartial };
