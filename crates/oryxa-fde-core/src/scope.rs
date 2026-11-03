//! Every company-scoped call takes a [`CompanyScope`], so no query, permission check or event can
//! be built without both the tenant and the company.

use oryxa_core::TenantId;
use serde::{Deserialize, Serialize};

use crate::{CompanyId, ProjectId};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CompanyScope {
    pub tenant: TenantId,
    pub company: CompanyId,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProjectScope {
    pub company: CompanyScope,
    pub project: ProjectId,
}

impl CompanyScope {
    pub fn new(tenant: TenantId, company: CompanyId) -> Self {
        Self { tenant, company }
    }

    pub fn project(&self, project: ProjectId) -> ProjectScope {
        ProjectScope {
            company: self.clone(),
            project,
        }
    }

    /// FIFO group for this company's events on the bus: `<tenant>/<company>`.
    pub fn event_group(&self) -> String {
        format!("{}/{}", self.tenant, self.company)
    }
}

impl ProjectScope {
    pub fn tenant(&self) -> &TenantId {
        &self.company.tenant
    }

    /// FIFO group for this project's events: `<tenant>/<project>`, so one project stays in order
    /// without serialising the whole company behind it.
    pub fn event_group(&self) -> String {
        format!("{}/{}", self.company.tenant, self.project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_groups_carry_tenant_and_entity() {
        let c = CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap());
        let p = c.project(ProjectId::new("prj_1").unwrap());
        assert_eq!(c.event_group(), "org_1/cmp_1");
        assert_eq!(p.event_group(), "org_1/prj_1");
        assert_eq!(p.tenant().as_str(), "org_1");
    }
}
