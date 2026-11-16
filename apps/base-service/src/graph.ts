// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SynapseBase Graph — tenant-scoped property graph stored in Postgres.
 *
 * Nodes and edges live next to their collection; traversal is a bounded
 * recursive CTE so a malicious request cannot walk the whole database.
 */
import { pgQuery } from './store';

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

let ensured = false;

export async function ensureGraphTables(): Promise<void> {
  if (ensured) return;
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS synapseone_base_graph_nodes (
      collection_id text NOT NULL REFERENCES synapseone_base_collections(id) ON DELETE CASCADE,
      id text NOT NULL,
      labels text[] NOT NULL DEFAULT '{}',
      properties jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection_id, id)
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS synapseone_base_graph_edges (
      collection_id text NOT NULL,
      id text NOT NULL,
      from_id text NOT NULL,
      to_id text NOT NULL,
      type text NOT NULL,
      properties jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection_id, id),
      FOREIGN KEY (collection_id, from_id) REFERENCES synapseone_base_graph_nodes(collection_id, id) ON DELETE CASCADE,
      FOREIGN KEY (collection_id, to_id) REFERENCES synapseone_base_graph_nodes(collection_id, id) ON DELETE CASCADE
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_base_graph_edges_from ON synapseone_base_graph_edges(collection_id, from_id)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_base_graph_edges_to ON synapseone_base_graph_edges(collection_id, to_id)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_base_graph_edges_type ON synapseone_base_graph_edges(collection_id, type)`);
  ensured = true;
}

function cleanId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_@.:+-]{1,256}$/.test(id) ? id : null;
}

function cleanLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter((item) => /^[A-Za-z0-9_:-]{1,64}$/.test(item)))].slice(0, 16);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function upsertNodes(collectionId: string, input: unknown[]): Promise<GraphNode[]> {
  await ensureGraphTables();
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > 1000) throw new Error('at most 1000 nodes per request');
  const out: GraphNode[] = [];
  for (const raw of input) {
    const item = asObject(raw);
    const id = cleanId(item.id);
    if (!id) throw new Error(`invalid node id: ${String(item.id).slice(0, 40)}`);
    const labels = cleanLabels(item.labels);
    const properties = asObject(item.properties);
    const rows = await pgQuery<{ id: string; labels: string[]; properties: Record<string, unknown>; created_at: string; updated_at: string }>(
      `INSERT INTO synapseone_base_graph_nodes (collection_id, id, labels, properties)
       VALUES ($1, $2, $3::text[], $4::jsonb)
       ON CONFLICT (collection_id, id) DO UPDATE
         SET labels = EXCLUDED.labels, properties = EXCLUDED.properties, updated_at = now()
       RETURNING id, labels, properties, created_at, updated_at`,
      [collectionId, id, labels, JSON.stringify(properties)],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function upsertEdges(collectionId: string, input: unknown[]): Promise<GraphEdge[]> {
  await ensureGraphTables();
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > 2000) throw new Error('at most 2000 edges per request');
  const out: GraphEdge[] = [];
  for (const raw of input) {
    const item = asObject(raw);
    const from = cleanId(item.from ?? item.from_id);
    const to = cleanId(item.to ?? item.to_id);
    const type = String(item.type ?? '').trim();
    if (!from || !to) throw new Error('edge requires from/to node ids');
    if (!/^[A-Za-z0-9_:-]{1,64}$/.test(type)) throw new Error('edge type must match [A-Za-z0-9_:-]{1,64}');
    const id = cleanId(item.id) || `${from}->${type}->${to}`;
    const properties = asObject(item.properties);
    const rows = await pgQuery<GraphEdge>(
      `INSERT INTO synapseone_base_graph_edges (collection_id, id, from_id, to_id, type, properties)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (collection_id, id) DO UPDATE
         SET type = EXCLUDED.type, properties = EXCLUDED.properties, updated_at = now()
       RETURNING id, from_id AS "from", to_id AS "to", type, properties, created_at, updated_at`,
      [collectionId, id, from, to, type, JSON.stringify(properties)],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function getNode(collectionId: string, id: string): Promise<GraphNode | null> {
  await ensureGraphTables();
  const rows = await pgQuery<GraphNode>(
    `SELECT id, labels, properties, created_at, updated_at
     FROM synapseone_base_graph_nodes WHERE collection_id = $1 AND id = $2`,
    [collectionId, id],
  );
  return rows[0] ?? null;
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  next: boolean;
}

/** Bounded BFS from one or more start nodes. */
export async function subgraph(
  collectionId: string,
  startIds: string[],
  depth = 1,
  edgeTypes: string[] = [],
  limit = 200,
): Promise<Subgraph> {
  await ensureGraphTables();
  const starts = startIds.map(cleanId).filter((id): id is string => Boolean(id));
  if (!starts.length) return { nodes: [], edges: [], next: false };
  const maxDepth = Math.min(Math.max(Math.trunc(depth), 1), 5);
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const types = edgeTypes.map((t) => String(t)).filter((t) => /^[A-Za-z0-9_:-]{1,64}$/.test(t));
  const nodes = await pgQuery<GraphNode>(
    `WITH RECURSIVE reach(id, depth) AS (
       SELECT unnest($2::text[])::text, 0
       UNION
       SELECT CASE WHEN e.from_id = r.id THEN e.to_id ELSE e.from_id END, r.depth + 1
       FROM synapseone_base_graph_edges e
       JOIN reach r ON (e.from_id = r.id OR e.to_id = r.id)
       WHERE r.depth < $3 AND e.collection_id = $1
         AND ($4::text[] = '{}' OR e.type = ANY($4::text[]))
     )
     SELECT DISTINCT n.id, n.labels, n.properties, n.created_at, n.updated_at
     FROM synapseone_base_graph_nodes n
     JOIN reach r ON r.id = n.id
     WHERE n.collection_id = $1
     LIMIT $5`,
    [collectionId, starts, maxDepth, types, capped + 1],
  );
  const truncated = nodes.length > capped;
  const visible = truncated ? nodes.slice(0, capped) : nodes;
  const ids = visible.map((node) => node.id);
  const edges = ids.length
    ? await pgQuery<GraphEdge>(
        `SELECT id, from_id AS "from", to_id AS "to", type, properties, created_at, updated_at
         FROM synapseone_base_graph_edges
         WHERE collection_id = $1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[])`,
        [collectionId, ids],
      )
    : [];
  return { nodes: visible, edges, next: truncated };
}

export async function deleteNode(collectionId: string, id: string): Promise<boolean> {
  await ensureGraphTables();
  const rows = await pgQuery(`DELETE FROM synapseone_base_graph_nodes WHERE collection_id = $1 AND id = $2 RETURNING id`, [collectionId, id]);
  return rows.length > 0;
}

export async function graphStats(collectionId: string): Promise<{ nodes: number; edges: number }> {
  await ensureGraphTables();
  const [nodes] = await pgQuery<{ count: string }>(`SELECT count(*)::text AS count FROM synapseone_base_graph_nodes WHERE collection_id = $1`, [collectionId]);
  const [edges] = await pgQuery<{ count: string }>(`SELECT count(*)::text AS count FROM synapseone_base_graph_edges WHERE collection_id = $1`, [collectionId]);
  return { nodes: Number(nodes?.count || 0), edges: Number(edges?.count || 0) };
}
