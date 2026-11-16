// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! NGSI-LD projection layer — the security core of SynapseLDS.
//!
//! Three rules, enforced structurally (never by copy-then-delete):
//!   1. The serializer ONLY reads `entity.id`, `entity.type` and
//!      `attributes.*`. `_core/audit/security/storage/lineage` are never
//!      touched — new metadata fields can be added without any leak risk.
//!   2. Default deny: an attribute that is not registered in the dataset
//!      schema registry, or whose visibility is not exportable for the
//!      caller, is skipped. New dynamic fields never auto-publish.
//!   3. Reserved attribute names (id, type, @context, internalId, …) are
//!      rejected at registration time so dynamic fields can never squat
//!      on NGSI-LD identity slots.

use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const NGSI_LD_CORE_CONTEXT: &str =
    "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld";

/// Attribute names the registry refuses to store: they collide with NGSI-LD
/// identity members or platform-managed metadata. Checked case-insensitively.
pub const LDS_RESERVED_ATTRIBUTES: &[&str] = &[
    "id",
    "@id",
    "type",
    "@type",
    "context",
    "@context",
    "createdat",
    "modifiedat",
    "observedat",
    "datasetid",
    "instanceid",
    "scope",
    "internalid",
    "tenantid",
    "sourcerecordid",
    "_core",
    "ngsildid",
];

const NGSI_LD_TYPES: &[&str] = &["Property", "Relationship", "GeoProperty"];
const VISIBILITIES: &[&str] = &["public", "restricted", "internal"];
const UNSAFE_ATTRIBUTE_NAMES: &[&str] = &["__proto__", "constructor", "prototype"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAttribute {
    pub name: String,
    pub ngsi_ld_type: String,
    pub visibility: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_field: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredRecord {
    pub datasource_id: String,
    pub entity_id: String,
    pub source_record_id: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub core: Value,
    pub entity: Value,
    #[serde(default)]
    pub attributes: Value,
}

#[derive(Debug, Clone)]
pub struct DatasourceLike {
    pub id: String,
    pub entity_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct IngestPrincipal {
    pub sub: Option<String>,
    pub org: Option<String>,
    pub account: Option<String>,
}

#[derive(Debug, Clone)]
pub struct IngestResult {
    pub record: StoredRecord,
    pub quarantined: Vec<(String, String)>,
}

#[derive(Debug)]
pub struct ValidationError {
    pub error: String,
    pub message: String,
    pub reserved: Vec<String>,
}

fn attribute_name_re() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$").unwrap())
}

pub fn is_reserved_attribute_name(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    LDS_RESERVED_ATTRIBUTES.contains(&name.to_lowercase().as_str())
}

pub fn is_valid_attribute_name(name: &str) -> bool {
    attribute_name_re().is_match(name) && !UNSAFE_ATTRIBUTE_NAMES.contains(&name)
}

/// Validate + normalize a PUT /attributes registry payload.
pub fn validate_attribute_registry(
    input: &Value,
) -> Result<Vec<RegistryAttribute>, ValidationError> {
    let Some(items) = input.as_array() else {
        return Err(ValidationError {
            error: "invalid_attributes".into(),
            message: "attributes must be an array".into(),
            reserved: vec![],
        });
    };
    if items.len() > 200 {
        return Err(ValidationError {
            error: "invalid_attributes".into(),
            message: "attributes exceeds 200 entries".into(),
            reserved: vec![],
        });
    }
    let mut reserved = Vec::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in items {
        let Some(entry) = raw.as_object() else {
            return Err(ValidationError {
                error: "invalid_attributes".into(),
                message: "attributes[] entries must be objects".into(),
                reserved: vec![],
            });
        };
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !name.is_empty() && is_reserved_attribute_name(&name) {
            reserved.push(name);
            continue;
        }
        if name.is_empty() || !is_valid_attribute_name(&name) {
            return Err(ValidationError {
                error: "invalid_attribute_name".into(),
                message: format!(
                    "attribute name '{}' must match {}",
                    name.chars().take(64).collect::<String>(),
                    attribute_name_re().as_str()
                ),
                reserved: vec![],
            });
        }
        if !seen.insert(name.clone()) {
            return Err(ValidationError {
                error: "duplicate_attribute".into(),
                message: format!("duplicate attribute '{name}'"),
                reserved: vec![],
            });
        }
        let ngsi_ld_type = entry
            .get("ngsiLdType")
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "Property".into());
        if !NGSI_LD_TYPES.contains(&ngsi_ld_type.as_str()) {
            return Err(ValidationError {
                error: "invalid_attribute_type".into(),
                message: format!(
                    "attribute '{name}': ngsiLdType must be one of {}",
                    NGSI_LD_TYPES.join("|")
                ),
                reserved: vec![],
            });
        }
        let visibility = entry
            .get("visibility")
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "internal".into());
        if !VISIBILITIES.contains(&visibility.as_str()) {
            return Err(ValidationError {
                error: "invalid_visibility".into(),
                message: format!(
                    "attribute '{name}': visibility must be one of {}",
                    VISIBILITIES.join("|")
                ),
                reserved: vec![],
            });
        }
        let mut attribute = RegistryAttribute {
            name,
            ngsi_ld_type,
            visibility,
            description: None,
            source_field: None,
        };
        if let Some(description) = entry.get("description") {
            let text = match description {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            if text.chars().count() > 300 {
                return Err(ValidationError {
                    error: "invalid_attributes".into(),
                    message: format!("attribute '{}': description ≤300 chars", attribute.name),
                    reserved: vec![],
                });
            }
            attribute.description = Some(text);
        }
        if let Some(source_field) = entry.get("sourceField") {
            let text = match source_field {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            if text.is_empty() || text.chars().count() > 128 {
                return Err(ValidationError {
                    error: "invalid_attributes".into(),
                    message: format!(
                        "attribute '{}': sourceField 1..128 chars",
                        attribute.name
                    ),
                    reserved: vec![],
                });
            }
            attribute.source_field = Some(text);
        }
        out.push(attribute);
    }
    if !reserved.is_empty() {
        return Err(ValidationError {
            error: "reserved_attribute".into(),
            message: format!(
                "reserved attribute name(s) cannot be registered: {} — map them via sourceField instead",
                reserved.join(", ")
            ),
            reserved,
        });
    }
    Ok(out)
}

fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn build_entity_id(entity_type: &str, source_record_id: &str, override_id: Option<&str>) -> String {
    if let Some(override_id) = override_id {
        let trimmed = override_id.trim();
        let lower = trimmed.to_lowercase();
        if (lower.starts_with("urn:") || lower.starts_with("http://") || lower.starts_with("https://"))
            && trimmed.chars().count() <= 512
            && !trimmed.contains('\r')
            && !trimmed.contains('\n')
        {
            return trimmed.to_string();
        }
    }
    let entity_type = entity_type
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .collect::<String>();
    let id = encode_component(source_record_id)
        .chars()
        .take(256)
        .collect::<String>();
    format!(
        "urn:ngsi-ld:{}:{}",
        if entity_type.is_empty() {
            "Entity"
        } else {
            &entity_type
        },
        id
    )
}

fn is_iri(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.starts_with("urn:") || lower.starts_with("http://") || lower.starts_with("https://")
}

pub fn resolve_identity(
    datasource: &DatasourceLike,
    raw: &Map<String, Value>,
    previous: Option<&StoredRecord>,
) -> Result<(String, Option<String>, String), String> {
    let raw_type = raw.get("type").or_else(|| raw.get("@type"));
    let entity_type = raw_type
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(128).collect::<String>())
        .unwrap_or_else(|| datasource.entity_type.clone());
    let override_src = raw
        .get("ngsiLdId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            raw.get("@id")
                .and_then(Value::as_str)
                .filter(|value| is_iri(value))
                .map(str::to_string)
        });
    let source_record_id = match raw.get("id") {
        Some(Value::Null) | None => match raw.get("@id").and_then(Value::as_str) {
            Some(value) if !is_iri(value) => Some(value.to_string()),
            _ => previous.and_then(|record| record.source_record_id.clone()),
        },
        Some(value) => Some(match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }),
    };
    if source_record_id.is_none() && override_src.is_none() {
        return Err("record needs an 'id' (source id) or an explicit 'ngsiLdId'/'@id' IRI".into());
    }
    let entity_id = build_entity_id(
        &entity_type,
        source_record_id.as_deref().unwrap_or(""),
        override_src.as_deref(),
    );
    Ok((entity_id, source_record_id, entity_type))
}

pub fn to_ngsi_ld_attribute(
    name: &str,
    value: &Value,
    def: Option<&RegistryAttribute>,
) -> Result<Value, String> {
    if let Some(object) = value.as_object() {
        if let Some(Value::String(kind)) = object.get("type") {
            if NGSI_LD_TYPES.contains(&kind.as_str()) {
                return Ok(value.clone());
            }
        }
    }
    let kind = def
        .map(|attribute| attribute.ngsi_ld_type.as_str())
        .unwrap_or("Property");
    match kind {
        "Relationship" => {
            let object = match value {
                Value::String(text) => text.clone(),
                Value::Object(map) => map
                    .get("object")
                    .or_else(|| map.get("id"))
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default(),
                other => other.to_string(),
            };
            if object.is_empty() {
                return Err(format!(
                    "attribute '{name}': Relationship needs a non-empty object IRI"
                ));
            }
            Ok(json!({ "type": "Relationship", "object": object }))
        }
        "GeoProperty" => {
            if !value.is_object() {
                return Err(format!(
                    "attribute '{name}': GeoProperty needs a GeoJSON object"
                ));
            }
            Ok(json!({ "type": "GeoProperty", "value": value }))
        }
        _ => Ok(json!({ "type": "Property", "value": value })),
    }
}

const IDENTITY_KEYS: &[&str] = &["id", "@id", "type", "@type", "@context", "ngsildid", "sourceid"];

/// Map one raw connector record into the split storage model:
///   _core (private) + entity (public identity) + attributes (dynamic).
pub fn ingest_record(
    datasource: &DatasourceLike,
    registry: &[RegistryAttribute],
    raw: &Map<String, Value>,
    principal: Option<&IngestPrincipal>,
    previous: Option<&StoredRecord>,
) -> Result<IngestResult, String> {
    let mut quarantined = Vec::new();
    let (entity_id, source_record_id, entity_type) =
        resolve_identity(datasource, raw, previous)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut attributes = Map::new();
    for (key, value) in raw {
        let lower = key.to_lowercase();
        if IDENTITY_KEYS.contains(&lower.as_str()) {
            continue;
        }
        if is_reserved_attribute_name(key) {
            quarantined.push((
                key.clone(),
                "reserved name — platform metadata cannot be set by records".to_string(),
            ));
            continue;
        }
        if !is_valid_attribute_name(key) {
            quarantined.push((key.clone(), "invalid attribute name".to_string()));
            continue;
        }
        let def = registry
            .iter()
            .find(|attribute| attribute.name == *key || attribute.source_field.as_deref() == Some(key));
        match to_ngsi_ld_attribute(key, value, def) {
            Ok(attribute) => {
                let output_name = def.map(|attribute| attribute.name.clone()).unwrap_or_else(|| key.clone());
                attributes.insert(output_name, attribute);
            }
            Err(error) => quarantined.push((key.clone(), error.chars().take(200).collect())),
        }
    }
    let previous_core = previous.map(|record| &record.core);
    let mut core = Map::new();
    if let Some(internal_id) = previous_core.and_then(|core| core.get("internalId")) {
        core.insert("internalId".into(), internal_id.clone());
    }
    core.insert(
        "tenantId".into(),
        principal
            .and_then(|principal| principal.org.clone())
            .map(Value::String)
            .or_else(|| previous_core.and_then(|core| core.get("tenantId")).cloned())
            .unwrap_or(Value::Null),
    );
    core.insert(
        "accountId".into(),
        principal
            .and_then(|principal| principal.account.clone())
            .map(Value::String)
            .or_else(|| previous_core.and_then(|core| core.get("accountId")).cloned())
            .unwrap_or(Value::Null),
    );
    core.insert("datasourceId".into(), Value::String(datasource.id.clone()));
    core.insert(
        "sourceRecordId".into(),
        source_record_id
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    let version = previous.map(|record| record.version).unwrap_or(0) + 1;
    core.insert("version".into(), json!(version));
    core.insert(
        "ingestedBy".into(),
        principal
            .and_then(|principal| principal.sub.clone())
            .map(Value::String)
            .or_else(|| previous_core.and_then(|core| core.get("ingestedBy")).cloned())
            .unwrap_or(Value::Null),
    );
    core.insert(
        "createdAt".into(),
        previous_core
            .and_then(|core| core.get("createdAt"))
            .cloned()
            .unwrap_or_else(|| Value::String(now.clone())),
    );
    core.insert("updatedAt".into(), Value::String(now));
    Ok(IngestResult {
        record: StoredRecord {
            datasource_id: datasource.id.clone(),
            entity_id: entity_id.clone(),
            source_record_id,
            version,
            core: Value::Object(core),
            entity: json!({ "id": entity_id, "type": entity_type }),
            attributes: Value::Object(attributes),
        },
        quarantined,
    })
}

pub type ProjectionMode = &'static str;

/// STRUCTURAL ALLOWLIST — the only function allowed to turn a stored record
/// into an API payload. It builds a fresh object from entity + registry-
/// approved attributes and never reads `_core` (or any other region).
pub fn project_entity(
    record: &StoredRecord,
    registry: &[RegistryAttribute],
    context_urls: &[String],
    mode: ProjectionMode,
) -> Value {
    let restricted = mode == "restricted";
    let mut out = Map::new();
    let entity_id = record
        .entity
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&record.entity_id);
    let entity_type = record
        .entity
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");
    out.insert("id".into(), Value::String(entity_id.to_string()));
    out.insert("type".into(), Value::String(entity_type.to_string()));
    if let Some(attributes) = record.attributes.as_object() {
        for (name, attribute) in attributes {
            if is_reserved_attribute_name(name) {
                continue;
            }
            let Some(def) = registry.iter().find(|entry| entry.name == *name) else {
                continue;
            };
            let allowed = if restricted {
                matches!(def.visibility.as_str(), "public" | "restricted")
            } else {
                def.visibility == "public"
            };
            if allowed {
                out.insert(name.clone(), attribute.clone());
            }
        }
    }
    let mut contexts = vec![Value::String(NGSI_LD_CORE_CONTEXT.to_string())];
    contexts.extend(context_urls.iter().cloned().map(Value::String));
    out.insert("@context".into(), Value::Array(contexts));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Vec<RegistryAttribute> {
        vec![
            RegistryAttribute {
                name: "name".into(),
                ngsi_ld_type: "Property".into(),
                visibility: "public".into(),
                description: None,
                source_field: None,
            },
            RegistryAttribute {
                name: "ownerEmail".into(),
                ngsi_ld_type: "Property".into(),
                visibility: "restricted".into(),
                description: None,
                source_field: Some("email".into()),
            },
            RegistryAttribute {
                name: "secret".into(),
                ngsi_ld_type: "Property".into(),
                visibility: "internal".into(),
                description: None,
                source_field: None,
            },
        ]
    }

    #[test]
    fn reserved_names_are_rejected() {
        let error = validate_attribute_registry(&json!([{"name": "id"}])).unwrap_err();
        assert_eq!(error.error, "reserved_attribute");
        assert_eq!(error.reserved, vec!["id"]);
    }

    #[test]
    fn projection_is_default_deny_and_never_leaks_core() {
        let record = StoredRecord {
            datasource_id: "ds1".into(),
            entity_id: "urn:ngsi-ld:Organization:1".into(),
            source_record_id: Some("1".into()),
            version: 1,
            core: json!({"internalId": "secret-internal", "tenantId": "org:a"}),
            entity: json!({"id": "urn:ngsi-ld:Organization:1", "type": "Organization"}),
            attributes: json!({
                "name": {"type": "Property", "value": "ACME"},
                "ownerEmail": {"type": "Property", "value": "ops@acme.test"},
                "secret": {"type": "Property", "value": "hidden"},
                "unregistered": {"type": "Property", "value": "nope"},
            }),
        };
        let public = project_entity(&record, &registry(), &[], "public");
        assert_eq!(public["name"]["value"], "ACME");
        assert!(public.get("ownerEmail").is_none());
        assert!(public.get("secret").is_none());
        assert!(public.get("unregistered").is_none());
        assert!(!public.to_string().contains("secret-internal"));
        let restricted = project_entity(&record, &registry(), &["https://ctx.example/".into()], "restricted");
        assert_eq!(restricted["ownerEmail"]["value"], "ops@acme.test");
        assert!(restricted.get("secret").is_none());
    }

    #[test]
    fn identity_derives_a_urn_and_keeps_source_id() {
        let datasource = DatasourceLike {
            id: "ds1".into(),
            entity_type: "Organization".into(),
        };
        let mut raw = Map::new();
        raw.insert("id".into(), json!("55001"));
        raw.insert("name".into(), json!("ACME"));
        let (entity_id, source_id, entity_type) =
            resolve_identity(&datasource, &raw, None).unwrap();
        assert_eq!(entity_id, "urn:ngsi-ld:Organization:55001");
        assert_eq!(source_id.as_deref(), Some("55001"));
        assert_eq!(entity_type, "Organization");
    }
}
