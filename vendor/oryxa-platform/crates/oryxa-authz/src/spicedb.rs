//! The only door to SpiceDB. Every call names a tenant and is refused before it leaves
//! the process if any object belongs to another tenant. Anything but a clean "has
//! permission" is a deny.

use std::time::{Duration, SystemTime};

use oryxa_core::TenantId;
use oryxa_spicedb_proto::v1::{
    self, check_bulk_permissions_pair, check_permission_response::Permissionship, consistency::Requirement,
    permissions_service_client::PermissionsServiceClient, precondition, relationship_update,
};
use tonic::metadata::MetadataValue;
use tonic::service::interceptor::InterceptedService;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};

use crate::ids::{ObjectRef, SubjectRef, strip_tenant};

/// SpiceDB's hard limit per CheckBulkPermissions call.
const MAX_BULK: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum AuthzError {
    #[error("object {0} does not belong to tenant {1}")]
    TenantMismatch(String, String),
    #[error("caveat context must be a JSON object")]
    BadContext,
    #[error("spicedb: {0}")]
    Rpc(#[from] tonic::Status),
    #[error("connect: {0}")]
    Connect(#[from] tonic::transport::Error),
    #[error("invalid preshared key")]
    BadKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    /// Caveat context was missing; treated as deny.
    Conditional {
        missing: Vec<String>,
    },
    /// Per-item error from a bulk check; treated as deny.
    Error(String),
}

impl Decision {
    pub fn allowed(&self) -> bool {
        matches!(self, Decision::Allow)
    }

    fn from_permissionship(p: i32, caveat: Option<v1::PartialCaveatInfo>) -> Self {
        match Permissionship::try_from(p) {
            Ok(Permissionship::HasPermission) => Decision::Allow,
            Ok(Permissionship::ConditionalPermission) => Decision::Conditional {
                missing: caveat.map(|c| c.missing_required_context).unwrap_or_default(),
            },
            _ => Decision::Deny,
        }
    }
}

/// Opaque SpiceDB revision; store it next to the resource after a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZedToken(pub String);

#[derive(Debug, Clone)]
pub enum Consistency {
    MinimizeLatency,
    AtLeastAsFresh(ZedToken),
    /// Bypasses SpiceDB's cache. Too slow for the hot path; for tests and audits that must see the latest write.
    FullyConsistent,
}

impl Consistency {
    fn to_proto(&self) -> v1::Consistency {
        let requirement = match self {
            Consistency::MinimizeLatency => Requirement::MinimizeLatency(true),
            Consistency::AtLeastAsFresh(t) => Requirement::AtLeastAsFresh(v1::ZedToken { token: t.0.clone() }),
            Consistency::FullyConsistent => Requirement::FullyConsistent(true),
        };
        v1::Consistency {
            requirement: Some(requirement),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CheckItem {
    pub resource: ObjectRef,
    pub permission: &'static str,
    pub subject: SubjectRef,
    /// Caveat context (e.g. args hash, now); must be a JSON object.
    pub context: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct Relationship {
    pub resource: ObjectRef,
    pub relation: &'static str,
    pub subject: SubjectRef,
    pub caveat: Option<(&'static str, serde_json::Value)>,
    pub expires_at: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub enum Write {
    /// Idempotent upsert, safe to retry.
    Touch(Relationship),
    Delete(Relationship),
}

/// Exact-relationship precondition; a failed one rolls back the whole write.
#[derive(Debug, Clone)]
pub enum Precondition {
    MustExist(Relationship),
    MustNotExist(Relationship),
}

#[derive(Clone)]
pub struct BearerAuth(MetadataValue<tonic::metadata::Ascii>);

impl tonic::service::Interceptor for BearerAuth {
    fn call(&mut self, mut req: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
        req.metadata_mut().insert("authorization", self.0.clone());
        Ok(req)
    }
}

#[derive(Clone)]
pub struct SpiceDb {
    client: PermissionsServiceClient<InterceptedService<Channel, BearerAuth>>,
    timeout: Duration,
}

impl SpiceDb {
    /// `endpoint` like `https://spicedb.internal:50051` (TLS) or `http://localhost:50051` (tests).
    pub async fn connect(endpoint: &str, preshared_key: &str, timeout: Duration) -> Result<Self, AuthzError> {
        let (ep, auth) = dial_config(endpoint, preshared_key)?;
        let client = PermissionsServiceClient::with_interceptor(ep.connect().await?, auth);
        Ok(Self { client, timeout })
    }

    /// Same as `connect` but dials on first use; lets callers start before SpiceDB is reachable.
    pub fn connect_lazy(endpoint: &str, preshared_key: &str, timeout: Duration) -> Result<Self, AuthzError> {
        let (ep, auth) = dial_config(endpoint, preshared_key)?;
        let client = PermissionsServiceClient::with_interceptor(ep.connect_lazy(), auth);
        Ok(Self { client, timeout })
    }

    fn request<T>(&self, msg: T) -> tonic::Request<T> {
        let mut req = tonic::Request::new(msg);
        req.set_timeout(self.timeout);
        req
    }

    pub async fn check(
        &self,
        tenant: &TenantId,
        item: &CheckItem,
        consistency: &Consistency,
    ) -> Result<Decision, AuthzError> {
        guard_item(tenant, item)?;
        let resp = self
            .client
            .clone()
            .check_permission(self.request(v1::CheckPermissionRequest {
                consistency: Some(consistency.to_proto()),
                resource: Some(item.resource.to_proto()),
                permission: item.permission.to_owned(),
                subject: Some(item.subject.to_proto()),
                context: to_struct(item.context.as_ref())?,
                with_tracing: false,
            }))
            .await?
            .into_inner();
        Ok(Decision::from_permissionship(
            resp.permissionship,
            resp.partial_caveat_info,
        ))
    }

    /// Results come back in request order. Chunked at SpiceDB's 10,000-item cap.
    pub async fn check_bulk(
        &self,
        tenant: &TenantId,
        items: &[CheckItem],
        consistency: &Consistency,
    ) -> Result<Vec<Decision>, AuthzError> {
        items.iter().try_for_each(|i| guard_item(tenant, i))?;
        let mut out = Vec::with_capacity(items.len());
        for chunk in items.chunks(MAX_BULK) {
            let req_items = chunk
                .iter()
                .map(|i| {
                    Ok(v1::CheckBulkPermissionsRequestItem {
                        resource: Some(i.resource.to_proto()),
                        permission: i.permission.to_owned(),
                        subject: Some(i.subject.to_proto()),
                        context: to_struct(i.context.as_ref())?,
                    })
                })
                .collect::<Result<Vec<_>, AuthzError>>()?;
            let resp = self
                .client
                .clone()
                .check_bulk_permissions(self.request(v1::CheckBulkPermissionsRequest {
                    consistency: Some(consistency.to_proto()),
                    items: req_items,
                    with_tracing: false,
                }))
                .await?
                .into_inner();
            if resp.pairs.len() != chunk.len() {
                return Err(AuthzError::Rpc(tonic::Status::internal(
                    "bulk check returned a different item count",
                )));
            }
            out.extend(resp.pairs.into_iter().map(|p| match p.response {
                Some(check_bulk_permissions_pair::Response::Item(i)) => {
                    Decision::from_permissionship(i.permissionship, i.partial_caveat_info)
                }
                Some(check_bulk_permissions_pair::Response::Error(e)) => Decision::Error(e.message),
                None => Decision::Error("empty response".into()),
            }));
        }
        Ok(out)
    }

    /// Atomic write; returns the revision to store for later `AtLeastAsFresh` reads.
    pub async fn write(
        &self,
        tenant: &TenantId,
        writes: &[Write],
        preconditions: &[Precondition],
    ) -> Result<ZedToken, AuthzError> {
        let updates = writes
            .iter()
            .map(|w| {
                let (op, rel) = match w {
                    Write::Touch(r) => (relationship_update::Operation::Touch, r),
                    Write::Delete(r) => (relationship_update::Operation::Delete, r),
                };
                Ok(v1::RelationshipUpdate {
                    operation: op as i32,
                    relationship: Some(rel_to_proto(tenant, rel)?),
                })
            })
            .collect::<Result<Vec<_>, AuthzError>>()?;
        let optional_preconditions = preconditions
            .iter()
            .map(|p| {
                let (op, rel) = match p {
                    Precondition::MustExist(r) => (precondition::Operation::MustMatch, r),
                    Precondition::MustNotExist(r) => (precondition::Operation::MustNotMatch, r),
                };
                guard_rel(tenant, rel)?;
                Ok(v1::Precondition {
                    operation: op as i32,
                    filter: Some(exact_filter(rel)),
                })
            })
            .collect::<Result<Vec<_>, AuthzError>>()?;
        let resp = self
            .client
            .clone()
            .write_relationships(self.request(v1::WriteRelationshipsRequest {
                updates,
                optional_preconditions,
                optional_transaction_metadata: None,
            }))
            .await?
            .into_inner();
        Ok(ZedToken(resp.written_at.map(|t| t.token).unwrap_or_default()))
    }

    /// Ids (as given at write time) of `kind` objects on which `subject` has `permission`.
    /// Use for small result sets (e.g. a user's KB sources); post-filter large ones with `check_bulk`.
    pub async fn lookup_resources(
        &self,
        tenant: &TenantId,
        kind: &'static str,
        permission: &'static str,
        subject: &SubjectRef,
        consistency: &Consistency,
    ) -> Result<Vec<String>, AuthzError> {
        guard(tenant, &subject.object)?;
        let mut stream = self
            .client
            .clone()
            .lookup_resources(self.request(v1::LookupResourcesRequest {
                consistency: Some(consistency.to_proto()),
                resource_object_type: kind.to_owned(),
                permission: permission.to_owned(),
                subject: Some(subject.to_proto()),
                context: None,
                optional_limit: 0,
                optional_cursor: None,
                with_debug: false,
            }))
            .await?
            .into_inner();
        let mut ids = Vec::new();
        while let Some(r) = stream.message().await? {
            // Conditional results are dropped, same as a deny.
            if r.permissionship == v1::LookupPermissionship::HasPermission as i32
                && let Some(id) = strip_tenant(tenant, &r.resource_object_id)
            {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}

fn dial_config(endpoint: &str, preshared_key: &str) -> Result<(Endpoint, BearerAuth), AuthzError> {
    let mut ep = Endpoint::from_shared(endpoint.to_owned())?.connect_timeout(Duration::from_secs(5));
    if endpoint.starts_with("https://") {
        ep = ep.tls_config(ClientTlsConfig::new().with_native_roots())?;
    }
    let bearer = MetadataValue::try_from(format!("Bearer {preshared_key}")).map_err(|_| AuthzError::BadKey)?;
    Ok((ep, BearerAuth(bearer)))
}

fn guard(tenant: &TenantId, obj: &ObjectRef) -> Result<(), AuthzError> {
    if &obj.tenant == tenant {
        Ok(())
    } else {
        Err(AuthzError::TenantMismatch(obj.object_id(), tenant.to_string()))
    }
}

fn guard_item(tenant: &TenantId, item: &CheckItem) -> Result<(), AuthzError> {
    guard(tenant, &item.resource)?;
    guard(tenant, &item.subject.object)
}

fn guard_rel(tenant: &TenantId, rel: &Relationship) -> Result<(), AuthzError> {
    guard(tenant, &rel.resource)?;
    guard(tenant, &rel.subject.object)
}

fn rel_to_proto(tenant: &TenantId, rel: &Relationship) -> Result<v1::Relationship, AuthzError> {
    guard_rel(tenant, rel)?;
    let optional_caveat = match &rel.caveat {
        Some((name, ctx)) => Some(v1::ContextualizedCaveat {
            caveat_name: (*name).to_owned(),
            context: to_struct(Some(ctx))?,
        }),
        None => None,
    };
    Ok(v1::Relationship {
        resource: Some(rel.resource.to_proto()),
        relation: rel.relation.to_owned(),
        subject: Some(rel.subject.to_proto()),
        optional_caveat,
        optional_expires_at: rel.expires_at.map(prost_types::Timestamp::from),
    })
}

fn exact_filter(rel: &Relationship) -> v1::RelationshipFilter {
    v1::RelationshipFilter {
        resource_type: rel.resource.kind.to_owned(),
        optional_resource_id: rel.resource.object_id(),
        optional_relation: rel.relation.to_owned(),
        optional_subject_filter: Some(v1::SubjectFilter {
            subject_type: rel.subject.object.kind.to_owned(),
            optional_subject_id: rel.subject.object.object_id(),
            optional_relation: rel
                .subject
                .relation
                .map(|r| v1::subject_filter::RelationFilter { relation: r.to_owned() }),
        }),
        ..Default::default()
    }
}

fn to_struct(value: Option<&serde_json::Value>) -> Result<Option<prost_types::Struct>, AuthzError> {
    match value {
        None => Ok(None),
        Some(serde_json::Value::Object(map)) => Ok(Some(prost_types::Struct {
            fields: map.iter().map(|(k, v)| (k.clone(), to_value(v))).collect(),
        })),
        Some(_) => Err(AuthzError::BadContext),
    }
}

fn to_value(v: &serde_json::Value) -> prost_types::Value {
    use prost_types::value::Kind;
    use serde_json::Value as J;
    let kind = match v {
        J::Null => Kind::NullValue(0),
        J::Bool(b) => Kind::BoolValue(*b),
        J::Number(n) => Kind::NumberValue(n.as_f64().unwrap_or_default()),
        J::String(s) => Kind::StringValue(s.clone()),
        J::Array(a) => Kind::ListValue(prost_types::ListValue {
            values: a.iter().map(to_value).collect(),
        }),
        J::Object(m) => Kind::StructValue(prost_types::Struct {
            fields: m.iter().map(|(k, v)| (k.clone(), to_value(v))).collect(),
        }),
    };
    prost_types::Value { kind: Some(kind) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(s: &str) -> TenantId {
        TenantId::new(s).unwrap()
    }

    #[test]
    fn decisions_fail_closed() {
        assert!(Decision::from_permissionship(Permissionship::HasPermission as i32, None).allowed());
        assert!(!Decision::from_permissionship(Permissionship::NoPermission as i32, None).allowed());
        assert!(!Decision::from_permissionship(Permissionship::Unspecified as i32, None).allowed());
        assert!(!Decision::from_permissionship(99, None).allowed());
        let caveat = v1::PartialCaveatInfo {
            missing_required_context: vec!["args_hash".into()],
        };
        let d = Decision::from_permissionship(Permissionship::ConditionalPermission as i32, Some(caveat));
        assert_eq!(
            d,
            Decision::Conditional {
                missing: vec!["args_hash".into()]
            }
        );
        assert!(!d.allowed());
    }

    #[test]
    fn cross_tenant_objects_are_refused_locally() {
        let (a, b) = (t("org_a"), t("org_b"));
        let item = CheckItem {
            resource: ObjectRef::new(&a, "kb_item", "doc"),
            permission: "view",
            subject: SubjectRef::object(ObjectRef::new(&b, "user", "u1")),
            context: None,
        };
        assert!(matches!(guard_item(&a, &item), Err(AuthzError::TenantMismatch(..))));
        assert!(matches!(guard_item(&b, &item), Err(AuthzError::TenantMismatch(..))));
    }

    #[test]
    fn context_must_be_an_object() {
        assert!(to_struct(Some(&json!({"args_hash": "abc", "n": 1}))).unwrap().is_some());
        assert!(matches!(to_struct(Some(&json!("abc"))), Err(AuthzError::BadContext)));
    }
}
