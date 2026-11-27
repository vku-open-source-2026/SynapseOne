CREATE TABLE "synapseone_workflow_reservations" (
	"kind" text NOT NULL,
	"reservation_key" text NOT NULL,
	"workflow_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synapseone_workflow_reservations_kind_reservation_key_pk" PRIMARY KEY("kind","reservation_key")
);
--> statement-breakpoint
CREATE INDEX "idx_synapseone_workflow_reservations_workflow" ON "synapseone_workflow_reservations" USING btree ("workflow_id");
--> statement-breakpoint
CREATE TEMP TABLE "_synapseone_workflow_reservation_backfill" (
  "kind" text NOT NULL,
  "reservation_key" text NOT NULL,
  "workflow_id" text NOT NULL,
  "tool_name" text,
  "is_public" boolean NOT NULL DEFAULT false,
  "tenant_scope" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "_synapseone_workflow_reservation_backfill" ("kind", "reservation_key", "workflow_id", "tenant_scope")
SELECT 'webhook', 'webhook:' || regexp_replace(node->'parameters'->>'path', '^/+|/+$', '', 'g'), w.id, 'global'
FROM "synapseone_workflows" w
CROSS JOIN LATERAL jsonb_array_elements(w.nodes) AS node
WHERE w.active = true
  AND node->>'type' IN ('webhook', 'n8n-nodes-base.webhook', 'synapseone.webhook', 'synapsedx.webhook')
  AND regexp_replace(node->'parameters'->>'path', '^/+|/+$', '', 'g') ~ '^[A-Za-z0-9_./-]+$'
  AND char_length(regexp_replace(node->'parameters'->>'path', '^/+|/+$', '', 'g')) BETWEEN 1 AND 128
  AND '..' <> ALL (string_to_array(regexp_replace(node->'parameters'->>'path', '^/+|/+$', '', 'g'), '/'));
--> statement-breakpoint
INSERT INTO "_synapseone_workflow_reservation_backfill" ("kind", "reservation_key", "workflow_id", "tool_name", "is_public", "tenant_scope")
SELECT 'mcp',
  CASE WHEN (node->'parameters'->>'public') = 'true' AND coalesce(node->'parameters'->>'readOnly', 'true') <> 'false'
    THEN 'mcp:public:' || tool_name
    ELSE 'mcp:tenant:' || scope || ':' || tool_name END,
  first_tool.id, tool_name,
  (node->'parameters'->>'public') = 'true' AND coalesce(node->'parameters'->>'readOnly', 'true') <> 'false',
  scope
FROM (
  SELECT DISTINCT ON (w.id)
    w.id, node,
    trim(coalesce(node->'parameters'->>'toolName', node->>'name')) AS tool_name,
    CASE WHEN w.org_id IS NOT NULL THEN 'org:' || w.org_id
         WHEN w.account_id IS NOT NULL THEN 'account:' || w.account_id
         ELSE 'global' END AS scope
  FROM "synapseone_workflows" w
  CROSS JOIN LATERAL jsonb_array_elements(w.nodes) WITH ORDINALITY AS nodes(node, ordinality)
  WHERE w.active = true
    AND node->>'type' IN ('mcpTrigger', 'n8n-nodes-base.mcpTrigger', 'synapseone.mcpTrigger', 'synapsedx.mcpTrigger')
    AND trim(coalesce(node->'parameters'->>'toolName', node->>'name')) ~ '^[A-Za-z0-9_.-]{1,64}$'
  ORDER BY w.id, ordinality
) AS first_tool;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_synapseone_workflow_reservation_backfill"
    GROUP BY "kind", "reservation_key" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'existing active workflows contain duplicate global trigger reservations; deactivate or rename them before migrating';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "_synapseone_workflow_reservation_backfill" a
    JOIN "_synapseone_workflow_reservation_backfill" b
      ON a."kind" = 'mcp' AND b."kind" = 'mcp'
     AND a.tool_name = b.tool_name AND a.workflow_id <> b.workflow_id
    WHERE a.is_public OR b.is_public OR a.tenant_scope = b.tenant_scope
  ) THEN
    RAISE EXCEPTION 'existing active workflows contain duplicate MCP tool reservations; deactivate or rename them before migrating';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "synapseone_workflow_reservations" ("kind", "reservation_key", "workflow_id")
SELECT "kind", "reservation_key", "workflow_id" FROM "_synapseone_workflow_reservation_backfill";
--> statement-breakpoint
DROP TABLE "_synapseone_workflow_reservation_backfill";