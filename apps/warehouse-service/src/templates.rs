// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Built-in ETL recipes exposed by `GET /v1/warehouse/templates`.

use crate::types::{EtlTemplate, WarehouseColumn};

fn column(name: &str, column_type: &str) -> WarehouseColumn {
    WarehouseColumn {
        name: name.into(),
        column_type: column_type.into(),
    }
}

pub fn etl_templates() -> Vec<EtlTemplate> {
    vec![
        EtlTemplate {
            id: "batch-daily-rollup".into(),
            name: "Daily rollup".into(),
            mode: "batch".into(),
            description: "Aggregate a timestamped dataset into one row per day and category, then replace the target dataset.".into(),
            write_mode: Some("replace".into()),
            sql_template: Some(
                "SELECT date_trunc('day', occurred_at) AS day, category, count(*) AS events, avg(severity) AS avg_severity\n\
                 FROM city_incidents\n\
                 GROUP BY 1, 2\n\
                 ORDER BY 1 DESC"
                    .into(),
            ),
            target_columns: Some(vec![
                column("day", "timestamp"),
                column("category", "string"),
                column("events", "number"),
                column("avg_severity", "number"),
            ]),
            stream_topic_hint: None,
        },
        EtlTemplate {
            id: "batch-top-n".into(),
            name: "Top-N leaderboard".into(),
            mode: "batch".into(),
            description:
                "Rank a metric per group; useful for dashboards and published open-data snapshots."
                    .into(),
            write_mode: Some("replace".into()),
            sql_template: Some(
                "SELECT city, count(*) AS incidents, max(severity) AS worst_severity\n\
                 FROM city_incidents\n\
                 GROUP BY city\n\
                 ORDER BY incidents DESC\n\
                 LIMIT 20"
                    .into(),
            ),
            target_columns: Some(vec![
                column("city", "string"),
                column("incidents", "number"),
                column("worst_severity", "number"),
            ]),
            stream_topic_hint: None,
        },
        EtlTemplate {
            id: "batch-window-compare".into(),
            name: "Period-over-period".into(),
            mode: "batch".into(),
            description: "Compare the last 7 days with the previous 7 days per category.".into(),
            write_mode: Some("replace".into()),
            sql_template: Some(
                "WITH daily AS (\n  \
                 SELECT date_trunc('day', occurred_at) AS day, category, count(*) AS events\n  \
                 FROM city_incidents GROUP BY 1, 2\n\
                 ), totals AS (\n  \
                 SELECT category, sum(CASE WHEN day >= current_date - INTERVAL 7 DAY THEN events ELSE 0 END) AS last_7d,\n         \
                 sum(CASE WHEN day < current_date - INTERVAL 7 DAY AND day >= current_date - INTERVAL 14 DAY THEN events ELSE 0 END) AS prev_7d\n  \
                 FROM daily GROUP BY category\n\
                 )\n\
                 SELECT category, last_7d, prev_7d, last_7d - prev_7d AS delta FROM totals ORDER BY delta ASC"
                    .into(),
            ),
            target_columns: Some(vec![
                column("category", "string"),
                column("last_7d", "number"),
                column("prev_7d", "number"),
                column("delta", "number"),
            ]),
            stream_topic_hint: None,
        },
        EtlTemplate {
            id: "stream-sensor-ingest".into(),
            name: "Sensor stream ingest".into(),
            mode: "stream".into(),
            description:
                "Consume a SynapseStream topic and append each event payload to a sensor_readings dataset."
                    .into(),
            write_mode: None,
            sql_template: None,
            target_columns: Some(vec![
                column("ts", "timestamp"),
                column("device_id", "string"),
                column("metric", "string"),
                column("value", "number"),
            ]),
            stream_topic_hint: Some("iot-sensors".into()),
        },
        EtlTemplate {
            id: "stream-incident-ingest".into(),
            name: "Incident stream ingest".into(),
            mode: "stream".into(),
            description:
                "Consume incident events from SynapseStream and append them to a warehouse table."
                    .into(),
            write_mode: None,
            sql_template: None,
            target_columns: Some(vec![
                column("ts", "timestamp"),
                column("category", "string"),
                column("severity", "number"),
                column("description", "string"),
            ]),
            stream_topic_hint: Some("city-incidents".into()),
        },
    ]
}
