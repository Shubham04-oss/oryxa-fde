//! What a project needs before it leaves each stage (`docs/direction.md` section 4). Only checks
//! the store can work out from records that already exist are here; the store evaluates them.
//! A checklist guides, it does not trap: a forward move with a check open needs a reason.

use crate::Stage;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Check {
    StakeholdersNamed,
    DiscoveryNotes,
    ScopeSignedOff,
    OutOfScopeListed,
    CriteriaHaveTargets,
    AccessGranted,
    CriteriaHaveEvals,
    CriteriaMet,
}

impl Check {
    pub const ALL: [Check; 8] = [
        Check::StakeholdersNamed,
        Check::DiscoveryNotes,
        Check::ScopeSignedOff,
        Check::OutOfScopeListed,
        Check::CriteriaHaveTargets,
        Check::AccessGranted,
        Check::CriteriaHaveEvals,
        Check::CriteriaMet,
    ];

    /// The stage this check must be met to leave.
    pub fn stage(self) -> Stage {
        match self {
            Check::StakeholdersNamed | Check::DiscoveryNotes => Stage::Discover,
            Check::ScopeSignedOff | Check::OutOfScopeListed | Check::CriteriaHaveTargets => Stage::Scope,
            Check::AccessGranted => Stage::Access,
            Check::CriteriaHaveEvals => Stage::Build,
            Check::CriteriaMet => Stage::Evaluate,
        }
    }

    /// A stable key: clients and the audit log refer to the check by it, so it never changes.
    pub fn key(self) -> &'static str {
        match self {
            Check::StakeholdersNamed => "stakeholders_named",
            Check::DiscoveryNotes => "discovery_notes",
            Check::ScopeSignedOff => "scope_signed_off",
            Check::OutOfScopeListed => "out_of_scope_listed",
            Check::CriteriaHaveTargets => "criteria_have_targets",
            Check::AccessGranted => "access_granted",
            Check::CriteriaHaveEvals => "criteria_have_evals",
            Check::CriteriaMet => "criteria_met",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Check::StakeholdersNamed => "Stakeholders named",
            Check::DiscoveryNotes => "A meeting note on the project",
            Check::ScopeSignedOff => "Scope signed off, and unchanged since",
            Check::OutOfScopeListed => "What is out of scope is listed",
            Check::CriteriaHaveTargets => "Success criteria set, each with a target",
            Check::AccessGranted => "Every access request granted",
            Check::CriteriaHaveEvals => "An eval suite measures every criterion",
            Check::CriteriaMet => "Every criterion meets its target",
        }
    }
}

impl Stage {
    /// The checks to leave this stage, in the order they are shown. Empty where nothing the
    /// product records yet can be checked.
    pub fn checklist(self) -> Vec<Check> {
        Check::ALL.into_iter().filter(|c| c.stage() == self).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn each_stage_lists_its_own_checks() {
        assert_eq!(
            Stage::Discover.checklist(),
            [Check::StakeholdersNamed, Check::DiscoveryNotes]
        );
        assert_eq!(
            Stage::Scope.checklist(),
            [
                Check::ScopeSignedOff,
                Check::OutOfScopeListed,
                Check::CriteriaHaveTargets
            ]
        );
        assert_eq!(Stage::Access.checklist(), [Check::AccessGranted]);
        assert_eq!(Stage::Build.checklist(), [Check::CriteriaHaveEvals]);
        assert_eq!(Stage::Evaluate.checklist(), [Check::CriteriaMet]);
        for s in [Stage::Deploy, Stage::Handoff, Stage::Operate] {
            assert!(s.checklist().is_empty(), "{s:?}");
        }
        let listed: usize = Stage::ALL.iter().map(|s| s.checklist().len()).sum();
        assert_eq!(listed, Check::ALL.len());
    }

    #[test]
    fn keys_are_unique_snake_case() {
        let keys: HashSet<_> = Check::ALL.iter().map(|c| c.key()).collect();
        assert_eq!(keys.len(), Check::ALL.len());
        for k in keys {
            assert!(k.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{k}");
        }
    }
}
