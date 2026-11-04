//! Whether an agent may act through a provider connection held by the credential broker.

use oryxa_core::{AgentId, ConnectionId, TenantId, UserId};

use crate::ids::{ObjectRef, SubjectRef};
use crate::spicedb::{AuthzError, CheckItem, Consistency, SpiceDb};

/// Whether `agent` (acting for `acting_for`) may act through a connection: `connection#use` for
/// the agent, and for a personal connection, acting for its owner. The broker asks this before it
/// issues an egress handle.
pub async fn may_use_connection(
    spicedb: &SpiceDb,
    tenant: &TenantId,
    connection: &ConnectionId,
    agent: &AgentId,
    acting_for: &UserId,
    personal_owner: Option<&UserId>,
    consistency: &Consistency,
) -> Result<bool, AuthzError> {
    if personal_owner.is_some_and(|o| o != acting_for) {
        return Ok(false);
    }
    let check = CheckItem {
        resource: ObjectRef::new(tenant, "connection", connection.as_str()),
        permission: "use",
        subject: SubjectRef::object(ObjectRef::new(tenant, "agent", agent.as_str())),
        context: None,
    };
    Ok(spicedb.check(tenant, &check, consistency).await?.allowed())
}
