//! The lifecycle engine. A consumer of FDE events, one at a time and in order per project (SQS
//! FIFO), applies plain rules through the store ([`rules`]); once a week it drafts each active
//! project's update through the model in config ([`drafts`]). Rules are deterministic and acted on
//! once per event; the model writes text only, and nothing is sent without an FDE's approval.
//! An approved update goes to the customer's sponsors as the weekly digest ([`digest`]).

use std::future::Future;
use std::pin::Pin;

use oryxa_fde_store::StoreError;

pub mod digest;
pub mod drafts;
pub mod rules;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    #[error("store: {0}")]
    Store(#[from] StoreError),
    #[error("model: {0}")]
    Model(String),
    #[error("mail: {0}")]
    Mail(String),
    #[error("config: {0}")]
    Config(&'static str),
}
