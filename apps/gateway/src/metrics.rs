// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Minimal hand-rolled Prometheus exposition. Dependency-free and deterministic
//! (sorted label sets) so metric output is easy to assert in tests.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct Counters {
    requests: BTreeMap<(String, String), u64>,
    authz: BTreeMap<(String, String), u64>,
}

pub struct Metrics {
    counters: Mutex<Counters>,
    started_at: f64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64())
            .unwrap_or(0.0);
        Self {
            counters: Mutex::new(Counters::default()),
            started_at,
        }
    }

    pub fn inc_request(&self, route: &str, status: &str) {
        let mut counters = self.counters.lock().expect("metrics");
        *counters
            .requests
            .entry((route.to_string(), status.to_string()))
            .or_insert(0) += 1;
    }

    pub fn inc_authz(&self, mode: &str, result: &str) {
        let mut counters = self.counters.lock().expect("metrics");
        *counters
            .authz
            .entry((mode.to_string(), result.to_string()))
            .or_insert(0) += 1;
    }

    pub fn render(&self, version: &str) -> String {
        let counters = self.counters.lock().expect("metrics");
        let mut output = String::new();
        output.push_str(
            "# HELP gateway_up Gateway process is up\n\
             # TYPE gateway_up gauge\n\
             gateway_up 1\n",
        );
        output.push_str(&format!(
            "# HELP gateway_build_info Gateway build information\n\
             # TYPE gateway_build_info gauge\n\
             gateway_build_info{{version=\"{}\"}} 1\n",
            escape_label(version)
        ));
        output.push_str(&format!(
            "# HELP process_start_time_seconds Start time of the process since unix epoch in seconds\n\
             # TYPE process_start_time_seconds gauge\n\
             process_start_time_seconds {:.3}\n",
            self.started_at
        ));
        output.push_str(
            "# HELP gateway_requests_total Total proxied requests\n\
             # TYPE gateway_requests_total counter\n",
        );
        for ((route, status), value) in &counters.requests {
            output.push_str(&format!(
                "gateway_requests_total{{route=\"{}\",status=\"{}\"}} {value}\n",
                escape_label(route),
                escape_label(status)
            ));
        }
        output.push_str(
            "# HELP gateway_authz_decisions_total Central authorization decisions\n\
             # TYPE gateway_authz_decisions_total counter\n",
        );
        for ((mode, result), value) in &counters.authz {
            output.push_str(&format!(
                "gateway_authz_decisions_total{{mode=\"{}\",result=\"{}\"}} {value}\n",
                escape_label(mode),
                escape_label(result)
            ));
        }
        output
    }
}

pub const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}
