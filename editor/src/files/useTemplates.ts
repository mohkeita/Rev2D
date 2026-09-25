/** GET /api/templates, fetched once per page (the list only changes with a new rev2d version). */
import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { TemplateInfo } from '../api.js';

let cache: Promise<TemplateInfo[]> | null = null;

export function useTemplates(): { templates: TemplateInfo[] | null; error: string | null } {
  const [state, setState] = useState<{ templates: TemplateInfo[] | null; error: string | null }>({ templates: null, error: null });
  useEffect(() => {
    let alive = true;
    cache ??= api.fetchTemplates().catch((e: unknown) => {
      cache = null; // retry next time
      throw e;
    });
    cache
      .then((templates) => alive && setState({ templates, error: null }))
      .catch((e: unknown) => alive && setState({ templates: [], error: (e as { detail?: string }).detail ?? String(e) }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
