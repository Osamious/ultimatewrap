//! Windows Credential Manager reads.
//!
//! Ported from Maestro's `harness/src/backend/credential.rs`. Only the
//! Credential Manager arm is carried over - UW has no backend-entry config
//! with inline keys or `api_key_env` names, so `from_env` had nothing to
//! resolve here.
//!
//! The secret lives encrypted at rest (DPAPI, tied to the Windows login)
//! instead of in a plaintext env var or a checked-in config file. It is a
//! no-op on platforms without Windows Credential Manager, where the resolver
//! simply reports nothing and the caller falls through to its normal
//! "no credential" path.
//!
//! Adaptation note: Maestro's original uses the `windows-sys` crate (raw
//! `extern` bindings, `CredReadW` returning `BOOL`). UW uses the `windows`
//! crate per the plan, whose `CredReadW` takes a `PCWSTR` plus an
//! `Option<u32>` flags argument and returns `windows::core::Result<()>`. The
//! semantics, the SAFETY reasoning and the UTF-16 blob decoding are unchanged.

/// Read a stored Windows Credential Manager generic credential by its target
/// name (e.g. `LLMKEY:personal.groq.free`).
///
/// Returns `None` when the entry is absent, the call fails, or on non-Windows
/// platforms where there is no Credential Manager to read. The secret is
/// passed back as the raw UTF-16 blob decoded to a Rust `String`.
#[cfg(windows)]
pub fn from_credential_manager(target: &str) -> Option<String> {
    use windows::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };
    use windows::core::PCWSTR;

    let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();
    let target_wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `pcred` is a valid out-param for CredReadW; on success the
    // function allocates a CREDENTIALW buffer that the caller owns and must
    // release with CredFree. The target string is a NUL-terminated wide
    // buffer we keep alive for the duration of the call.
    let ok = unsafe {
        CredReadW(
            PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut pcred,
        )
    };
    if ok.is_err() {
        // Absent vs failed: both mean "no secret here", so return None and let
        // the caller fall back to its normal no-credential handling.
        return None;
    }

    // SAFETY: CredReadW returned OK, so `pcred` now points at a valid,
    // owned CREDENTIALW whose CredentialBlob is a directly-referenced buffer
    // (not separately allocated - freeing the credential frees the blob too).
    let credential = unsafe { &*pcred };
    let value = if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
        None
    } else {
        // Credential blobs are UTF-16 words, counted in bytes.
        let byte_len = credential.CredentialBlobSize as usize;
        // SAFETY: blob is valid for CredentialBlobSize bytes; it holds UTF-16
        // code units, so `byte_len / 2` u16 slots.
        let u16_slice = unsafe {
            std::slice::from_raw_parts(credential.CredentialBlob.cast::<u16>(), byte_len / 2)
        };
        // Trim a trailing NUL if present (some stores pad with one).
        let u16_slice = match u16_slice.last() {
            Some(&0) => &u16_slice[..u16_slice.len() - 1],
            _ => u16_slice,
        };
        let v = String::from_utf16_lossy(u16_slice);
        (!v.trim().is_empty()).then_some(v)
    };

    // SAFETY: free the CREDENTIALW buffer CredReadW allocated (this also
    // releases its blob, which is owned by the credential structure).
    unsafe { CredFree(pcred.cast()) };

    value
}

/// Non-Windows stub: there is no Credential Manager, so nothing is ever found.
#[cfg(not(windows))]
pub fn from_credential_manager(_target: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::from_credential_manager;

    /// An absent target must be `None`, not a panic or a hang - the only
    /// behaviour that can be asserted without provisioning a real credential.
    #[test]
    fn absent_target_reads_as_none() {
        assert!(from_credential_manager("UW:definitely.not.a.real.target").is_none());
    }
}
