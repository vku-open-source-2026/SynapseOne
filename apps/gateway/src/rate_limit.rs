// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! In-memory edge rate limiting. Lazy expiry avoids a background timer; a hard
//! key cap prevents a source-IP spray from growing the map forever.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const WINDOW: Duration = Duration::from_secs(60);
const HITS_MAX: usize = 50_000;

struct Bucket {
    count: u64,
    reset: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LimitResult {
    Allowed,
    Limited { retry_after: u64 },
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
    window: Duration,
    max_keys: usize,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            window: WINDOW,
            max_keys: HITS_MAX,
        }
    }

    pub fn hit(&self, key: &str, max: u64) -> LimitResult {
        self.hit_at(key, max, Instant::now())
    }

    pub fn hit_at(&self, key: &str, max: u64, now: Instant) -> LimitResult {
        let mut buckets = self.buckets.lock().expect("rate limiter");
        if buckets.len() > self.max_keys {
            buckets.retain(|_, bucket| bucket.reset >= now);
            if buckets.len() > self.max_keys {
                // Pathological spray: fail open for one window rather than
                // growing without bound.
                buckets.clear();
            }
        }
        let bucket_key = format!("{key}:{max}");
        match buckets.get_mut(&bucket_key) {
            None => {
                buckets.insert(
                    bucket_key,
                    Bucket {
                        count: 1,
                        reset: now + self.window,
                    },
                );
                LimitResult::Allowed
            }
            Some(bucket) if bucket.reset < now => {
                bucket.count = 1;
                bucket.reset = now + self.window;
                LimitResult::Allowed
            }
            Some(bucket) => {
                bucket.count += 1;
                if bucket.count > max {
                    let remaining = bucket.reset.saturating_duration_since(now);
                    let retry_after = remaining.as_millis().div_ceil(1000).max(1) as u64;
                    LimitResult::Limited { retry_after }
                } else {
                    LimitResult::Allowed
                }
            }
        }
    }
}
