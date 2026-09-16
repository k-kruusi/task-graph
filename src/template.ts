const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;
const FULL_TEMPLATE_RE = /^\{\{([^}]+)\}\}$/;

function resolve(path: string, scope: Record<string, unknown>): unknown {
  const segments = path.trim().split(".");
  let current: unknown = scope;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Interpolate one string. A string that IS a single template resolves to the
 * raw value (preserves type); otherwise each template is stringified in place.
 * Unresolved paths (undefined) keep the literal template on both paths; null is
 * a legitimate resolved value and passes through as null / "null". */
function interpolateString(value: string, scope: Record<string, unknown>): unknown {
  const fullMatch = FULL_TEMPLATE_RE.exec(value);
  if (fullMatch !== null) {
    const resolved = resolve(fullMatch[1], scope);
    if (resolved === undefined) return value;
    // Single-pass resolution: a resolved value is DATA, never re-scanned for
    // templates — node output containing "{{...}}" must not resolve scope paths
    // downstream (template injection). The plain JSON round-trip deep-copies
    // resolved objects without re-scanning, so handlers can't mutate upstream
    // results in ctx.nodes through aliased params.
    if (resolved !== null && typeof resolved === "object") {
      return JSON.parse(JSON.stringify(resolved));
    }
    return resolved;
  }
  return value.replace(TEMPLATE_RE, (_, path) => {
    const resolved = resolve(path, scope);
    return resolved === undefined ? `{{${path}}}` : String(resolved);
  });
}

function walk(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolateString(value, scope);
  if (Array.isArray(value)) return value.map((item) => walk(item, scope));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, scope);
    return out;
  }
  return value;
}

export function interpolate(
  params: Record<string, unknown>,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  return walk(params, scope) as Record<string, unknown>;
}
