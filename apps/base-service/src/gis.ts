// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SynapseBase GIS — GeoJSON features stored as PostGIS geometry(4326) next to
 * their Base collection. Bounding-box, radius (metres) and polygon queries run
 * inside Postgres with a GiST index; property payloads stay in jsonb.
 */
import { pgQuery } from './store';

export interface GeoFeature {
  type: 'Feature';
  id: string;
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
}

let ensured = false;

export async function ensureGeoTables(): Promise<void> {
  if (ensured) return;
  // PostGIS is installed by the platform database image (init.sql). If an old
  // volume is missing it, surface a clear error instead of a cryptic one.
  await pgQuery(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS synapseone_base_geo_features (
      collection_id text NOT NULL REFERENCES synapseone_base_collections(id) ON DELETE CASCADE,
      id text NOT NULL,
      properties jsonb NOT NULL DEFAULT '{}'::jsonb,
      geom geometry(Geometry, 4326) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection_id, id)
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_base_geo_features_geom ON synapseone_base_geo_features USING GIST (geom)`);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_base_geo_features_collection ON synapseone_base_geo_features(collection_id)`);
  ensured = true;
}

function cleanId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_@.:+-]{1,256}$/.test(id) ? id : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const ALLOWED_GEOMETRY = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

function featureRows(feature: unknown): { id: string; properties: Record<string, unknown>; geometry: Record<string, unknown> } | null {
  const item = asObject(feature);
  const geometry = asObject(item.geometry);
  const type = String(geometry.type || '');
  if (!ALLOWED_GEOMETRY.has(type)) return null;
  const properties = asObject(item.properties);
  const id = cleanId(item.id ?? properties.id ?? properties.feature_id);
  if (!id) return null;
  return { id, properties, geometry: { type, ...('coordinates' in geometry ? { coordinates: geometry.coordinates } : {}), ...('geometries' in geometry ? { geometries: geometry.geometries } : {}) } };
}

export async function upsertFeatures(collectionId: string, input: unknown[]): Promise<GeoFeature[]> {
  await ensureGeoTables();
  if (!Array.isArray(input) || !input.length) return [];
  if (input.length > 1000) throw new Error('at most 1000 features per request');
  const out: GeoFeature[] = [];
  for (const raw of input) {
    const parsed = featureRows(raw);
    if (!parsed) throw new Error('each feature needs an id and a GeoJSON geometry');
    const rows = await pgQuery<{ id: string; properties: Record<string, unknown>; geometry: Record<string, unknown> }>(
      `INSERT INTO synapseone_base_geo_features (collection_id, id, properties, geom)
       VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
       ON CONFLICT (collection_id, id) DO UPDATE
         SET properties = EXCLUDED.properties, geom = EXCLUDED.geom, updated_at = now()
       RETURNING id, properties, ST_AsGeoJSON(geom)::json AS geometry`,
      [collectionId, parsed.id, JSON.stringify(parsed.properties), JSON.stringify(parsed.geometry)],
    );
    out.push({ type: 'Feature', ...rows[0] });
  }
  return out;
}

function bboxParam(raw: string | undefined): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  if (!raw) return null;
  const parts = raw.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 || minLat > maxLat || minLng > maxLng) return null;
  return { minLng, minLat, maxLng, maxLat };
}

export async function listFeatures(
  collectionId: string,
  options: { bbox?: string; limit?: number } = {},
): Promise<GeoFeature[]> {
  await ensureGeoTables();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1000);
  const box = bboxParam(options.bbox);
  const rows = box
    ? await pgQuery(
        `SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
         FROM synapseone_base_geo_features
         WHERE collection_id = $1
           AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
         ORDER BY updated_at DESC LIMIT $6`,
        [collectionId, box.minLng, box.minLat, box.maxLng, box.maxLat, limit],
      )
    : await pgQuery(
        `SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
         FROM synapseone_base_geo_features
         WHERE collection_id = $1
         ORDER BY updated_at DESC LIMIT $2`,
        [collectionId, limit],
      );
  return rows.map((row: any) => ({ type: 'Feature', id: row.id, properties: row.properties, geometry: row.geometry }));
}

export async function near(
  collectionId: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  limit = 200,
): Promise<Array<GeoFeature & { distanceMeters: number }>> {
  await ensureGeoTables();
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('lat/lng out of range');
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 200_000) {
    throw new Error('radiusMeters must be between 1 and 200000');
  }
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await pgQuery(
    `SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry,
            ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance_m
     FROM synapseone_base_geo_features
     WHERE collection_id = $1
       AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
     ORDER BY distance_m ASC LIMIT $5`,
    [collectionId, lng, lat, radiusMeters, capped],
  );
  return rows.map((row: any) => ({
    type: 'Feature',
    id: row.id,
    properties: row.properties,
    geometry: row.geometry,
    distanceMeters: Number(row.distance_m),
  }));
}

export async function within(
  collectionId: string,
  geometry: unknown,
  limit = 200,
): Promise<GeoFeature[]> {
  await ensureGeoTables();
  const poly = asObject(geometry);
  if (!['Polygon', 'MultiPolygon'].includes(String(poly.type || ''))) {
    throw new Error('geometry must be a Polygon or MultiPolygon');
  }
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = await pgQuery(
    `SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
     FROM synapseone_base_geo_features
     WHERE collection_id = $1
       AND ST_Within(geom, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
     ORDER BY updated_at DESC LIMIT $3`,
    [collectionId, JSON.stringify(poly), capped],
  );
  return rows.map((row: any) => ({ type: 'Feature', id: row.id, properties: row.properties, geometry: row.geometry }));
}

export async function deleteFeature(collectionId: string, id: string): Promise<boolean> {
  await ensureGeoTables();
  const rows = await pgQuery(`DELETE FROM synapseone_base_geo_features WHERE collection_id = $1 AND id = $2 RETURNING id`, [collectionId, id]);
  return rows.length > 0;
}

export async function geoStats(collectionId: string): Promise<{ features: number; extent: unknown }> {
  await ensureGeoTables();
  const [row] = await pgQuery<{ count: string; extent: unknown }>(
    `SELECT count(*)::text AS count, ST_AsGeoJSON(ST_Extent(geom))::json AS extent
     FROM synapseone_base_geo_features WHERE collection_id = $1`,
    [collectionId],
  );
  return { features: Number(row?.count || 0), extent: row?.extent ?? null };
}
