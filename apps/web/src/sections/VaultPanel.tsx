import { useCallback, useEffect, useRef, useState } from "react";
import { isRollbackRejection } from "@alarmed/portable-sync";

import { Icon } from "../ui/Icon";
import {
  changeDevicePassphrase,
  clearDeviceVault,
  createDeviceVault,
  isVaultConfigured,
  showRecoveryCode,
} from "../crypto/keystore";
import {
  exportToDownload,
  importFromFile,
  joinVaultFromFile,
  recoverVaultFromFile,
} from "../sync/portableFile";

/**
 * Encrypted snapshot export/import (build plan §8, Phase 3) — the web
 * counterpart to `apps/mobile/src/sections/VaultPanel.tsx`, same states and
 * same wording, download/upload instead of a share sheet.
 */

type Busy =
  | "none"
  | "creating"
  | "exporting"
  | "importing"
  | "joining"
  | "recovering"
  | "revealing"
  | "rotating";

type Sheet = "none" | "recovery" | "rotate" | "restore";

export function VaultPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<Busy>("none");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Held apart from `error` deliberately: a rollback rejection is a security
   * event (§4.3), and it must not be able to read as one more failed upload.
   */
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);

  const mergeInput = useRef<HTMLInputElement>(null);
  const joinInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  /** Which secondary flow is open. Only ever one, so the panel stays readable. */
  const [sheet, setSheet] = useState<Sheet>("none");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [newPassphrase, setNewPassphrase] = useState("");
  /**
   * Creating a vault is gated on this (plan §7). A checkbox is a low bar, but
   * it is the difference between "nobody told me" and "I was told and clicked
   * anyway" — and there is genuinely no recovery to offer afterwards.
   */
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isVaultConfigured()
      .then((ok) => {
        if (!cancelled) setConfigured(ok);
      })
      .catch(() => {
        // Private-mode browsers can refuse IndexedDB outright. Treat that as
        // "no vault" so the panel explains itself rather than hanging on a spinner.
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (kind: Exclude<Busy, "none">, action: () => Promise<string | null>) => {
      setBusy(kind);
      setStatus(null);
      setError(null);
      try {
        const message = await action();
        if (message !== null) setStatus(message);
      } catch (err) {
        if (isRollbackRejection(err)) {
          setSecurityAlert(err.message);
        } else {
          setError(err instanceof Error ? err.message : "Something went wrong");
        }
      } finally {
        setBusy("none");
      }
    },
    []
  );

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const onCreate = () =>
    run("creating", async () => {
      await createDeviceVault(passphrase);
      setPassphrase("");
      setConfigured(true);
      return "Vault created. Export a snapshot to set up your other device.";
    });

  const onExport = () =>
    run("exporting", async () => {
      const result = await exportToDownload();
      return `Sealed ${plural(result.taskCount, "task")} at sequence ${result.seq} — saved as ${result.filename}.`;
    });

  const onMerge = (file: File) =>
    run("importing", async () => {
      const result = await importFromFile(file);
      const ahead =
        result.localAhead > 0
          ? ` ${plural(result.localAhead, "task")} here ${result.localAhead === 1 ? "is" : "are"} newer — export to send ${result.localAhead === 1 ? "it" : "them"} back.`
          : "";
      return `Merged ${plural(result.applied, "task")}.${ahead}`;
    });

  const onJoin = (file: File) =>
    run("joining", async () => {
      const result = await joinVaultFromFile(passphrase, file);
      setPassphrase("");
      setConfigured(true);
      return `Joined the vault and merged ${plural(result.applied, "task")}.`;
    });

  const onReveal = () =>
    run("revealing", async () => {
      setRecoveryCode(await showRecoveryCode(passphrase));
      setPassphrase("");
      return null;
    });

  const onRotate = () =>
    run("rotating", async () => {
      await changeDevicePassphrase(passphrase, newPassphrase);
      setPassphrase("");
      setNewPassphrase("");
      setSheet("none");
      return "Passphrase changed. Export a fresh snapshot so your other devices get the new one — older files still need the old passphrase.";
    });

  const onRestore = (file: File) =>
    run("recovering", async () => {
      const result = await recoverVaultFromFile(passphrase, file);
      setPassphrase("");
      setSheet("none");
      setConfigured(true);
      return `Recovered the vault and merged ${plural(result.applied, "task")}.`;
    });

  const onForget = () =>
    run("creating", async () => {
      await clearDeviceVault();
      setConfigured(false);
      setSheet("none");
      setRecoveryCode(null);
      return "Vault forgotten in this browser. Your tasks are untouched.";
    });

  const closeSheet = () => {
    setSheet("none");
    setRecoveryCode(null);
    setPassphrase("");
    setNewPassphrase("");
  };

  /**
   * Opens the sheet in its own window to print. A dedicated document rather
   * than a print stylesheet, because what should end up on paper is the code
   * and the instructions for using it — not a screenshot of the settings panel.
   */
  const printSheet = (code: string) => {
    const win = window.open("", "_blank", "width=640,height=800");
    if (!win) return;
    win.document.write(`<!doctype html><html><head><title>badgr.me recovery sheet</title>
<style>
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 48px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 28px; }
  .code { font: 700 17px/2 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 1px; word-spacing: 4px; padding: 20px 22px;
          border: 2px solid #111; border-radius: 8px; margin-bottom: 26px;
          word-break: break-all; }
  li { margin-bottom: 7px; }
  .warn { margin-top: 26px; padding: 14px 16px; border-left: 4px solid #b23a31;
          background: #faeceb; }
</style></head><body>
<h1>badgr.me recovery sheet</h1>
<p class="sub">Generated ${new Date().toLocaleDateString()}</p>
<div class="code">${code}</div>
<p><strong>What this is.</strong> The key to your encrypted badgr.me snapshots. It works
even if you forget your passphrase, and it keeps working after you change it.</p>
<ol>
  <li>Store this on paper, somewhere you keep important documents.</li>
  <li>Anyone holding both this sheet and one of your snapshot files can read your tasks.</li>
  <li>To use it: open badgr.me, choose <em>Recover with sheet</em>, type this code, and pick any snapshot file.</li>
  <li>Letter case does not matter, and the dashes are only there to help you read it.</li>
</ol>
<p class="warn"><strong>Without this sheet and without your passphrase, your snapshots
cannot be recovered by anyone — including us.</strong> That is the design, not a limitation.</p>
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
  };

  const working = busy !== "none";

  return (
    <div className="vault-panel">
      {securityAlert !== null && (
        <div className="vault-alert" role="alert">
          <p className="vault-alert-head">
            <Icon name="warning" size={16} />
            Rolled-back data refused
          </p>
          <p className="vault-alert-body">{securityAlert}</p>
          <button type="button" className="vault-alert-btn" onClick={() => setSecurityAlert(null)}>
            I understand
          </button>
        </div>
      )}

      {configured === null ? (
        <p className="setting-desc">Checking this browser for a vault…</p>
      ) : configured ? (
        <>
          <p className="setting-desc">
            Snapshots are encrypted before they leave the page, and this browser holds the
            key in a form scripts can use but never read out.
          </p>
          <div className="vault-row">
            <button
              type="button"
              className="vault-btn accent"
              disabled={working}
              onClick={onExport}
            >
              <Icon name="share" size={15} />
              {busy === "exporting" ? "Sealing…" : "Export"}
            </button>
            <button
              type="button"
              className="vault-btn"
              disabled={working}
              onClick={() => mergeInput.current?.click()}
            >
              <Icon name="inbox" size={15} />
              {busy === "importing" ? "Merging…" : "Import"}
            </button>
          </div>
          <input
            ref={mergeInput}
            type="file"
            accept=".badgr,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset first, or picking the same file twice fires no change event.
              event.target.value = "";
              if (file) void onMerge(file);
            }}
          />
          <div className="vault-row">
            <button
              type="button"
              className="vault-btn"
              disabled={working}
              onClick={() => { setSheet(sheet === "recovery" ? "none" : "recovery"); setRecoveryCode(null); }}
            >
              <Icon name="lock" size={15} />
              Recovery sheet
            </button>
            <button
              type="button"
              className="vault-btn"
              disabled={working}
              onClick={() => setSheet(sheet === "rotate" ? "none" : "rotate")}
            >
              <Icon name="repeat" size={15} />
              Change passphrase
            </button>
          </div>

          {sheet === "recovery" && (
            <div className="vault-sub">
              {recoveryCode === null ? (
                <>
                  <p className="setting-desc">
                    Your recovery sheet is the only way back in if you forget your
                    passphrase. Seeing it costs an unlock, so a device left open on a
                    desk can't give it away.
                  </p>
                  <input
                    className="vault-input"
                    type="password"
                    value={passphrase}
                    placeholder="Current passphrase"
                    autoComplete="current-password"
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                  <div className="vault-row">
                    <button
                      type="button"
                      className="vault-btn accent"
                      disabled={working || passphrase.length === 0}
                      onClick={onReveal}
                    >
                      {busy === "revealing" ? "Unlocking…" : "Show my code"}
                    </button>
                    <button type="button" className="vault-btn" onClick={closeSheet}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="recovery-code">{recoveryCode}</p>
                  <p className="setting-desc">
                    Write this down and keep it with your important papers. It stays valid
                    even after you change your passphrase. Anyone holding both this and one
                    of your snapshot files can read your tasks.
                  </p>
                  <div className="vault-row">
                    <button
                      type="button"
                      className="vault-btn accent"
                      onClick={() => printSheet(recoveryCode)}
                    >
                      Print sheet
                    </button>
                    <button
                      type="button"
                      className="vault-btn"
                      onClick={() => void navigator.clipboard?.writeText(recoveryCode)}
                    >
                      Copy
                    </button>
                    <button type="button" className="vault-btn" onClick={closeSheet}>
                      Done
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {sheet === "rotate" && (
            <div className="vault-sub">
              <p className="setting-desc">
                Changing your passphrase re-wraps the key — your tasks aren't
                re-encrypted and your recovery sheet stays valid.
              </p>
              <input
                className="vault-input"
                type="password"
                value={passphrase}
                placeholder="Current passphrase"
                autoComplete="current-password"
                onChange={(event) => setPassphrase(event.target.value)}
              />
              <input
                className="vault-input"
                type="password"
                value={newPassphrase}
                placeholder="New passphrase"
                autoComplete="new-password"
                onChange={(event) => setNewPassphrase(event.target.value)}
              />
              <div className="vault-row">
                <button
                  type="button"
                  className="vault-btn accent"
                  disabled={working || passphrase.length === 0 || newPassphrase.length === 0}
                  onClick={onRotate}
                >
                  {busy === "rotating" ? "Re-wrapping…" : "Change it"}
                </button>
                <button type="button" className="vault-btn" onClick={closeSheet}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button type="button" className="vault-forget" disabled={working} onClick={onForget}>
            Forget vault in this browser
          </button>
        </>
      ) : (
        <>
          <p className="setting-desc">
            Pick a passphrase to encrypt your snapshots. It never leaves this device and
            cannot be reset — <strong>if you forget it, the snapshots are gone for good.</strong>
          </p>
          <input
            className="vault-input"
            type="password"
            value={passphrase}
            placeholder="Vault passphrase"
            autoComplete="new-password"
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <label className="vault-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand that if I forget this passphrase and lose my recovery sheet,
              my snapshots cannot be recovered by anyone.
            </span>
          </label>
          <div className="vault-row">
            <button
              type="button"
              className="vault-btn accent"
              disabled={working || passphrase.length === 0 || !acknowledged}
              onClick={onCreate}
            >
              <Icon name="lock" size={15} />
              {busy === "creating" ? "Deriving…" : "Create vault"}
            </button>
            <button
              type="button"
              className="vault-btn"
              disabled={working || passphrase.length === 0}
              onClick={() => joinInput.current?.click()}
            >
              <Icon name="inbox" size={15} />
              {busy === "joining" ? "Unlocking…" : "Join existing"}
            </button>
          </div>
          <input
            ref={joinInput}
            type="file"
            accept=".badgr,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onJoin(file);
            }}
          />
          <p className="vault-hint">
            Creating a vault takes a second or two — that slowness is the point, it's what
            makes guessing the passphrase expensive.
          </p>

          <button
            type="button"
            className="vault-forget recover-link"
            disabled={working}
            onClick={() => setSheet(sheet === "restore" ? "none" : "restore")}
          >
            Forgotten your passphrase? Recover with your sheet
          </button>

          {sheet === "restore" && (
            <div className="vault-sub">
              <p className="setting-desc">
                Type the code from your recovery sheet, then pick any snapshot file from
                the vault. Case and dashes don't matter.
              </p>
              <input
                className="vault-input code-input"
                type="text"
                value={passphrase}
                placeholder="XXXX-XXXX-XXXX-…"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setPassphrase(event.target.value)}
              />
              <div className="vault-row">
                <button
                  type="button"
                  className="vault-btn accent"
                  disabled={working || passphrase.length === 0}
                  onClick={() => restoreInput.current?.click()}
                >
                  <Icon name="inbox" size={15} />
                  {busy === "recovering" ? "Recovering…" : "Pick a snapshot"}
                </button>
                <button type="button" className="vault-btn" onClick={closeSheet}>
                  Cancel
                </button>
              </div>
              <input
                ref={restoreInput}
                type="file"
                accept=".badgr,text/plain"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void onRestore(file);
                }}
              />
            </div>
          )}
        </>
      )}

      {status !== null && <p className="vault-status">{status}</p>}
      {error !== null && <p className="vault-error">{error}</p>}
    </div>
  );
}
