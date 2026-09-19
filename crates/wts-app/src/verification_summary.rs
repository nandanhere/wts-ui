use super::*;
use crate::WorkspaceVerificationSummary;

impl LocalWtsService {
    /// Reads saved verification results without Git reconciliation or agent evidence.
    pub fn get_workspace_verification_summary(
        &self,
        workspace_id: Uuid,
    ) -> Result<Option<WorkspaceVerificationSummary>, LocalWtsError> {
        let (workspace_path, materialization) =
            match self.read_materialization_receipt(workspace_id) {
                Ok(receipt) => receipt,
                Err(LocalWtsError::NotMaterialized) => return Ok(None),
                Err(error) => return Err(error),
            };
        let view = self
            .inner
            .registry
            .get(workspace_id)?
            .ok_or(LocalWtsError::WorkspaceNotFound)?;
        let (context, summary) = EvidenceStore::read_verification_summary(&workspace_path)
            .map_err(map_evidence_failure)?;
        let allowed_ids = validate_workspace_evidence_context(&view, &materialization, &context)?;
        validate_verification_evidence(
            &materialization,
            &summary.verification_plan,
            &summary.verification_result,
            &allowed_ids,
        )?;
        for result in &summary.verification_history {
            validate_verification_evidence(
                &materialization,
                &summary.verification_plan,
                result,
                &allowed_ids,
            )?;
        }
        Ok(Some(summary))
    }
}
