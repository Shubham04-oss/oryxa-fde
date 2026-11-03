//! Tenant-qualified SpiceDB object ids. Every id is `<tenant>|<id>`; `|` cannot appear in
//! a tenant id, so objects of different tenants can never collide.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use oryxa_core::TenantId;
use oryxa_spicedb_proto::v1;

/// External ids (Bedrock document ids, URLs) are base64url-encoded behind a `=` prefix;
/// `=` is outside the raw-id charset, so encoded and raw ids cannot collide.
const ENCODED: char = '=';

fn is_raw(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectRef {
    pub tenant: TenantId,
    pub kind: &'static str,
    id: String,
}

impl ObjectRef {
    /// `id` may be anything; unsafe ids are encoded transparently.
    pub fn new(tenant: &TenantId, kind: &'static str, id: &str) -> Self {
        let id = if is_raw(id) {
            id.to_owned()
        } else {
            format!("{ENCODED}{}", URL_SAFE_NO_PAD.encode(id))
        };
        Self {
            tenant: tenant.clone(),
            kind,
            id,
        }
    }

    /// The id as the caller gave it.
    pub fn id(&self) -> String {
        decode_id(&self.id)
    }

    pub(crate) fn object_id(&self) -> String {
        format!("{}|{}", self.tenant, self.id)
    }

    pub(crate) fn to_proto(&self) -> v1::ObjectReference {
        v1::ObjectReference {
            object_type: self.kind.to_owned(),
            object_id: self.object_id(),
        }
    }
}

fn decode_id(id: &str) -> String {
    match id.strip_prefix(ENCODED).and_then(|b| URL_SAFE_NO_PAD.decode(b).ok()) {
        Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        None => id.to_owned(),
    }
}

/// Turn a SpiceDB object id back into the caller's id; `None` if it belongs to another tenant.
pub(crate) fn strip_tenant(tenant: &TenantId, object_id: &str) -> Option<String> {
    let rest = object_id.strip_prefix(tenant.as_str())?.strip_prefix('|')?;
    Some(decode_id(rest))
}

/// `user:t|u1` or a subject set such as `team:t|eng#member`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubjectRef {
    pub object: ObjectRef,
    pub relation: Option<&'static str>,
}

impl SubjectRef {
    pub fn object(object: ObjectRef) -> Self {
        Self { object, relation: None }
    }
    pub fn set(object: ObjectRef, relation: &'static str) -> Self {
        Self {
            object,
            relation: Some(relation),
        }
    }
    pub(crate) fn to_proto(&self) -> v1::SubjectReference {
        v1::SubjectReference {
            object: Some(self.object.to_proto()),
            optional_relation: self.relation.unwrap_or_default().to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_tenant_qualified_and_round_trip() {
        let t = TenantId::new("org_1").unwrap();
        let doc = ObjectRef::new(&t, "kb_item", "doc-1");
        assert_eq!(doc.object_id(), "org_1|doc-1");

        let url = "https://acme.sharepoint.com/sites/x/a b.docx";
        let ext = ObjectRef::new(&t, "kb_item", url);
        assert!(ext.object_id().starts_with("org_1|="));
        assert!(
            ext.object_id()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"|_-=".contains(&b))
        );
        assert_eq!(ext.id(), url);
        assert_eq!(strip_tenant(&t, &ext.object_id()).as_deref(), Some(url));

        let other = TenantId::new("org_2").unwrap();
        assert_eq!(strip_tenant(&other, &doc.object_id()), None);
        // Prefix overlap must not leak across tenants.
        let org_11 = TenantId::new("org_11").unwrap();
        assert_eq!(
            strip_tenant(&t, &ObjectRef::new(&org_11, "kb_item", "x").object_id()),
            None
        );
    }
}
