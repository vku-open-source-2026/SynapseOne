// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tenant-scoped search client (#46): full-text, semantic and hybrid queries
 * over Base documents, reindex and index status.
 */
import { HttpClient } from './_http';

export interface SearchQuery {
  query: string;
  mode?: 'fulltext' | 'semantic' | 'hybrid';
  collection?: string;
  collections?: string[];
  filters?: Record<string, string>;
  limit?: number;
  cursor?: string | null;
}

export class SearchService {
  constructor(private readonly http: HttpClient) {}

  query(input: SearchQuery) {
    return this.http.req('/v1/search', { method: 'POST', body: JSON.stringify(input) });
  }

  fulltext(query: string, opts: Omit<SearchQuery, 'query' | 'mode'> = {}) {
    return this.query({ query, ...opts, mode: 'fulltext' });
  }

  semantic(query: string, opts: Omit<SearchQuery, 'query' | 'mode'> = {}) {
    return this.query({ query, ...opts, mode: 'semantic' });
  }

  hybrid(query: string, opts: Omit<SearchQuery, 'query' | 'mode'> = {}) {
    return this.query({ query, ...opts, mode: 'hybrid' });
  }

  reindex(collections?: string[]) {
    return this.http.req('/v1/search/reindex', {
      method: 'POST', body: JSON.stringify(collections ? { collections } : {}),
    });
  }

  status() { return this.http.req('/v1/search/status'); }
}
