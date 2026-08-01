import { useCallback, useEffect, useRef, useState } from "react";
import { isRollbackRejection } from "@alarmed/portable-sync";

import { Icon } from "../ui/Icon";
import {
  clearDeviceVault,
  createDeviceVault,
  isVaultConfigured,
} from "../crypto/keystore";
import { exportToDownload, importFromFile, joinVaultFromFile } from "../sync/portableFile";

/**
 * Encrypted snapshot export/import (build plan §8, Phase 3) — the web
 * counterpart to `apps/mobile/src/sections/VaultPanel.tsx`, same states and
 * same wording, download/upload instead of a share sheet.
 */

type Busy = "none" | "creating" | "exporting" | "importing" | "joining";

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

  const onForget = () =>
    run("creating", async () => {
      await clearDeviceVault();
      setConfigured(false);
      return "Vault forgotten in this browser. Your tasks are untouched.";
    });

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
          <div className="vault-row">
            <button
              type="button"
              className="vault-btn accent"
              disabled={working || passphrase.length === 0}
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
        </>
      )}

      {status !== null && <p className="vault-status">{status}</p>}
      {error !== null && <p className="vault-error">{error}</p>}
    </div>
  );
}
