//! Rust-owned supervised agent.

pub(crate) mod checkpoint;
pub(crate) mod model;
pub(crate) mod policy;
pub(crate) mod tools;

#[allow(
    dead_code,
    reason = "The complete error contract is shared by later agent tasks"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentError {
    WorkspaceDenied,
    Busy,
    InvalidRequest,
    ModelUnavailable,
    ModelCannotCallTools,
    InferenceFailed,
    CloudConsentDeclined,
    CloudKeyRequired,
    CredentialStore,
    ProviderUnauthorized,
    ProviderRateLimited,
    ProviderUnavailable,
    ProviderNoPrivateRoute,
    PlanDeclined,
    TaskNotFound,
    CheckpointIo,
    RollbackIncomplete,
    Cancelled,
}

impl From<crate::ask::Error> for AgentError {
    fn from(error: crate::ask::Error) -> Self {
        use crate::ask::Error;
        match error {
            Error::InvalidLocalServer => Self::InvalidRequest,
            Error::ModelUnavailable => Self::ModelUnavailable,
            Error::CloudKeyRequired | Error::InvalidCloudKey => Self::CloudKeyRequired,
            Error::CredentialStore => Self::CredentialStore,
            Error::ProviderUnauthorized => Self::ProviderUnauthorized,
            Error::ProviderRateLimited => Self::ProviderRateLimited,
            Error::ProviderUnavailable => Self::ProviderUnavailable,
            Error::ProviderNoPrivateRoute => Self::ProviderNoPrivateRoute,
            _ => Self::InferenceFailed,
        }
    }
}
