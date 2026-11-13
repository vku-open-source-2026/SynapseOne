// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseBase Drizzle schema — the single source of truth for tables/indexes.
 */
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BaseMapping } from './mapping';

export const baseCollections = pgTable(
  'synapseone_base_collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    mapping: jsonb('mapping').$type<BaseMapping>().notNull().default(sql`'{"fields":{}}'::jsonb`),
    orgId: text('org_id'),
    accountId: text('account_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_base_collections_scope_name').on(
      sql`coalesce(${t.orgId}, '')`,
      sql`coalesce(${t.accountId}, '')`,
      t.name,
    ),
    index('idx_base_collections_tenant').on(t.orgId, t.accountId),
    index('idx_base_collections_org_name').on(t.orgId, t.name, t.createdAt).where(sql`${t.orgId} is not null`),
    index('idx_base_collections_account_name')
      .on(t.accountId, t.name)
      .where(sql`${t.orgId} is null and ${t.accountId} is not null`),
    index('idx_base_collections_global_name')
      .on(t.name)
      .where(sql`${t.orgId} is null and ${t.accountId} is null`),
  ],
);

export const baseDocuments = pgTable(
  'synapseone_base_documents',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => baseCollections.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.id] }),
    index('idx_base_documents_updated').on(t.collectionId, t.updatedAt.desc()),
    index('idx_base_documents_changes').on(t.collectionId, t.updatedAt, t.id),
    // jsonb_path_ops is smaller/faster for the containment (@>) queries Base uses.
    index('idx_base_documents_data').using('gin', t.data.op('jsonb_path_ops')),
  ],
);


/** Transactional outbox for committed document changes. Rows are written in
 *  the same Postgres transaction as the document mutation. */
export const baseOutbox = pgTable(
  'synapseone_base_outbox',
  {
    eventId: text('event_id').primaryKey(),
    orgId: text('org_id'),
    accountId: text('account_id'),
    collectionId: text('collection_id').notNull(),
    collectionName: text('collection_name').notNull().default(''),
    documentId: text('document_id').notNull(),
    operation: text('operation').notNull(),
    version: integer('version').notNull().default(1),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    index('idx_base_outbox_unpublished').on(t.publishedAt, t.occurredAt),
    index('idx_base_outbox_collection').on(t.collectionId, t.occurredAt),
  ],
);

export const baseVectors = pgTable(
  'synapseone_base_vectors',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => baseCollections.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull(),
    fieldName: text('field_name').notNull(),
    embedding: text('embedding').notNull(),
    dimension: integer('dimension').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.documentId, t.fieldName] }),
    index('idx_base_vectors_lookup').on(t.collectionId, t.fieldName),
  ],
);

/** Tenant-scoped search index over Base documents (#46). Rebuilt
 *  idempotently from collections; ACL and text are denormalised so a query
 *  never has to join across tenants. */
export const searchIndex = pgTable(
  'synapseone_search_index',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id').notNull(),
    collectionName: text('collection_name').notNull().default(''),
    documentId: text('document_id').notNull(),
    orgId: text('org_id'),
    accountId: text('account_id'),
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    acl: jsonb('acl').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    embedding: jsonb('embedding').$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_search_document').on(t.collectionId, t.documentId),
    index('idx_search_tenant').on(t.orgId, t.accountId),
    index('idx_search_collection').on(t.collectionId),
  ],
);
