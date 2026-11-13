// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Built-in license catalog for SynapseLDS datasets.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LdsLicense {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub open_data: bool,
}

pub const LDS_LICENSES: &[LdsLicense] = &[
    LdsLicense {
        id: "CC0-1.0",
        name: "Creative Commons Zero v1.0 Universal (public domain dedication)",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        open_data: true,
    },
    LdsLicense {
        id: "PDDL-1.0",
        name: "Open Data Commons Public Domain Dedication and License v1.0",
        url: "https://opendatacommons.org/licenses/pddl/1.0/",
        open_data: true,
    },
    LdsLicense {
        id: "CC-BY-4.0",
        name: "Creative Commons Attribution 4.0 International",
        url: "https://creativecommons.org/licenses/by/4.0/",
        open_data: true,
    },
    LdsLicense {
        id: "CC-BY-SA-4.0",
        name: "Creative Commons Attribution-ShareAlike 4.0 International",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
        open_data: true,
    },
    LdsLicense {
        id: "ODbL-1.0",
        name: "Open Data Commons Open Database License v1.0",
        url: "https://opendatacommons.org/licenses/odbl/1.0/",
        open_data: true,
    },
    LdsLicense {
        id: "LicenseRef-Proprietary",
        name: "Proprietary / internal use only (not open data)",
        url: "https://synapseone.space/licenses/proprietary",
        open_data: false,
    },
];

pub fn find_license(id: &str) -> Option<&'static LdsLicense> {
    LDS_LICENSES.iter().find(|license| license.id == id)
}

/// Custom license ids stay namespaced (`LicenseRef-*`) so they can never
/// shadow a built-in SPDX entry.
pub fn is_custom_license_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("LicenseRef-") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 128
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}
