//! The project lifecycle. A project moves forward one stage at a time and may go back to any
//! earlier stage for rework; it never skips ahead.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Discover,
    Scope,
    Access,
    Build,
    Evaluate,
    Deploy,
    Handoff,
    Operate,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StageError {
    #[error("cannot move from {from:?} to {to:?}: stages advance one at a time")]
    Skip { from: Stage, to: Stage },
    #[error("already in {0:?}")]
    Same(Stage),
}

impl Stage {
    pub const ALL: [Stage; 8] = [
        Stage::Discover,
        Stage::Scope,
        Stage::Access,
        Stage::Build,
        Stage::Evaluate,
        Stage::Deploy,
        Stage::Handoff,
        Stage::Operate,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Discover => "discover",
            Stage::Scope => "scope",
            Stage::Access => "access",
            Stage::Build => "build",
            Stage::Evaluate => "evaluate",
            Stage::Deploy => "deploy",
            Stage::Handoff => "handoff",
            Stage::Operate => "operate",
        }
    }

    pub fn next(self) -> Option<Stage> {
        Self::ALL.get(self.index() + 1).copied()
    }

    /// Checks a move. Forward by exactly one, or back to any earlier stage.
    pub fn transition(self, to: Stage) -> Result<Stage, StageError> {
        if to == self {
            Err(StageError::Same(self))
        } else if to < self || Some(to) == self.next() {
            Ok(to)
        } else {
            Err(StageError::Skip { from: self, to })
        }
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advances_one_stage_at_a_time() {
        assert_eq!(Stage::Discover.transition(Stage::Scope), Ok(Stage::Scope));
        assert_eq!(
            Stage::Discover.transition(Stage::Build),
            Err(StageError::Skip {
                from: Stage::Discover,
                to: Stage::Build
            })
        );
    }

    #[test]
    fn may_go_back_for_rework() {
        assert_eq!(Stage::Evaluate.transition(Stage::Build), Ok(Stage::Build));
        assert_eq!(Stage::Operate.transition(Stage::Discover), Ok(Stage::Discover));
    }

    #[test]
    fn refuses_a_no_op() {
        assert_eq!(
            Stage::Access.transition(Stage::Access),
            Err(StageError::Same(Stage::Access))
        );
    }

    #[test]
    fn last_stage_has_no_next() {
        assert_eq!(Stage::Operate.next(), None);
        assert_eq!(Stage::Handoff.next(), Some(Stage::Operate));
    }

    #[test]
    fn serialises_as_snake_case() {
        for s in Stage::ALL {
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{}\"", s.as_str()));
        }
    }
}
