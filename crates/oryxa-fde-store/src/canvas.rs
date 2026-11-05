//! Canvas snapshots and shape links. A company has one canvas and so does each project; every save
//! is a new version, written only on top of the latest, so two editors cannot overwrite each other
//! unseen. The snapshot is the canvas library's scene, opaque here: small ones are stored inline,
//! larger ones in S3 (the caller puts them there and names the key).

use oryxa_core::UserId;
use oryxa_fde_core::{AccessRequestId, ScopeItemId, StakeholderId};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::ids::{ShapeId, SnapshotId};
use crate::plan::{AT, PlanTx};
use crate::{Actor, StoreError, id, unique_violation};

/// Snapshots up to this size are stored in Postgres; larger ones in S3.
pub const INLINE_SNAPSHOT_BYTES: usize = 256 * 1024;

/// Where a snapshot's bytes are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotBody {
    Inline(Vec<u8>),
    /// An S3 key under the company's prefix.
    Blob(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMeta {
    pub version: u32,
    pub id: SnapshotId,
    pub size_bytes: u32,
    /// Of the bytes, hex: checked when a snapshot is read back from S3.
    pub sha256: String,
    pub saved_by: UserId,
    pub saved_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub meta: SnapshotMeta,
    pub body: SnapshotBody,
}

#[derive(Debug, Clone)]
pub struct SnapshotIn {
    pub id: SnapshotId,
    pub size_bytes: u32,
    pub sha256: String,
    pub body: SnapshotBody,
}

/// The record a shape stands for: a drawn system is an access request, a workflow step a scope
/// item, a person a stakeholder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    Stakeholder(StakeholderId),
    ScopeItem(ScopeItemId),
    AccessRequest(AccessRequestId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeLink {
    pub shape: ShapeId,
    pub target: LinkTarget,
    pub linked_by: UserId,
    pub linked_at: OffsetDateTime,
}

const META: &str = "version, snapshot_id, size_bytes, sha256, saved_by, saved_at";
const LINK: &str = "shape_id, stakeholder_id, scope_item_id, access_request_id, linked_by, linked_at";

/// Most versions listed at once, newest first.
// ponytail: every save is kept and only the newest are listed; pruning waits for a retention rule.
pub const MAX_VERSIONS_LISTED: i64 = 100;

impl PlanTx {
    /// The newest snapshot, if the canvas was ever saved.
    pub async fn canvas(&mut self) -> Result<Option<Snapshot>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {META}, content, blob_key from canvas_versions where {AT} order by version desc limit 1"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(self.conn())
        .await?
        .map(snapshot)
        .transpose()
    }

    pub async fn canvas_version(&mut self, version: u32) -> Result<Option<Snapshot>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {META}, content, blob_key from canvas_versions where {AT} and version = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(i64::from(version))
        .fetch_optional(self.conn())
        .await?
        .map(snapshot)
        .transpose()
    }

    /// The newest versions, without their content.
    pub async fn canvas_versions(&mut self) -> Result<Vec<SnapshotMeta>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {META} from canvas_versions where {AT} order by version desc limit {MAX_VERSIONS_LISTED}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(self.conn())
        .await?
        .into_iter()
        .map(|r| meta(&r))
        .collect()
    }

    /// The newest version's number; 0 for a canvas never saved.
    pub async fn canvas_head(&mut self) -> Result<u32, StoreError> {
        let (t, c, p) = self.keys();
        let head: i32 = sqlx::query_scalar(&format!(
            "select coalesce(max(version), 0) from canvas_versions where {AT}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_one(self.conn())
        .await?;
        u32::try_from(head).map_err(|_| StoreError::Corrupt("canvas version"))
    }

    /// Saves the next version on top of `base`, which must be the newest (0 for the first save).
    /// `None` if the company or project does not exist; `Conflict` if another save came first.
    pub async fn save_canvas(
        &mut self,
        base: u32,
        v: &SnapshotIn,
        by: &Actor,
    ) -> Result<Option<SnapshotMeta>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        let next = base.checked_add(1).ok_or(StoreError::Conflict)?;
        let (content, blob_key) = match &v.body {
            SnapshotBody::Inline(b) => (Some(b.as_slice()), None),
            SnapshotBody::Blob(k) => (None, Some(k.as_str())),
        };
        let (t, c, p) = self.keys();
        // A concurrent save of the same version loses on the unique key.
        let row = sqlx::query(&format!(
            "insert into canvas_versions (tenant_id, company_id, project_id, version, snapshot_id, size_bytes, sha256,
                 content, blob_key, saved_by)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
             where (select coalesce(max(version), 0) from canvas_versions where {AT}) = $4 - 1
             returning {META}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(i64::from(next))
        .bind(v.id.as_str())
        .bind(i64::from(v.size_bytes))
        .bind(&v.sha256)
        .bind(content)
        .bind(blob_key)
        .bind(by.user.as_str())
        .fetch_optional(self.conn())
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let Some(row) = row else {
            return Err(StoreError::Conflict);
        };
        self.audit(by, "canvas.saved", v.id.as_str()).await?;
        meta(&row).map(Some)
    }

    /// Every shape link on the canvas, by shape.
    pub async fn canvas_links(&mut self) -> Result<Vec<ShapeLink>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!("select {LINK} from canvas_links where {AT} order by shape_id"))
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .fetch_all(self.conn())
            .await?
            .into_iter()
            .map(link)
            .collect()
    }

    /// Links the shape to `target`, replacing any link it had. The target must be in this company
    /// and, on a project's canvas, a scope item or access request must be in this project. `None`
    /// if the company or project does not exist.
    pub async fn link_shape(
        &mut self,
        shape: &ShapeId,
        target: &LinkTarget,
        by: &Actor,
    ) -> Result<Option<ShapeLink>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        let (t, c, p) = self.keys();
        let (column, check) = match target {
            LinkTarget::Stakeholder(_) => (
                "stakeholder_id",
                "select 1 from stakeholders where tenant_id = $1 and company_id = $2 and stakeholder_id = $5",
            ),
            LinkTarget::ScopeItem(_) => (
                "scope_item_id",
                "select 1 from scope_items where tenant_id = $1 and company_id = $2 and item_id = $5
                     and ($3::text is null or project_id = $3)",
            ),
            LinkTarget::AccessRequest(_) => (
                "access_request_id",
                "select 1 from access_requests where tenant_id = $1 and company_id = $2 and access_request_id = $5
                     and ($3::text is null or project_id = $3)",
            ),
        };
        let target_id = match target {
            LinkTarget::Stakeholder(id) => id.as_str(),
            LinkTarget::ScopeItem(id) => id.as_str(),
            LinkTarget::AccessRequest(id) => id.as_str(),
        };
        sqlx::query(&format!("delete from canvas_links where {AT} and shape_id = $4"))
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(shape.as_str())
            .execute(self.conn())
            .await?;
        let row = sqlx::query(&format!(
            "insert into canvas_links (tenant_id, company_id, project_id, shape_id, {column}, linked_by)
             select $1, $2, $3, $4, $5, $6 where exists ({check})
             returning {LINK}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(shape.as_str())
        .bind(target_id)
        .bind(by.user.as_str())
        .fetch_optional(self.conn())
        .await
        .map_err(|e| {
            // Two links to one shape at once: the later one loses.
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let Some(row) = row else {
            return Err(StoreError::Missing("target"));
        };
        self.audit(by, "canvas.linked", shape.as_str()).await?;
        link(row).map(Some)
    }

    pub async fn unlink_shape(&mut self, shape: &ShapeId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(&format!("delete from canvas_links where {AT} and shape_id = $4"))
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(shape.as_str())
            .execute(self.conn())
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        self.audit(by, "canvas.unlinked", shape.as_str()).await?;
        Ok(true)
    }
}

fn meta(r: &PgRow) -> Result<SnapshotMeta, StoreError> {
    let version: i32 = r.try_get("version")?;
    let size: i32 = r.try_get("size_bytes")?;
    Ok(SnapshotMeta {
        version: u32::try_from(version).map_err(|_| StoreError::Corrupt("canvas version"))?,
        id: id("snapshot id", SnapshotId::new, r.try_get("snapshot_id")?)?,
        size_bytes: u32::try_from(size).map_err(|_| StoreError::Corrupt("canvas size"))?,
        sha256: r.try_get("sha256")?,
        saved_by: id("saved_by", UserId::new, r.try_get("saved_by")?)?,
        saved_at: r.try_get("saved_at")?,
    })
}

fn snapshot(r: PgRow) -> Result<Snapshot, StoreError> {
    let content: Option<Vec<u8>> = r.try_get("content")?;
    let blob_key: Option<String> = r.try_get("blob_key")?;
    let body = match (content, blob_key) {
        (Some(b), None) => SnapshotBody::Inline(b),
        (None, Some(k)) => SnapshotBody::Blob(k),
        _ => return Err(StoreError::Corrupt("canvas body")),
    };
    Ok(Snapshot { meta: meta(&r)?, body })
}

fn link(r: PgRow) -> Result<ShapeLink, StoreError> {
    let stakeholder: Option<String> = r.try_get("stakeholder_id")?;
    let item: Option<String> = r.try_get("scope_item_id")?;
    let access: Option<String> = r.try_get("access_request_id")?;
    let target = match (stakeholder, item, access) {
        (Some(s), None, None) => LinkTarget::Stakeholder(id("stakeholder id", StakeholderId::new, s)?),
        (None, Some(i), None) => LinkTarget::ScopeItem(id("scope item id", ScopeItemId::new, i)?),
        (None, None, Some(a)) => LinkTarget::AccessRequest(id("access request id", AccessRequestId::new, a)?),
        _ => return Err(StoreError::Corrupt("shape link")),
    };
    Ok(ShapeLink {
        shape: id("shape id", ShapeId::new, r.try_get("shape_id")?)?,
        target,
        linked_by: id("linked_by", UserId::new, r.try_get("linked_by")?)?,
        linked_at: r.try_get("linked_at")?,
    })
}
